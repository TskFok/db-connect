#!/usr/bin/env python3
"""用本地已有 mysql:8.4 镜像验收元数据；只创建并删除自己的临时容器。"""
import json
import os
from pathlib import Path
import subprocess
import time
import uuid


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def main():
    marker = uuid.uuid4().hex
    name = f"db-connect-metadata-mysql8-{marker}"
    fixture = Path("/private/tmp") / name
    fixture.mkdir(mode=0o700)
    repo = Path(__file__).resolve().parents[2]
    run(["docker", "image", "inspect", "mysql:8.4"], stdout=subprocess.DEVNULL)
    created = False
    try:
        run([
            "docker", "run", "--detach", "--pull=never", "--name", name,
            "--label", f"db-connect-metadata-fixture={marker}",
            "-e", "MYSQL_ALLOW_EMPTY_PASSWORD=yes", "-e", "MYSQL_ROOT_HOST=%",
            "-p", "127.0.0.1::3306", "mysql:8.4",
            "--lower-case-table-names=0", "--performance-schema=ON",
        ], stdout=subprocess.DEVNULL)
        created = True
        info = json.loads(run(["docker", "inspect", name], capture_output=True).stdout)[0]
        assert info["Config"]["Labels"]["db-connect-metadata-fixture"] == marker
        binding = info["NetworkSettings"]["Ports"]["3306/tcp"]
        assert len(binding) == 1 and binding[0]["HostIp"] == "127.0.0.1"
        port = int(binding[0]["HostPort"])
        assert 1024 < port <= 65535 and port != 3306
        # mysqladmin ping 使用协议 ping，不在重试循环里查询 SQL。
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
        sql = f"""CREATE DATABASE metadata8_fixture;
CREATE TABLE metadata8_fixture.marker (id INT PRIMARY KEY, token VARCHAR(64) NOT NULL);
INSERT INTO metadata8_fixture.marker VALUES (1, '{marker}');
CREATE DATABASE metadata8;
CREATE TABLE metadata8.Z_items (id BIGINT PRIMARY KEY, value VARCHAR(64)) COMMENT='大写末尾';
CREATE TABLE metadata8.A_items (id BIGINT PRIMARY KEY) COMMENT='大写开头';
CREATE TABLE metadata8.a_items (id BIGINT PRIMARY KEY, value VARCHAR(64)) COMMENT='小写开头';
CREATE TABLE metadata8.`q'quote``table` (id BIGINT PRIMARY KEY) COMMENT='特殊引号表';
INSERT INTO metadata8.a_items VALUES (1, 'fixture');
CREATE VIEW metadata8.v_items AS SELECT id FROM metadata8.a_items;
CREATE DATABASE metadata8_empty;
CREATE DATABASE `metadata8'quote``"]|fixture`;
CREATE TABLE `metadata8'quote``"]|fixture`.items (id BIGINT PRIMARY KEY);
CREATE DATABASE metadata8_hidden;
CREATE TABLE metadata8_hidden.items (id BIGINT PRIMARY KEY);
CREATE DATABASE Metadata8Case;
CREATE TABLE Metadata8Case.upper_items (id BIGINT PRIMARY KEY);
CREATE DATABASE metadata8case;
CREATE TABLE metadata8case.lower_items (id BIGINT PRIMARY KEY);
CREATE USER 'metadata8_limited'@'%' IDENTIFIED BY '';
GRANT SELECT ON metadata8.a_items TO 'metadata8_limited'@'%';
CREATE USER 'metadata8_show_only'@'%' IDENTIFIED BY '';
GRANT SHOW DATABASES ON *.* TO 'metadata8_show_only'@'%';
CREATE DATABASE metadata8_role_empty;
CREATE USER 'metadata8_create'@'%';
GRANT CREATE ON metadata8_empty.* TO 'metadata8_create'@'%';
CREATE ROLE 'metadata8_role_leaf', 'metadata8_role_parent';
GRANT CREATE ON metadata8_role_empty.* TO 'metadata8_role_leaf';
GRANT SELECT ON metadata8.a_items TO 'metadata8_role_leaf';
GRANT 'metadata8_role_leaf' TO 'metadata8_role_parent';
CREATE USER 'metadata8_role_user'@'%';
GRANT 'metadata8_role_parent' TO 'metadata8_role_user'@'%';
SET DEFAULT ROLE 'metadata8_role_parent' TO 'metadata8_role_user'@'%';
CREATE USER 'metadata8_grant_only'@'%';
GRANT USAGE ON metadata8.a_items TO 'metadata8_grant_only'@'%' WITH GRANT OPTION;
CREATE USER 'metadata8_empty_role'@'%';
CREATE ROLE 'metadata8_role_nothing';
GRANT 'metadata8_role_nothing' TO 'metadata8_empty_role'@'%';
SET DEFAULT ROLE 'metadata8_role_nothing' TO 'metadata8_empty_role'@'%';
GRANT SHOW DATABASES ON *.* TO 'metadata8_empty_role'@'%';
CREATE USER 'metadata8_column'@'%';
GRANT SELECT (id) ON metadata8.a_items TO 'metadata8_column'@'%';
CREATE DATABASE metadata8_routine;
CREATE PROCEDURE metadata8_routine.fixture_proc() SELECT 1;
CREATE USER 'metadata8_routine_user'@'%';
GRANT EXECUTE ON PROCEDURE metadata8_routine.fixture_proc TO 'metadata8_routine_user'@'%';
CREATE DATABASE metadata8_wild_one;
CREATE USER 'metadata8_wildcard'@'%';
GRANT CREATE ON `metadata8_wild_%`.* TO 'metadata8_wildcard'@'%';
GRANT SHOW DATABASES ON *.* TO 'metadata8_wildcard'@'%';
CREATE DATABASE metadata8probeexact;
CREATE USER 'metadata8_overlap'@'%';
GRANT SHOW DATABASES ON *.* TO 'metadata8_overlap'@'%';
GRANT CREATE ON `metadata8probe%`.* TO 'metadata8_overlap'@'%';
GRANT USAGE ON metadata8probeexact.* TO 'metadata8_overlap'@'%' WITH GRANT OPTION;
SELECT @@version, @@server_uuid, @@lower_case_table_names, @@port;
"""
        (fixture / "fixture.sql").write_text(sql)
        actual = run([
            "docker", "exec", "-i", name, "mysql", "-uroot",
            "--batch", "--skip-column-names",
        ], input=sql, capture_output=True).stdout.strip().split("\t")
        assert len(actual) == 4 and actual[0].startswith("8.4.")
        assert actual[2:] == ["0", "3306"]
        (fixture / "fixture.json").write_text(json.dumps({
            "container": name, "marker": marker, "port": port,
            "version": actual[0], "server_uuid": actual[1],
        }))
        print(f"隔离夹具：{fixture}，MySQL {actual[0]}，127.0.0.1:{port}", flush=True)
        env = dict(os.environ, DB_CONNECT_METADATA_MYSQL8_FIXTURE=str(fixture))
        run([
            "cargo", "test", "--manifest-path", str(repo / "src-tauri/Cargo.toml"),
            "--lib", "metadata_mysql8_isolated_catalog_acceptance",
            "--", "--ignored", "--nocapture",
        ], cwd=repo, env=env)
    finally:
        if created:
            info = json.loads(run(["docker", "inspect", name], capture_output=True).stdout)[0]
            assert info["Config"]["Labels"]["db-connect-metadata-fixture"] == marker
            run(["docker", "rm", "--force", "--volumes", name], stdout=subprocess.DEVNULL)
            print(f"已移除自有容器及其匿名卷：{name}", flush=True)


if __name__ == "__main__":
    main()
