#!/usr/bin/env python3
"""ClickHouse T03 隔离目录验收；只使用本地官方镜像，不读取业务配置。

创建随机专属容器、loopback 随机端口，无主机目录挂载；结束时校验标签后
只清理自己的容器和匿名卷。真实测试调用显式列出，不循环查询 SQL。
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
IMAGE = "clickhouse/clickhouse-server:25.8"
LABEL = "db-connect.metadata.clickhouse.fixture"
TEST = "db::metadata_clickhouse_tests::metadata_batch_isolated_clickhouse_catalog"


class StageFailure(RuntimeError):
    def __init__(self, stage, returncode=None):
        super().__init__(stage)
        self.stage = stage
        self.returncode = returncode


def run(command, stage, *, env=None, input_text=None, timeout=60):
    result = subprocess.run(command, cwd=ROOT, env=env, input=input_text,
                            capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        # 不透传 ClickHouse/编译器原始输出，避免错误包含密码、SQL 或结果内容。
        if command[0] == "cargo":
            safe = [line for line in (result.stdout + result.stderr).splitlines()
                    if line.startswith("error[E") or line.startswith("ClickHouse 隔离验收失败：")]
            if safe:
                print("\n".join(safe), flush=True)
        raise StageFailure(stage, result.returncode)
    return result.stdout.strip()


def preflight():
    try:
        result = subprocess.run(["docker", "image", "inspect", IMAGE, "--format",
                                 '{{json .}}'], cwd=ROOT, capture_output=True,
                                text=True, timeout=30, check=False)
        if result.returncode:
            status = "image_missing" if "No such image" in result.stderr else "docker_unavailable"
            return {"status": status, "image": IMAGE, "measurement_run": False}
        info = json.loads(result.stdout)
        return {"status": "ready", "image": IMAGE, "image_id": info["Id"],
                "image_architecture": info["Architecture"], "measurement_run": False}
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return {"status": "docker_unavailable", "image": IMAGE, "measurement_run": False}


def missing_container(stderr):
    normalized = " ".join(stderr.lower().split())
    return "no such object" in normalized or "no such container" in normalized


def cleanup_owned(marker):
    """即使 docker run 失败或超时，也检查随机名称，避免遗留已创建的实例。"""
    result = subprocess.run(["docker", "inspect", marker, "--format", '{{json .Config.Labels}}'],
                            cwd=ROOT, capture_output=True, text=True, timeout=30, check=False)
    if result.returncode:
        if missing_container(result.stderr):
            return {"status": "absent", "owned_container_absent": True}
        raise StageFailure("cleanup_inspect", result.returncode)
    if json.loads(result.stdout).get(LABEL) != marker:
        raise StageFailure("cleanup_label_mismatch")
    run(["docker", "rm", "--force", "--volumes", marker], "cleanup_remove")
    absent = subprocess.run(["docker", "inspect", marker], cwd=ROOT, capture_output=True,
                            text=True, timeout=30, check=False)
    if absent.returncode == 0 or not missing_container(absent.stderr):
        raise StageFailure("cleanup_verify_absent", absent.returncode)
    return {"status": "removed", "owned_container_absent": True,
            "anonymous_volumes_removed": True, "label_rechecked": True}


def wait_ready(port):
    deadline = time.monotonic() + 90
    while True:
        # /ping 是专用 HTTP 健康检查，不执行 SQL。
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/ping", timeout=2) as response:
                if response.status == 200 and response.read().strip() == b"Ok.":
                    return
        except (OSError, urllib.error.URLError):
            pass
        if time.monotonic() >= deadline:
            raise StageFailure("http_ping_timeout")
        time.sleep(0.25)


def source_hashes():
    sources = [Path(__file__).resolve(), ROOT / "scripts/performance/test_metadata_clickhouse_validation.py",
               ROOT / "src-tauri/src/db/metadata_clickhouse_tests.rs",
               ROOT / "src-tauri/src/db/clickhouse.rs", ROOT / "src-tauri/src/db/metadata_batch.rs",
               ROOT / "src-tauri/src/models/types.rs"]
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}


def archive(evidence, fixture, output):
    try:
        encoded = json.dumps(evidence, ensure_ascii=False, indent=2) + "\n"
        (fixture / "result.json").write_text(encoded)
        if output:
            output.write_text(encoded)
    except BaseException as error:
        evidence["status"] = "failed"
        evidence["archive_error"] = {"exception_type": type(error).__name__}
        # 目标目录不可写时仍保存临时目录副本，并在 stdout 保留主失败和清理结果。
        try:
            (fixture / "result.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
        except BaseException:
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--output", type=Path, help="清理完成后保存脱敏成功或失败证据")
    args = parser.parse_args()
    availability = preflight()
    if args.preflight or availability["status"] != "ready":
        print(json.dumps(availability, ensure_ascii=False), flush=True)
        return 0 if availability["status"] == "ready" else 2
    marker = "db-connect-metadata-ch-" + uuid.uuid4().hex
    fixture = Path(tempfile.mkdtemp(prefix="db-connect-metadata-ch-", dir="/private/tmp"))
    fixture.chmod(0o700)
    password, limited_password = uuid.uuid4().hex, uuid.uuid4().hex
    config_path = fixture / "fixture.json"
    evidence = {"recorded_at": datetime.now(timezone.utc).isoformat(), **availability,
                "fixture_marker": marker, "measurement_run": False,
                "pull_attempted_by_runner": False, "host_bind_mounts": False,
                "business_configuration_read": False, "build_profile": "cargo test debug",
                "sdkroot": os.environ.get("SDKROOT"),
                "container_limits": {"memory": "1536m", "cpus": 2}}
    attempted_run = False
    try:
        env = dict(os.environ, CLICKHOUSE_PASSWORD=password)
        attempted_run = True
        run(["docker", "run", "--detach", "--pull=never", "--name", marker,
             "--hostname", marker, "--label", LABEL + "=" + marker,
             "--publish", "127.0.0.1::8123", "--memory", "1536m", "--cpus", "2",
             "--env", "CLICKHOUSE_PASSWORD", "--env", "CLICKHOUSE_USER=metadata_owner",
             "--env", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1", IMAGE,
             "--", "--background_schedule_pool_size=4",
             "--background_message_broker_schedule_pool_size=2", "--background_distributed_schedule_pool_size=2",
             "--max_server_memory_usage=1073741824"], "create_container", env=env)
        host, port_text = run(["docker", "port", marker, "8123/tcp"], "inspect_port").rsplit(":", 1)
        port = int(port_text)
        if host != "127.0.0.1" or not 1024 < port <= 65535 or port == 8123:
            raise StageFailure("unsafe_port")
        wait_ready(port)
        ddl = '''CREATE DATABASE metadata_fixture;
CREATE TABLE metadata_fixture.marker (token String) ENGINE=Memory;
INSERT INTO metadata_fixture.marker VALUES ('__MARKER__');
CREATE DATABASE metadata_a;
CREATE DATABASE metadata_b;
CREATE DATABASE metadata_empty;
CREATE DATABASE `metadata'quote``"|]`;
CREATE TABLE metadata_a.same (id UInt64, value String) ENGINE=Memory COMMENT 'schema a';
INSERT INTO metadata_a.same VALUES (1, 'fixture');
CREATE TABLE metadata_b.same (id UInt64) ENGINE=Memory COMMENT 'schema b';
CREATE TABLE `metadata'quote``"|]`.same (id UInt64) ENGINE=Memory COMMENT 'special database';
CREATE TABLE metadata_a.`q'quote``"|]` (id UInt64) ENGINE=Memory COMMENT 'special table';
CREATE VIEW metadata_a.item_view AS SELECT id FROM metadata_a.same;
CREATE USER metadata_reader IDENTIFIED WITH sha256_password BY '__READER_PASSWORD__';
GRANT SELECT ON metadata_a.same TO metadata_reader;
CREATE USER metadata_none IDENTIFIED WITH sha256_password BY '__READER_PASSWORD__';
'''.replace("__MARKER__", marker).replace("__READER_PASSWORD__", limited_password)
        run(["docker", "exec", "--interactive", marker, "bash", "-c",
             'clickhouse-client --user metadata_owner --password "$CLICKHOUSE_PASSWORD" --multiquery'],
            "initialize_fixture", input_text=ddl)
        config_path.write_text(json.dumps({"marker": marker, "port": port,
                                          "password": password, "limited_password": limited_password}))
        config_path.chmod(0o600)
        command = ["cargo", "test", "--offline", "--locked", "--manifest-path", "src-tauri/Cargo.toml",
                   "--lib", TEST, "--", "--exact", "--ignored", "--nocapture", "--test-threads=1"]
        test_env = dict(os.environ, DB_CONNECT_METADATA_CH_FIXTURE=str(fixture))
        evidence["measurement_run"] = True
        output = run(command, "rust_catalog_acceptance", env=test_env, timeout=900)
        prefix = "METADATA_CLICKHOUSE_VALIDATION "
        records = [line.split(prefix, 1)[1] for line in output.splitlines() if prefix in line]
        if len(records) != 1:
            raise StageFailure("result_count")
        evidence.update({"status": "passed", "catalog": json.loads(records[0]),
                         "command": command, "platform": platform.platform(),
                         "rust_test_result": [line for line in output.splitlines() if line.startswith("test result:")],
                         "source_head": run(["git", "rev-parse", "HEAD"], "read_head"),
                         "rustc": run(["rustc", "--version"], "read_rustc"),
                         "legacy_source_commit": "17e37adaa84cc7c79d53430432db726f6a81e768"})
    except BaseException as error:
        evidence.update({"status": "failed", "failure": {"exception_type": type(error).__name__,
                         "stage": error.stage if isinstance(error, StageFailure) else "runner",
                         "returncode": error.returncode if isinstance(error, StageFailure) else None}})
    finally:
        try:
            evidence["cleanup"] = cleanup_owned(marker) if attempted_run else {"status": "not_created"}
        except BaseException as error:
            evidence["cleanup"] = {"status": "failed", "exception_type": type(error).__name__,
                                   "stage": error.stage if isinstance(error, StageFailure) else "cleanup"}
            evidence["status"] = "failed"
        finally:
            try:
                config_path.unlink(missing_ok=True)
                evidence["credential_file_removed"] = not config_path.exists()
            except BaseException as error:
                evidence["credential_file_removed"] = False
                evidence["credential_cleanup_error"] = {"exception_type": type(error).__name__}
                evidence["status"] = "failed"
    try:
        evidence["source_sha256"] = source_hashes()
    except BaseException as error:
        evidence["status"] = "failed"
        evidence["source_hash_error"] = {"exception_type": type(error).__name__}
    archive(evidence, fixture, args.output)
    print(json.dumps(evidence, ensure_ascii=False), flush=True)
    return 0 if evidence["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
