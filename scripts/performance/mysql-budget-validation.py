#!/usr/bin/env python3
"""用本地已有 MySQL 8 镜像验收生产表页/完整行预算；不接触保存连接。"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import time
import uuid


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", choices=["mysql:8.4", "mysql:8.0"], default="mysql:8.4")
    parser.add_argument("--output", type=Path, required=True, help="新建证据 JSON；禁止覆盖已有文件")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("证据文件已存在，请指定新路径")
    repo = Path(__file__).resolve().parents[2]
    marker = uuid.uuid4().hex
    name = f"db-connect-budget-mysql-{marker}"
    fixture = Path("/private/tmp") / name
    fixture.mkdir(mode=0o700)
    run(["docker", "image", "inspect", args.image], stdout=subprocess.DEVNULL)
    created = False
    evidence = {
        "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "image": args.image, "marker": marker, "status": "failed",
        "scope": "production Rust commands with MockRuntime; no IPC/WebView/RSS measurement",
        "host": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
        "build_mode": "cargo test debug",
        "sdkroot": os.environ.get("SDKROOT"),
        "source_sha256": {
            source: hashlib.sha256((repo / source).read_bytes()).hexdigest()
            for source in [
                "scripts/performance/mysql-budget-validation.py",
                "src-tauri/src/commands/data.rs",
                "src-tauri/src/commands/data_mysql_budget_tests.rs",
                "src-tauri/src/db/result_budget.rs",
                "src-tauri/src/db/mysql_deferred_fields.rs",
                "src-tauri/src/db/connection.rs",
                "src-tauri/src/db/table_pagination.rs",
                "src-tauri/Cargo.lock",
            ]
        },
    }
    try:
        run([
            "docker", "run", "--detach", "--pull=never", "--name", name,
            "--label", f"db-connect-budget-fixture={marker}",
            "-e", "MYSQL_ALLOW_EMPTY_PASSWORD=yes", "-e", "MYSQL_ROOT_HOST=%",
            "-p", "127.0.0.1::3306", args.image,
            "--lower-case-table-names=0", "--max-allowed-packet=134217728",
            "--performance-schema=ON",
        ], stdout=subprocess.DEVNULL)
        created = True
        info = json.loads(run(["docker", "inspect", name], capture_output=True).stdout)[0]
        evidence["image_id"] = info["Image"]
        assert info["Config"]["Labels"]["db-connect-budget-fixture"] == marker
        binding = info["NetworkSettings"]["Ports"]["3306/tcp"]
        assert len(binding) == 1 and binding[0]["HostIp"] == "127.0.0.1"
        port = int(binding[0]["HostPort"])
        assert 1024 < port <= 65535 and port != 3306
        # 只重试协议 ping；禁止在就绪循环中查询 SQL。
        deadline = time.monotonic() + 90
        while True:
            ready = subprocess.run([
                "docker", "exec", name, "mysqladmin", "-uroot", "-h127.0.0.1", "ping",
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if ready.returncode == 0:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("自有 MySQL 容器未在期限内就绪")
            time.sleep(1)
        # 一次集合初始化，无遍历发 SQL。六个 9 MiB 字段在第四行越过 32 MiB，仍有未读行。
        sql = f"""CREATE DATABASE budget_fixture;
CREATE TABLE budget_fixture.marker (id INT PRIMARY KEY, token VARCHAR(64) NOT NULL);
INSERT INTO budget_fixture.marker VALUES (1, '{marker}');
CREATE TABLE budget_fixture.single_items (id INT PRIMARY KEY, body LONGTEXT NOT NULL);
INSERT INTO budget_fixture.single_items SELECT id, REPEAT('x',9437184) FROM
(SELECT 1 id UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6) ids;
INSERT INTO budget_fixture.single_items VALUES (7,'fixture');
CREATE TABLE budget_fixture.no_key_items (id INT, body LONGTEXT NOT NULL);
INSERT INTO budget_fixture.no_key_items SELECT * FROM budget_fixture.single_items;
CREATE TABLE budget_fixture.composite_items (tenant INT, id INT, body LONGTEXT NOT NULL, PRIMARY KEY(tenant,id));
INSERT INTO budget_fixture.composite_items SELECT 1,id,body FROM budget_fixture.single_items;
CREATE TABLE budget_fixture.empty_no_key (id INT, body LONGTEXT);
CREATE TABLE budget_fixture.empty_composite (tenant INT, id INT, body LONGTEXT, PRIMARY KEY(tenant,id));
SELECT @@version, @@server_uuid, @@lower_case_table_names, @@port;
"""
        actual = run([
            "docker", "exec", "-i", name, "mysql", "-uroot", "--batch", "--skip-column-names",
        ], input=sql, capture_output=True).stdout.strip().split("\t")
        assert len(actual) == 4 and actual[0].startswith(args.image.split(":")[1] + ".")
        assert actual[2:] == ["0", "3306"]
        config = {
            "container": name, "marker": marker, "port": port,
            "version": actual[0], "server_uuid": actual[1],
        }
        (fixture / "fixture.json").write_text(json.dumps(config))
        evidence.update(version=actual[0], server_uuid=actual[1], port=port)
        command = [
            "cargo", "test", "--offline", "--locked", "--manifest-path", str(repo / "src-tauri/Cargo.toml"),
            "--lib", "mysql_budget_isolated_commands", "--", "--ignored", "--nocapture", "--test-threads=1",
        ]
        evidence["command"] = "cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --lib mysql_budget_isolated_commands -- --ignored --nocapture --test-threads=1"
        evidence["git_head"] = run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True).stdout.strip()
        print(f"隔离预算夹具：MySQL {actual[0]}，127.0.0.1:{port}", flush=True)
        result = subprocess.run(command, cwd=repo, env=dict(os.environ, DB_CONNECT_BUDGET_MYSQL_FIXTURE=str(fixture)))
        evidence["cargo_exit_code"] = result.returncode
        if result.returncode != 0:
            raise RuntimeError("MySQL 预算实库测试失败；不记录为通过")
        evidence["assertions"] = json.loads((fixture / "results.json").read_text())
        evidence["status"] = "passed"
    except Exception as error:
        # 不保存可能包含 SQL/结果/命令参数的异常文本。
        evidence["measurement_error"] = {"type": type(error).__name__}
        raise
    finally:
        evidence["measurement_status"] = evidence["status"]
        evidence["container_and_volumes_removed"] = False
        cleanup_stage = "inspect"
        try:
            if created:
                info = json.loads(run(["docker", "inspect", name], capture_output=True).stdout)[0]
                cleanup_stage = "label_check"
                if info["Config"]["Labels"].get("db-connect-budget-fixture") != marker:
                    raise RuntimeError("拒绝清理标签不匹配的容器")
                cleanup_stage = "remove"
                run(["docker", "rm", "--force", "--volumes", name], stdout=subprocess.DEVNULL)
                evidence["container_and_volumes_removed"] = True
        except Exception as error:
            evidence["status"] = "failed"
            evidence["cleanup_error"] = {"stage": cleanup_stage, "type": type(error).__name__}
            raise RuntimeError("隔离容器清理失败；已保留原测量结果及清理错误") from error
        finally:
            evidence["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            # 即使 inspect/rm/标签校验失败也保底写出；不记录异常文本、凭据或完整 SQL。
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("x") as output:
                json.dump(evidence, output, ensure_ascii=False, indent=2)
                output.write("\n")
            print(f"证据：{args.output}", flush=True)


if __name__ == "__main__":
    main()
