#!/usr/bin/env python3
"""真实 PostgreSQL TLS 隔离验收。创建独立容器和临时证书，退出时全部清理。

不读取保存连接、用户证书信任库或已有容器。JSON/日志不包含密码或连接URL。
退出码：0 通过；1 失败；2 环境不可用。
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
LABEL = "io.db-connect.data-task-validation=true"
IMAGE = "postgres:17-alpine"


class ValidationError(Exception):
    pass


def run(args, *, check=True, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if check and result.returncode:
        # 不打印带密码的命令、环境或原始驱动错误。
        raise ValidationError(f"{Path(args[0]).name} 执行失败（退出码 {result.returncode}）")
    return result


def certificates(directory: Path):
    ca_extensions = "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n"
    ca_config = directory / "ca.cnf"
    ca_config.write_text("[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=DB Connect temporary acceptance CA\n[ca]\n" + ca_extensions)
    for prefix in ("ca", "wrong-ca"):
        run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-config", str(ca_config), "-keyout", str(directory / f"{prefix}.key"), "-out", str(directory / f"{prefix}.crt")])
    run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=db-connect-validate.local", "-keyout", str(directory / "server.key"), "-out", str(directory / "server.csr")])
    extensions = directory / "server.ext"
    extensions.write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:db-connect-validate.local\n")
    run(["openssl", "x509", "-req", "-in", str(directory / "server.csr"), "-CA", str(directory / "ca.crt"), "-CAkey", str(directory / "ca.key"), "-CAcreateserial", "-days", "2", "-extfile", str(extensions), "-out", str(directory / "server.crt")])
    # 签名与DNS链先由OpenSSL离线核对，平台native_tls仍必须经过真实握手测试。
    run(["openssl", "verify", "-CAfile", str(directory / "ca.crt"), "-verify_hostname", "db-connect-validate.local", str(directory / "server.crt")])
    for key in directory.glob("*.key"):
        key.chmod(0o600)


def build() -> Path:
    result = run(["cargo", "test", "--manifest-path", str(ROOT / "src-tauri/Cargo.toml"), "--lib", "--no-run", "--message-format=json"], cwd=ROOT)
    for line in result.stdout.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if item.get("reason") == "compiler-artifact" and item.get("target", {}).get("name") == "db_connect_lib" and item.get("profile", {}).get("test") and item.get("executable"):
            return Path(item["executable"])
    raise ValidationError("构建未返回当前工作区库测试程序")


def cleanup_container(name: str, *, created: bool) -> dict[str, str]:
    """只删除本次唯一名称且标签匹配的资源；通信失败必须保留可操作的资源名。"""
    failure = {"container": "failed", "container_name": name}
    try:
        inspected = run(["docker", "inspect", name], check=False)
        if inspected.returncode:
            # 非零也可能是daemon故障、权限拒绝或连接中断。只接受明确的不存在答复。
            missing = {f"error: no such object: {name}", f"error: no such container: {name}"}
            if inspected.returncode == 1 and inspected.stderr.strip().casefold() in missing:
                # 已知创建成功却找不到容器，无法确认关联匿名卷是否被外部清理。
                return failure if created else {"container": "not_created"}
            return failure
        containers = json.loads(inspected.stdout)
        if not isinstance(containers, list) or len(containers) != 1:
            return failure
        container = containers[0]
        if container.get("Name") != "/" + name or container.get("Config", {}).get("Labels", {}).get("io.db-connect.data-task-validation") != "true":
            return failure
        # -v 同时删除本容器生成的匿名PGDATA卷，不留验收数据。
        removed = run(["docker", "rm", "-f", "-v", name], check=False)
        if removed.returncode:
            return {**failure, "anonymous_data_volume": "failed"}
        return {"container": "removed", "anonymous_data_volume": "removed"}
    except (OSError, ValueError, TypeError, AttributeError):
        return failure


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, help="复用已由当前工作区构建的Rust库测试程序")
    parser.add_argument("--report", type=Path, default=ROOT / "artifacts/data-tasks/tls-validation.json")
    parser.add_argument("--log", type=Path, default=ROOT / "artifacts/data-tasks/tls-validation.log")
    args = parser.parse_args()
    name = "db-connect-data-task-validate-tls-" + uuid.uuid4().hex[:10]
    create_attempted = False
    created = False
    report = {"scope": "disposable_postgres17_private_ca_loopback", "results": [], "cleanup": {"container": "not_created", "temporary_certificates": "not_created"}}
    safe_log = ""
    exit_code = 2
    start = time.monotonic()
    temporary_directory = None
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, interrupted)
    try:
        if not shutil.which("docker") or not shutil.which("openssl"):
            raise ValidationError("需要本机 Docker 和 OpenSSL")
        run(["docker", "image", "inspect", IMAGE])  # 不拉取镜像，不触碰其他实例。
        binary = args.binary.resolve() if args.binary else build()
        temporary_directory = tempfile.TemporaryDirectory(prefix="db-connect-data-task-tls-")
        directory = Path(temporary_directory.name)
        report["cleanup"]["temporary_certificates"] = "pending"
        certificates(directory)
        password = "DbTask9!" + secrets.token_hex(16)
        env_file = directory / "container.env"
        env_file.write_text("POSTGRES_USER=data_tls_admin\nPOSTGRES_DB=data_tls_acceptance\nPOSTGRES_PASSWORD=" + password + "\n")
        env_file.chmod(0o600)
        # 在 create 调用前登记尝试，收到中断时也检查并清理本次唯一名称。
        create_attempted = True
        report["cleanup"]["container"] = "pending"
        run(["docker", "create", "--name", name, "--label", LABEL, "-p", "127.0.0.1::5432", "--env-file", str(env_file), "--entrypoint", "sh", IMAGE, "-c", "chown postgres:postgres /tmp/server.key /tmp/server.crt && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key"])
        created = True
        for filename in ("server.key", "server.crt"):
            run(["docker", "cp", str(directory / filename), f"{name}:/tmp/{filename}"])
        run(["docker", "start", name])
        binding = run(["docker", "port", name, "5432/tcp"]).stdout.strip()
        if not re.fullmatch(r"127\.0\.0\.1:\d+", binding):
            raise ValidationError("专属夹具必须仅绑定回环随机端口")
        port = int(binding.rsplit(":", 1)[1])
        # readiness 仅检查容器日志；禁止在轮询中执行SELECT。
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            # postgres 日志写stderr；两者都只在内存使用，不回显原文。
            state = run(["docker", "logs", name])
            logs = state.stdout + state.stderr
            if "PostgreSQL init process complete" in logs and logs.count("database system is ready to accept connections") >= 2:
                break
            time.sleep(0.25)
        else:
            raise ValidationError("专属TLS数据库未在45秒内就绪")
        config = directory / "connection.json"
        config.write_text(json.dumps({"database_type": "postgres", "name": "隔离TLS验收", "host": "127.0.0.1", "port": port, "username": "data_tls_admin", "password": password, "database": "data_tls_acceptance", "ssl_mode": "verify_identity", "ssl_ca_path": str(directory / "ca.crt"), "ssl_tls_hostname": "db-connect-validate.local"}))
        config.chmod(0o600)
        environment = os.environ.copy()
        environment.update({"DB_CONNECT_DATA_TASK_TLS_CONFIG": str(config), "DB_CONNECT_DATA_TASK_TLS_WRONG_CA": str(directory / "wrong-ca.crt")})
        result = run([str(binary), "data_tasks::acceptance_tls_tests::", "--ignored", "--nocapture", "--test-threads=1"], check=False, cwd=ROOT, env=environment, timeout=180)
        raw = result.stdout + "\n" + result.stderr
        # 仅保留测试名、结果、明确脱敏的指标及简短断言；原始输出可能含驱动细节。
        safe_lines = [line for line in raw.splitlines() if line.startswith(("running ", "test ", "test result:", "DATA_TASK_TLS_METRICS", "failures:", "    db::data_tasks::acceptance_tls_tests::"))]
        safe_log = "\n".join(safe_lines).replace(password, "[REDACTED]") + "\n"
        summary = re.search(r"test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;", raw)
        passed, failed = map(int, summary.groups()) if summary else (0, 0)
        status = "passed" if result.returncode == 0 and passed == 4 and failed == 0 else "failed"
        report["results"].append({"name": "postgres_verify_identity_custom_ca_tls", "status": status, "passed": passed, "failed": failed, "expected_tests": 4, "metrics": re.findall(r"DATA_TASK_TLS_METRICS ([^\n]+)", raw)})
        if status == "failed":
            # 固定分类提示足够定位，具体凭据不进入报告。
            report["results"][-1]["limitation"] = "若正确私有CA握手失败，需核对本机native_tls信任实现；不得将错误CA拒绝视为正确CA已通过"
        exit_code = 0 if status == "passed" else 1
    except (ValidationError, subprocess.TimeoutExpired, KeyboardInterrupt) as error:
        report["results"].append({"name": "tls_fixture", "status": "not_run" if isinstance(error, ValidationError) else "failed", "detail": str(error) if isinstance(error, ValidationError) else type(error).__name__})
        exit_code = 2 if isinstance(error, ValidationError) else 1
    finally:
        if create_attempted:
            cleanup = cleanup_container(name, created=created)
            report["cleanup"].update(cleanup)
            if cleanup["container"] == "failed":
                exit_code = 1
        if temporary_directory:
            temporary_directory.cleanup()
            report["cleanup"]["temporary_certificates"] = "removed"
        report["elapsed_seconds"] = round(time.monotonic() - start, 3)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.log.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        args.log.write_text(safe_log)
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
