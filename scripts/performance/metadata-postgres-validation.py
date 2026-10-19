#!/usr/bin/env python3
"""用已存在的 postgres:17-alpine 验收生产目录/分页缓存；不拉镜像、不访问业务配置。

只启动一个带随机专属名称的容器，绑定随机 loopback 端口，不挂载主机目录。
夹具 DDL 一次执行；Rust 显式执行对照案例，不在循环内查询 SQL。
测试输出仅保存无 SQL、无密码的结果；结束时只删除本脚本创建的容器及匿名卷。
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
IMAGE = "postgres:17-alpine"


def preflight():
    """只探测指定本地镜像；明确区分镜像缺失和 Docker 无法访问。"""
    try:
        result = subprocess.run(["docker", "image", "inspect", IMAGE, "--format", "{{.Id}}"],
                                cwd=ROOT, capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return {"status": "docker_unavailable", "image": IMAGE,
                "measurement_run": False, "pull_attempted": False}
    if result.returncode:
        status = "image_missing" if "No such image" in result.stderr else "docker_unavailable"
        return {"status": status, "image": IMAGE, "measurement_run": False, "pull_attempted": False}
    return {"status": "ready", "image": IMAGE, "image_id": result.stdout.strip(),
            "measurement_run": False, "pull_attempted": False}


def run(command, *, env=None, input_text=None, timeout=60):
    result = subprocess.run(command, cwd=ROOT, env=env, input=input_text,
                            capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        # 不透传 psql/cargo 原始输出，避免失败包含 SQL 或凭据。
        if command[0] == "cargo":
            diagnostics = (result.stdout + "\n" + result.stderr).splitlines()
            safe_lines = [line for line in diagnostics if
                          "PostgreSQL 隔离验收失败：" in line or
                          line.startswith("assertion ") or
                          line.startswith("error retrieving column ") or
                          (line.startswith("thread ") and " panicked at " in line) or
                          line.startswith("error[E")]
            print("\n".join(safe_lines) or "未取得安全诊断标签，请单独检查编译。", flush=True)
        raise RuntimeError("隔离 PostgreSQL 验收命令失败：" + command[0])
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preflight", action="store_true", help="只读检查本地镜像，不启动实例或编译")
    parser.add_argument("--suite", choices=("catalog", "pagination", "all"), default="all")
    parser.add_argument("--output", type=Path, help="额外保存脱敏证据 JSON 的路径")
    args = parser.parse_args()
    availability = preflight()
    if args.preflight or availability["status"] != "ready":
        print(json.dumps(availability, ensure_ascii=False), flush=True)
        if availability["status"] != "ready":
            raise SystemExit(2)
        return
    marker = "db-connect-metadata-pg-" + uuid.uuid4().hex
    fixture = Path(tempfile.mkdtemp(prefix="db-connect-metadata-pg-", dir="/private/tmp"))
    password, limited_password = uuid.uuid4().hex, uuid.uuid4().hex
    env = dict(os.environ, POSTGRES_PASSWORD=password)
    launch_attempted = False
    primary_error = None
    cleanup_error = None
    stage = "launch"
    evidence = {
        "fixture_marker": marker, "image": IMAGE, "image_id": availability["image_id"],
        "suite": args.suite, "status": "failed", "measurement_status": "failed",
        "measurement_run": False, "pull_attempted": False,
        "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    try:
        # --pull=never 强制仅使用本地既有镜像。
        launch_attempted = True
        run(["docker", "run", "--detach", "--rm", "--pull=never", "--name", marker,
             "--label", "db-connect.metadata.fixture=" + marker,
             "--publish", "127.0.0.1::5432", "--memory", "384m", "--cpus", "1",
             "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_USER=metadata_owner",
             "--env", "POSTGRES_DB=metadata_fixture", IMAGE, "postgres",
             "-c", "cluster_name=" + marker, "-c", "shared_preload_libraries=pg_stat_statements",
             "-c", "shared_buffers=32MB", "-c", "max_connections=20"], env=env)
        stage = "port"
        port_text = run(["docker", "port", marker, "5432/tcp"])
        host, port = port_text.rsplit(":", 1)
        if host != "127.0.0.1" or not (1024 < int(port) < 65536) or int(port) == 5432:
            raise RuntimeError("隔离容器端口校验失败")
        stage = "readiness"
        deadline = time.monotonic() + 60
        while True:
            # pg_isready 只检查服务就绪，不执行 SQL。
            ready = subprocess.run(["docker", "exec", marker, "pg_isready", "-h", "127.0.0.1", "-U", "metadata_owner", "-d", "metadata_fixture"],
                                   capture_output=True, text=True, timeout=10, check=False)
            if ready.returncode == 0:
                break
            if time.monotonic() > deadline:
                raise RuntimeError("隔离 PostgreSQL 未就绪")
            time.sleep(0.25)
        ddl = '''CREATE EXTENSION pg_stat_statements;
CREATE SCHEMA metadata_a;
CREATE SCHEMA metadata_b;
CREATE SCHEMA metadata_empty;
CREATE SCHEMA "metadata'quote""|]";
CREATE TABLE metadata_a.same (id bigint PRIMARY KEY, value text);
COMMENT ON TABLE metadata_a.same IS 'schema a';
INSERT INTO metadata_a.same VALUES (1, 'fixture');
CREATE TABLE metadata_b.same (id integer);
COMMENT ON TABLE metadata_b.same IS 'schema b';
CREATE TABLE "metadata'quote""|]".same (id integer);
COMMENT ON TABLE "metadata'quote""|]".same IS 'special schema';
CREATE VIEW metadata_a.item_view AS SELECT id FROM metadata_a.same;
CREATE MATERIALIZED VIEW metadata_a.item_materialized AS SELECT id FROM metadata_a.same;
CREATE TABLE metadata_a.partitioned (id integer) PARTITION BY RANGE (id);
CREATE TABLE metadata_a.partitioned_0 PARTITION OF metadata_a.partitioned FOR VALUES FROM (0) TO (100);
INSERT INTO metadata_a.partitioned VALUES (1);
ANALYZE metadata_a.same;
ANALYZE metadata_a.partitioned;
CREATE ROLE metadata_reader LOGIN PASSWORD '__LIMITED_PASSWORD__';
GRANT USAGE ON SCHEMA metadata_a TO metadata_reader;
GRANT SELECT ON metadata_a.same TO metadata_reader;
CREATE SCHEMA metadata_pagination;
CREATE TABLE metadata_pagination.trusted (id bigint PRIMARY KEY, value text);
INSERT INTO metadata_pagination.trusted VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd'), (9007199254740993, 'e'), (9223372036854775807, 'f');
CREATE TABLE metadata_pagination.composite (tenant integer, id bigint, PRIMARY KEY (tenant, id));
INSERT INTO metadata_pagination.composite VALUES (1, 1), (2, 1);
CREATE TABLE metadata_pagination.inherited_parent (id bigint PRIMARY KEY);
CREATE TABLE metadata_pagination.inherited_child () INHERITS (metadata_pagination.inherited_parent);
INSERT INTO metadata_pagination.inherited_parent VALUES (1);
INSERT INTO metadata_pagination.inherited_child VALUES (1);
CREATE VIEW metadata_pagination.trusted_view AS SELECT * FROM metadata_pagination.trusted;
CREATE TABLE metadata_pagination.text_key (id text PRIMARY KEY);
INSERT INTO metadata_pagination.text_key VALUES ('a'), ('b');
CREATE TABLE metadata_pagination.no_key (id integer);
INSERT INTO metadata_pagination.no_key VALUES (1), (1);
CREATE TABLE metadata_pagination.empty_table (id bigint PRIMARY KEY, value text);
'''.replace("__LIMITED_PASSWORD__", limited_password)
        stage = "fixture_ddl"
        run(["docker", "exec", "--interactive", marker, "psql", "-X", "-v", "ON_ERROR_STOP=1",
             "-U", "metadata_owner", "-d", "metadata_fixture"], input_text=ddl)
        stage = "credentials"
        config_path = fixture / "fixture.json"
        config_path.write_text(json.dumps({"marker": marker, "port": int(port),
                                          "password": password, "limited_password": limited_password}))
        config_path.chmod(0o600)
        test_env = dict(os.environ, DB_CONNECT_METADATA_PG_FIXTURE=str(fixture))
        test_name = {
            "catalog": "db::metadata_pg_tests::metadata_access_isolated_postgres17",
            "pagination": "db::metadata_pg_pagination_tests::metadata_access_isolated_postgres17_pagination",
            "all": "metadata_access_isolated_postgres17",
        }[args.suite]
        command = ["cargo", "test", "--offline", "--locked", "--manifest-path", "src-tauri/Cargo.toml",
                   "--lib", test_name, "--", "--ignored", "--nocapture", "--test-threads=1"]
        if args.suite != "all":
            command.append("--exact")
        stage = "measurement"
        evidence["measurement_run"] = True
        output = run(command,
                     env=test_env, timeout=900)
        prefixes = {
            "catalog": "METADATA_POSTGRES_VALIDATION ",
            "pagination": "METADATA_POSTGRES_PAGINATION ",
        }
        for suite, prefix in prefixes.items():
            # 这里只解析内存输出，不在循环中发 SQL 或运行子进程。
            records = [line.split(prefix, 1)[1] for line in output.splitlines() if prefix in line]
            expected = int(args.suite in (suite, "all"))
            if len(records) != expected:
                raise RuntimeError("PostgreSQL 验收结果数量不符：" + suite)
            if records:
                evidence[suite] = json.loads(records[0])
        stage = "source_identity"
        sources = [Path(__file__).resolve(), ROOT / "src-tauri/src/db/metadata_pg_tests.rs",
                   ROOT / "src-tauri/src/db/metadata_pg_pagination_tests.rs",
                   ROOT / "src-tauri/src/db/postgres.rs", ROOT / "src-tauri/src/db/table_pagination.rs"]
        evidence.update({"fixture_marker": marker, "image": IMAGE, "image_id": availability["image_id"],
                         "suite": args.suite, "platform": platform.platform(),
                         "rustc": run(["rustc", "--version"]),
                         "source_head": run(["git", "rev-parse", "HEAD"]),
                         "source_sha256": {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources},
                         "command": command, "measurement_run": True, "pull_attempted": False})
        evidence["measurement_status"] = "passed"
    except BaseException as error:
        # 异常文本可能含 SQL、命令输出或凭据；仅保留类型和固定阶段标签。
        primary_error = error
        evidence["measurement_error"] = {"stage": stage, "type": type(error).__name__}
    finally:
        evidence["container_and_volumes_removed"] = False
        evidence["cleanup_status"] = "not_attempted"
        cleanup_stage = "inspect"
        try:
            if launch_attempted:
                # run 超时/失败也可能已经创建容器，只按本次随机名称和专属标签清理。
                inspected = subprocess.run(
                    ["docker", "inspect", marker, "--format", '{{ index .Config.Labels "db-connect.metadata.fixture" }}'],
                    cwd=ROOT, capture_output=True, text=True, timeout=60, check=False)
                if inspected.returncode:
                    if "No such object" not in inspected.stderr and "No such container" not in inspected.stderr:
                        raise RuntimeError("无法核实本次专属容器状态")
                    evidence["cleanup_status"] = "not_found"
                    label = None
                else:
                    label = inspected.stdout.strip()
                cleanup_stage = "label_check"
                if label is not None and label != marker:
                    raise RuntimeError("实例标签不匹配，拒绝清理")
                if label is not None:
                    cleanup_stage = "remove"
                    run(["docker", "rm", "--force", "--volumes", marker])
                    evidence["container_and_volumes_removed"] = True
                    evidence["cleanup_status"] = "removed"
        except BaseException as error:
            cleanup_error = error
            evidence["cleanup_status"] = "failed"
            evidence["cleanup_error"] = {"stage": cleanup_stage, "type": type(error).__name__}
        finally:
            try:
                (fixture / "fixture.json").unlink(missing_ok=True)
                evidence["credentials_removed"] = True
            except BaseException as error:
                evidence["credentials_removed"] = False
                evidence["credential_cleanup_error"] = {"type": type(error).__name__}
                if cleanup_error is None:
                    cleanup_error = error
        evidence["status"] = "passed" if primary_error is None and cleanup_error is None else "failed"
        evidence["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        archive_error = None
        try:
            serialized = json.dumps(evidence, ensure_ascii=False, indent=2) + "\n"
            (fixture / "result.json").write_text(serialized)
            if args.output:
                args.output.write_text(serialized)
        except BaseException as error:
            archive_error = error
            evidence["status"] = "failed"
            evidence["archive_error"] = {"type": type(error).__name__}
            # 最终路径写入失败时仍尽可能保留专属目录中的失败证据。
            try:
                (fixture / "result.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
            except OSError:
                pass
        print(json.dumps(evidence, ensure_ascii=False), flush=True)
        print(str(fixture / "result.json"), flush=True)
        # 清理或归档失败都不能取代最初的启动/测量异常。
        if primary_error is not None:
            raise primary_error from None
        if cleanup_error is not None:
            raise RuntimeError("隔离 PostgreSQL 清理失败；已保存脱敏证据") from None
        if archive_error is not None:
            raise RuntimeError("隔离 PostgreSQL 证据归档失败") from None


if __name__ == "__main__":
    main()
