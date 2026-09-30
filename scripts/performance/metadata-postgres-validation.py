#!/usr/bin/env python3
"""用已存在的 postgres:17-alpine 镜像验收生产目录批量查询；不拉取镜像、不访问业务配置。

只启动一个带随机专属名称的容器，绑定随机 loopback 端口，不挂载主机目录。
夹具 DDL 一次执行；Rust 显式执行对照案例，不在循环内查询 SQL。
测试输出仅保存无 SQL、无密码的结果；结束时只删除本脚本创建的容器及匿名卷。
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
IMAGE = "postgres:17-alpine"


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
    marker = "db-connect-metadata-pg-" + uuid.uuid4().hex
    fixture = Path(tempfile.mkdtemp(prefix="db-connect-metadata-pg-", dir="/private/tmp"))
    password, limited_password = uuid.uuid4().hex, uuid.uuid4().hex
    env = dict(os.environ, POSTGRES_PASSWORD=password)
    created = False
    try:
        # --pull=never 强制仅使用本地既有镜像。
        run(["docker", "image", "inspect", IMAGE, "--format", "{{.Id}}"])
        run(["docker", "run", "--detach", "--rm", "--pull=never", "--name", marker,
             "--label", "db-connect.metadata.fixture=" + marker,
             "--publish", "127.0.0.1::5432", "--memory", "384m", "--cpus", "1",
             "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_USER=metadata_owner",
             "--env", "POSTGRES_DB=metadata_fixture", IMAGE, "postgres",
             "-c", "cluster_name=" + marker, "-c", "shared_preload_libraries=pg_stat_statements",
             "-c", "shared_buffers=32MB", "-c", "max_connections=20"], env=env)
        created = True
        port_text = run(["docker", "port", marker, "5432/tcp"])
        host, port = port_text.rsplit(":", 1)
        if host != "127.0.0.1" or not (1024 < int(port) < 65536) or int(port) == 5432:
            raise RuntimeError("隔离容器端口校验失败")
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
'''.replace("__LIMITED_PASSWORD__", limited_password)
        run(["docker", "exec", "--interactive", marker, "psql", "-X", "-v", "ON_ERROR_STOP=1",
             "-U", "metadata_owner", "-d", "metadata_fixture"], input_text=ddl)
        config_path = fixture / "fixture.json"
        config_path.write_text(json.dumps({"marker": marker, "port": int(port),
                                          "password": password, "limited_password": limited_password}))
        config_path.chmod(0o600)
        test_env = dict(os.environ, DB_CONNECT_METADATA_PG_FIXTURE=str(fixture))
        output = run(["cargo", "test", "--offline", "--locked", "--manifest-path", "src-tauri/Cargo.toml",
                      "--lib", "metadata_access_isolated_postgres17", "--", "--ignored", "--nocapture", "--test-threads=1"],
                     env=test_env, timeout=900)
        records = [line.split("METADATA_POSTGRES_VALIDATION ", 1)[1]
                   for line in output.splitlines() if "METADATA_POSTGRES_VALIDATION " in line]
        if len(records) != 1:
            raise RuntimeError("缺少唯一 PostgreSQL 验收结果")
        evidence = json.loads(records[0])
        evidence.update({"fixture_marker": marker, "image": IMAGE})
        (fixture / "result.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(evidence, ensure_ascii=False), flush=True)
        print(str(fixture / "result.json"), flush=True)
    finally:
        try:
            if created:
                # 只使用本进程随机创建的专属名称，且二次校验标签后才清理。
                label = run(["docker", "inspect", marker, "--format", '{{ index .Config.Labels "db-connect.metadata.fixture" }}'])
                if label != marker:
                    raise RuntimeError("实例标签不匹配，拒绝清理")
                run(["docker", "rm", "--force", "--volumes", marker])
                print("已删除本次专属 PostgreSQL 容器及匿名卷", flush=True)
        finally:
            (fixture / "fixture.json").unlink(missing_ok=True)


if __name__ == "__main__":
    main()
