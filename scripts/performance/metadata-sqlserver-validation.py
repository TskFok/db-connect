#!/usr/bin/env python3
"""用本地官方 SQL Server 2022 镜像验收生产批量目录入口，不读取业务配置。

仅创建随机专属标签容器和 loopback 端口，不挂宿主目录，不在循环中查询 SQL。
就绪检测仅使用日志/TCP/容器状态；显式验收由 ignored Rust 测试执行。
当前 ARM Docker 的 amd64 模拟不是微软支持环境，不报告性能提升或生产兼容性。
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import socket
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
IMAGE = "mcr.microsoft.com/mssql/server:2022-latest"
SUPPORT_URL = "https://learn.microsoft.com/en-us/sql/linux/containers/deploy?view=sql-server-ver17"


def run(command, *, env=None, input_text=None, timeout=60):
    result = subprocess.run(command, cwd=ROOT, env=env, input=input_text,
                            capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        # 只保存定位阶段、SQL Server 消息编号与 Rust 断言标签；不打印原始错误/SQL/凭据。
        output = result.stdout + "\n" + result.stderr
        safe = [line.strip() for line in output.splitlines() if
                line.startswith("error[E") or line.startswith("assertion ") or
                (" panicked at " in line and line.startswith("thread ")) or
                "SQLSERVER_CONNECTION_DIAGNOSTIC " in line or
                line.startswith("SQL Server 隔离验收失败：") or
                re.fullmatch(r"Msg \d+, Level \d+, State \d+, Server [^,]+, Line \d+", line)]
        if safe:
            print("\n".join(safe), flush=True)
        error = RuntimeError("隔离命令失败：" + command[0])
        error.exit_code = result.returncode
        error.sqlserver_message_numbers = re.findall(r"(?m)^Msg (\d+), Level ", output)
        error.safe_diagnostics = [json.loads(line.split("SQLSERVER_CONNECTION_DIAGNOSTIC ", 1)[1])
                                  for line in output.splitlines() if "SQLSERVER_CONNECTION_DIAGNOSTIC " in line]
        raise error
    return result.stdout.strip()


def preflight():
    image = json.loads(run(["docker", "image", "inspect", IMAGE], timeout=30))[0]
    host = json.loads(run(["docker", "info", "--format", "{{json .}}"], timeout=30))
    if image["Architecture"] != "amd64" or image["Os"] != "linux":
        raise RuntimeError("隔离镜像必须为 linux/amd64")
    return {"image": IMAGE, "image_id": image["Id"],
            "image_repo_digests": image.get("RepoDigests", []),
            "image_architecture": image["Architecture"],
            "docker_host": {key: host.get(key) for key in
                            ("OSType", "Architecture", "NCPU", "MemTotal", "KernelVersion")},
            "supported_configuration": host.get("Architecture") in ("amd64", "x86_64"),
            "support_reference": SUPPORT_URL, "pull_attempted": False}


def wait_ready(container, port):
    deadline = time.monotonic() + 120
    while True:
        state = json.loads(run(["docker", "inspect", container, "--format", "{{json .State}}"], timeout=15))
        logs = run(["docker", "logs", container], timeout=15)
        if not state["Running"]:
            raise RuntimeError("隔离服务启动后退出")
        if "SQL Server is now ready for client connections" in logs:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    return
            except OSError:
                pass
        if time.monotonic() >= deadline:
            raise TimeoutError("隔离服务未在启动预算内就绪")
        time.sleep(0.5)


def cleanup_owned(container):
    inspected = subprocess.run(
        ["docker", "inspect", container, "--format", '{{ index .Config.Labels "db-connect.metadata.fixture" }}'],
        cwd=ROOT, capture_output=True, text=True, timeout=30, check=False)
    if inspected.returncode:
        absent = " ".join(inspected.stderr.casefold().split())
        if "no such object" in absent or "no such container" in absent:
            return "not_created_or_already_removed"
        raise RuntimeError("清理前无法核对专属容器")
    if inspected.stdout.strip() != container:
        raise RuntimeError("专属标签不匹配，拒绝删除")
    run(["docker", "rm", "--force", "--volumes", container], timeout=60)
    return "removed"


def counter_ddl(user, *, catalog):
    # 这里只组装内存字符串；调用方将全部 DDL 一次传入专属 sqlcmd。
    suffix = "catalog" if catalog else "total"
    rpc_filter = ""
    batch_filter = ""
    if catalog:
        rpc_filter = " AND sqlserver.like_i_sql_unicode_string([statement], N'%WITH requested AS%')"
        batch_filter = " AND sqlserver.like_i_sql_unicode_string([batch_text], N'%WITH requested AS%')"
    return f"""CREATE EVENT SESSION [{user}_{suffix}] ON SERVER
ADD EVENT sqlserver.rpc_starting(WHERE (sqlserver.username=N'{user}'{rpc_filter})),
ADD EVENT sqlserver.sql_batch_starting(WHERE (sqlserver.username=N'{user}'{batch_filter}))
ADD TARGET package0.event_counter WITH (MAX_MEMORY=1024 KB);
ALTER EVENT SESSION [{user}_{suffix}] ON SERVER STATE=START;
GO
"""


def fixture_ddl(marker, passwords):
    ddl = """CREATE DATABASE metadata_fixture COLLATE Latin1_General_100_BIN2;
GO
USE metadata_fixture;
CREATE TABLE dbo.fixture_marker (id int PRIMARY KEY, token nvarchar(32) NOT NULL);
INSERT INTO dbo.fixture_marker VALUES (1, '__MARKER__');
GO
CREATE SCHEMA metadata_a;
GO
CREATE SCHEMA metadata_b;
GO
CREATE SCHEMA metadata_empty;
GO
CREATE SCHEMA [metadata'quote"|]]];
GO
CREATE TABLE metadata_a.same (id bigint PRIMARY KEY, value nvarchar(50));
INSERT INTO metadata_a.same VALUES (1,N'fixture');
CREATE TABLE metadata_b.same (id int);
CREATE TABLE [metadata'quote"|]]].same (id int);
EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'schema a', @level0type=N'SCHEMA', @level0name=N'metadata_a', @level1type=N'TABLE', @level1name=N'same';
EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'schema b', @level0type=N'SCHEMA', @level0name=N'metadata_b', @level1type=N'TABLE', @level1name=N'same';
EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'special schema', @level0type=N'SCHEMA', @level0name=N'metadata''quote"|]', @level1type=N'TABLE', @level1name=N'same';
GO
CREATE VIEW metadata_a.item_view AS SELECT id FROM metadata_a.same;
GO
USE master;
CREATE LOGIN metadata_owner WITH PASSWORD='__OWNER_PASSWORD__', CHECK_POLICY=OFF;
CREATE LOGIN metadata_reader WITH PASSWORD='__READER_PASSWORD__', CHECK_POLICY=OFF;
CREATE LOGIN metadata_denied WITH PASSWORD='__DENIED_PASSWORD__', CHECK_POLICY=OFF;
GO
USE metadata_fixture;
CREATE USER metadata_owner FOR LOGIN metadata_owner;
ALTER ROLE db_owner ADD MEMBER metadata_owner;
CREATE USER metadata_reader FOR LOGIN metadata_reader;
GRANT VIEW DATABASE PERFORMANCE STATE TO metadata_reader;
GRANT VIEW SECURITY DEFINITION TO metadata_reader;
GRANT SELECT ON OBJECT::metadata_a.same TO metadata_reader;
CREATE USER metadata_denied FOR LOGIN metadata_denied;
GRANT SELECT ON OBJECT::metadata_a.same TO metadata_denied;
GO
"""
    ddl = ddl.replace("__MARKER__", marker).replace("__OWNER_PASSWORD__", passwords["owner_password"])
    ddl = ddl.replace("__READER_PASSWORD__", passwords["reader_password"]).replace("__DENIED_PASSWORD__", passwords["denied_password"])
    return (ddl + counter_ddl("metadata_owner", catalog=False) +
            counter_ddl("metadata_owner", catalog=True) +
            counter_ddl("metadata_reader", catalog=False) +
            counter_ddl("metadata_reader", catalog=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preflight", action="store_true", help="只读检查本地镜像和架构")
    parser.add_argument("--ssl-mode", choices=("required_insecure", "disabled"), default="required_insecure",
                        help="仅控制本次随机 loopback 夹具使用的生产连接模式")
    parser.add_argument("--short-lived-certificate", action="store_true",
                        help="首启前仅在专属容器内生成并配置7天localhost自签证书")
    parser.add_argument("--output", type=Path, help="最终脱敏证据路径，拒绝覆盖")
    args = parser.parse_args()
    if args.output and args.output.exists():
        raise FileExistsError("证据路径已存在，拒绝覆盖")
    marker = uuid.uuid4().hex
    container = "db-connect-metadata-sqlserver-" + marker
    fixture = Path("/private/tmp") / container
    evidence = {"started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "kind": "correctness-and-server-count-only", "status": "failed",
                "measurement_run": False, "fixture_marker": marker,
                "build_mode": "cargo test debug", "sdkroot": os.environ.get("SDKROOT"),
                "fixture_ssl_mode": args.ssl_mode,
                "short_lived_certificate": {"enabled": args.short_lived_certificate, "validity_days": 7,
                                            "key": "RSA-2048-container-only", "private_key_mode": "0600",
                                            "server_auth": True, "san": ["localhost", "127.0.0.1"]},
                "host_platform": platform.platform(), "container_and_volumes_removed": False}
    stage = "preflight"
    creation_attempted = False
    failure = None
    config_path = fixture / "fixture.json"
    try:
        evidence.update(preflight())
        if args.preflight:
            print(json.dumps(dict(evidence, status="ready"), ensure_ascii=False), flush=True)
            return
        fixture.mkdir(mode=0o700)
        passwords = {name: "Aa!9" + uuid.uuid4().hex for name in
                     ("password", "owner_password", "reader_password", "denied_password")}
        stage = "create"
        creation_attempted = True
        create_command = ["docker", "create", "--pull=never", "--platform", "linux/amd64", "--name", container,
             "--label", "db-connect.metadata.fixture=" + container,
             "--publish", "127.0.0.1::1433", "--memory", "2560m", "--cpus", "2",
             "--env", "ACCEPT_EULA=Y", "--env", "MSSQL_PID=Developer",
             "--env", "MSSQL_MEMORY_LIMIT_MB=2048", "--env", "MSSQL_SA_PASSWORD"]
        if args.short_lived_certificate:
            # 固定脚本在首次启动 sqlservr 前运行，不含随机密码，不向宿主写私钥。
            prepare_certificate = """set -eu
command -v openssl >/dev/null
command -v runuser >/dev/null
install -d -m 700 -o mssql -g root /var/opt/mssql/fixture-cert
umask 077
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 7 \\
  -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \\
  -addext 'basicConstraints=critical,CA:FALSE' \\
  -addext 'extendedKeyUsage=serverAuth' \\
  -addext 'keyUsage=critical,digitalSignature,keyEncipherment' \\
  -keyout /var/opt/mssql/fixture-cert/server.key \\
  -out /var/opt/mssql/fixture-cert/server.pem >/dev/null 2>&1
chown mssql:root /var/opt/mssql/fixture-cert/server.key /var/opt/mssql/fixture-cert/server.pem
chmod 600 /var/opt/mssql/fixture-cert/server.key /var/opt/mssql/fixture-cert/server.pem
/opt/mssql/bin/mssql-conf set network.tlscert /var/opt/mssql/fixture-cert/server.pem
/opt/mssql/bin/mssql-conf set network.tlskey /var/opt/mssql/fixture-cert/server.key
exec runuser -u mssql -- /opt/mssql/bin/sqlservr
"""
            create_command.extend(["--user", "0", "--entrypoint", "/bin/bash", IMAGE, "-c", prepare_certificate])
        else:
            create_command.append(IMAGE)
        run(create_command,
            env=dict(os.environ, MSSQL_SA_PASSWORD=passwords["password"]))
        stage = "start"
        run(["docker", "start", container])
        address, port_text = run(["docker", "port", container, "1433/tcp"]).rsplit(":", 1)
        port = int(port_text)
        if address != "127.0.0.1" or not 1024 < port <= 65535 or port == 1433:
            raise RuntimeError("隔离端口校验失败")
        stage = "readiness"
        wait_ready(container, port)
        if args.short_lived_certificate:
            stage = "certificate_metadata"
            public_certificate = run(["docker", "exec", container, "openssl", "x509", "-in",
                                      "/var/opt/mssql/fixture-cert/server.pem", "-noout", "-dates",
                                      "-fingerprint", "-sha256"])
            key_permissions = run(["docker", "exec", container, "stat", "--format", "%a:%U",
                                   "/var/opt/mssql/fixture-cert/server.key"])
            if key_permissions != "600:mssql":
                raise RuntimeError("隔离证书私钥权限不符合要求")
            evidence["short_lived_certificate"]["public_metadata"] = public_certificate.splitlines()
            evidence["short_lived_certificate"]["actual_key_permissions"] = key_permissions
        stage = "fixture_setup"
        run(["docker", "exec", "--interactive", "--env", "SQLCMDPASSWORD", container,
             "/opt/mssql-tools18/bin/sqlcmd", "-S", "localhost", "-U", "sa", "-C", "-b"],
            env=dict(os.environ, SQLCMDPASSWORD=passwords["password"]),
            input_text=fixture_ddl(marker, passwords), timeout=120)
        evidence["database_fixture_initialized"] = True
        stage = "fixture_config"
        with os.fdopen(os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as config_file:
            json.dump(dict(passwords, marker=marker, container=container, port=port,
                           ssl_mode=args.ssl_mode), config_file)
        stage = "cargo_test"
        command = ["cargo", "test", "--offline", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--lib",
                   "db::metadata_sqlserver_tests::metadata_access_isolated_sqlserver2022", "--", "--ignored",
                   "--exact", "--nocapture", "--test-threads=1"]
        evidence["command"] = command
        evidence["validation_attempted"] = True
        output = run(command, env=dict(os.environ, DB_CONNECT_METADATA_SQLSERVER_FIXTURE=str(fixture)), timeout=900)
        evidence["cargo_exit_code"] = 0
        records = [line.split("METADATA_SQLSERVER_VALIDATION ", 1)[1] for line in output.splitlines()
                   if "METADATA_SQLSERVER_VALIDATION " in line]
        if len(records) != 1:
            raise RuntimeError("验收证据数量不符")
        evidence["validation"] = json.loads(records[0])
        evidence["measurement_run"] = True
        evidence["measurement_status"] = "passed"
        evidence["status"] = "passed"
    except BaseException as error:
        failure = error
        evidence["failure"] = {"stage": stage, "type": type(error).__name__}
        if hasattr(error, "exit_code"):
            evidence["failure"]["exit_code"] = error.exit_code
        if hasattr(error, "sqlserver_message_numbers"):
            evidence["failure"]["sqlserver_message_numbers"] = error.sqlserver_message_numbers
        if hasattr(error, "safe_diagnostics"):
            evidence["failure"]["connection_diagnostics"] = error.safe_diagnostics
        if stage == "cargo_test" and hasattr(error, "exit_code"):
            evidence["cargo_exit_code"] = error.exit_code
    finally:
        try:
            if creation_attempted:
                evidence["cleanup_result"] = cleanup_owned(container)
                evidence["container_and_volumes_removed"] = True
        except BaseException as error:
            evidence["cleanup_failure"] = {"stage": "cleanup", "type": type(error).__name__}
            evidence["status"] = "failed"
            if failure is None:
                failure = error
        finally:
            try:
                config_path.unlink(missing_ok=True)
                evidence["credentials_file_removed"] = True
            except BaseException as error:
                evidence["credential_cleanup_failure"] = {"type": type(error).__name__}
                evidence["status"] = "failed"
                if failure is None:
                    failure = error
        if not args.preflight:
            try:
                sources = [Path(__file__).resolve(), ROOT / "scripts/performance/test_metadata_sqlserver_validation.py",
                           ROOT / "src-tauri/src/db/metadata_sqlserver_tests.rs",
                           ROOT / "src-tauri/src/db/sqlserver.rs", ROOT / "src-tauri/src/db/metadata_batch.rs",
                           ROOT / "src-tauri/src/db/sql_utils.rs", ROOT / "src-tauri/src/db/mod.rs",
                           ROOT / "src-tauri/src/models/types.rs", ROOT / "src-tauri/Cargo.toml", ROOT / "src-tauri/Cargo.lock"]
                evidence["source_sha256"] = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}
                evidence["source_head"] = run(["git", "rev-parse", "HEAD"])
            except BaseException as error:
                evidence["source_archive_failure"] = {"type": type(error).__name__}
                evidence["status"] = "failed"
                if failure is None:
                    failure = error
            evidence["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            try:
                serialized = json.dumps(evidence, ensure_ascii=False, indent=2) + "\n"
                if fixture.is_dir():
                    (fixture / "result.json").write_text(serialized)
                if args.output:
                    with args.output.open("x") as output_file:
                        output_file.write(serialized)
                print(serialized, flush=True)
            except BaseException as error:
                # 归档错误不能遮蔽测量/清理主失败；仍输出脱敏阶段摘要。
                evidence["status"] = "failed"
                evidence["archive_failure"] = {"type": type(error).__name__}
                try:
                    if fixture.is_dir():
                        (fixture / "result.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
                except BaseException as local_error:
                    evidence["local_archive_failure"] = {"type": type(local_error).__name__}
                print(json.dumps(evidence, ensure_ascii=False), flush=True)
                if failure is None:
                    failure = error
    if failure is not None:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
