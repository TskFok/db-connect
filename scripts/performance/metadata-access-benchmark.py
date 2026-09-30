#!/usr/bin/env python3
"""仅在自己启动的 MySQL 5.7 临时实例测量目录集合查询和分页元数据缓存。

每个样本由单个 Rust 测试调用生产路径；Python 重复独立样本，不循环发 SQL。
旧接口只测单库，旧多库路径的 N 次 IPC/SQL 仅作源码计数，不伪造延迟。
输出只含时间、数量和环境信息；不读取应用配置、不连接业务实例。
"""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import math
import platform
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("isolated_mysql_helpers", Path(__file__).with_name("mysql-cancellation-benchmark.py"))
HELPERS = importlib.util.module_from_spec(SPEC)
sys.dont_write_bytecode = True
SPEC.loader.exec_module(HELPERS)


def sample(fixture, env, name, marker, **settings):
    command = ["cargo", "test", "--offline", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--lib", name, "--", "--ignored", "--nocapture", "--test-threads=1"]
    sample_env = dict(env, DB_CONNECT_METADATA_FIXTURE=str(fixture), **settings)
    code, text = HELPERS.run_captured(command, sample_env, "sample", 900, cwd=ROOT)
    matches = [line.split(marker, 1)[1] for line in text.splitlines() if marker in line]
    if code or len(matches) != 1:
        raise RuntimeError("隔离测量未通过，未保存包含 SQL 的原始测试输出")
    return json.loads(matches[0]) if marker != "METADATA_PERMISSIONS " else {"passed": True}


def stats(rows, key):
    values = sorted(row[key] for row in rows)
    return {"samples": len(values), "p50": values[math.ceil(.5*len(values))-1], "p95": values[math.ceil(.95*len(values))-1]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mysqld", type=Path, required=True)
    parser.add_argument("--samples", type=HELPERS.positive_int, default=20)
    parser.add_argument("--output", type=Path, default=Path("/private/tmp"))
    args = parser.parse_args()
    mysqld = args.mysqld.resolve(strict=True)
    fixture = Path(tempfile.mkdtemp(prefix="db-connect-metadata-", dir="/private/tmp"))
    (fixture / "data").mkdir(mode=0o700)
    env = HELPERS.fixture_environment(fixture)
    code, version = HELPERS.run_captured([str(mysqld), "--no-defaults", "--version"], env, "version", 15)
    match = re.search(r"\bVer\s+(5\.7\.\d+)\b", version)
    if code or not match:
        raise RuntimeError("仅支持已安装 MySQL 5.7")
    code, _ = HELPERS.run_captured([str(mysqld), "--no-defaults", "--initialize-insecure", "--basedir="+str(mysqld.parent.parent), "--datadir="+str(fixture/"data"), "--log-error="+str(fixture/"initialize.log"), "--innodb-buffer-pool-size=32M", "--innodb-log-file-size=8M"], env, "initialize", 120)
    if code:
        raise RuntimeError("隔离实例初始化失败")
    port = HELPERS.allocate_loopback_port()
    server = None
    try:
        with (fixture/"launcher.log").open("ab") as log:
            server = subprocess.Popen(HELPERS.server_arguments(mysqld, fixture, port), env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        HELPERS.wait_until_ready(server, mysqld.parent/"mysqladmin", fixture, env)
        HELPERS.write_json(fixture/"fixture.json", {"port": port, "pid": server.pid})
        # 循环只构造夹具 DDL；一次调用执行全部初始化语句。
        ddl = [f'CREATE DATABASE `metadata_{i:03}`; CREATE TABLE `metadata_{i:03}`.items (id BIGINT PRIMARY KEY, value VARCHAR(40)) COMMENT="fixture";' for i in range(100)]
        ddl += ['CREATE VIEW metadata_000.item_view AS SELECT id FROM metadata_000.items;', 'CREATE DATABASE metadata_empty;', 'CREATE DATABASE `metadata\'quote``"]|fixture`;', 'CREATE TABLE `metadata\'quote``"]|fixture`.items (id INT);', "CREATE USER 'metadata_limited'@'127.0.0.1'; GRANT SELECT ON metadata_000.items TO 'metadata_limited'@'127.0.0.1';", "CREATE USER 'metadata_show_only'@'127.0.0.1'; GRANT SHOW DATABASES ON *.* TO 'metadata_show_only'@'127.0.0.1';"]
        created = subprocess.run([str(mysqld.parent/"mysql"), "--no-defaults", "--protocol=SOCKET", "--socket="+str(fixture/"mysql.sock"), "--user=root"], input="\n".join(ddl), text=True, env=env, capture_output=True, check=False)
        if created.returncode:
            raise RuntimeError("合成数据创建失败")
        permissions = sample(fixture, env, "metadata_access_isolated_permissions", "METADATA_PERMISSIONS ")
        catalog = []
        pagination = []
        for variant, count in (("legacy-single", 1), ("batch", 1), ("batch", 10), ("batch", 100)):
            for _ in range(args.samples):
                catalog.append(sample(fixture, env, "metadata_access_isolated_sample", "METADATA_BENCH ", DB_CONNECT_METADATA_DATABASES=str(count), DB_CONNECT_METADATA_VARIANT=variant))
            print(json.dumps({"variant":variant,"databases":count,"samples":args.samples}), flush=True)
        for _ in range(args.samples):
            pagination.append(sample(fixture, env, "metadata_access_isolated_pagination", "METADATA_PAGINATION "))
        summary = [{"variant": v,"databases": n, **stats([r for r in catalog if r["variant"]==v and r["databases"]==n], "elapsed_ms")} for v,n in (("legacy-single",1),("batch",1),("batch",10),("batch",100))]
        evidence = {"run_id":uuid.uuid4().hex,"date":datetime.now(timezone.utc).isoformat(),"server_version":match[1],"profile":"debug","platform":platform.system(),"architecture":platform.machine(),"pool_max":1,"mysql_async_version":"0.37.0","percentile":"nearest-rank","scope":"本地隔离MySQL，热物理连接；目录IPC及数据查询不在计时内；每样本新池，集合语句首次执行", "permissions":permissions,"catalog_summary_ms":summary,"pagination_summary_ms":{"cold":stats(pagination,"cold_ms"),"warm":stats(pagination,"warm_ms")},"catalog_samples":catalog,"pagination_samples":pagination}
        args.output.mkdir(parents=True,exist_ok=True)
        destination = args.output / ("metadata-access-"+evidence["run_id"]+".json")
        HELPERS.write_json(destination, evidence)
        print(str(destination),flush=True)
    finally:
        if server is not None:
            HELPERS.stop_owned_process(server)


if __name__ == "__main__":
    main()
