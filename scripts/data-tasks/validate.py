#!/usr/bin/env python3
"""数据任务隔离验收。只创建专属容器，不读取应用保存连接。

退出码：0 全部通过；1 测试失败；2 环境/未实现项目未运行。
JSON 报告不包含连接 URL、密码或数据内容。
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "src-tauri" / "Cargo.toml"
REAL_PREFIX = "db::data_tasks::adapters::{driver}::"
SERVICES = {
    "postgres": ("postgres:17-alpine", 5432, {"POSTGRES_PASSWORD": "{password}"}),
    "mysql": ("mysql:8.4", 3306, {"MYSQL_ROOT_PASSWORD": "{password}", "MYSQL_ROOT_HOST": "%"}),
    "mariadb": ("mariadb:11.4", 3306, {"MARIADB_ROOT_PASSWORD": "{password}", "MARIADB_ROOT_HOST": "%"}),
    "sqlserver": ("mcr.microsoft.com/mssql/server:2022-latest", 1433, {"ACCEPT_EULA": "Y", "MSSQL_SA_PASSWORD": "{password}"}),
    "clickhouse": ("clickhouse/clickhouse-server:25.8", 8123, {"CLICKHOUSE_PASSWORD": "{password}", "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT": "1"}),
}
ENV_NAMES = {"postgres": "DB_CONNECT_DATA_TASK_PG_URL", "mysql": "DB_CONNECT_DATA_TASK_MYSQL_URL",
             "mariadb": "DB_CONNECT_DATA_TASK_MARIADB_URL", "sqlserver": "DB_CONNECT_DATA_TASK_SQLSERVER_URL",
             "clickhouse": "DB_CONNECT_DATA_TASK_CLICKHOUSE_URL"}


class Validation:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.results: list[dict] = []
        self.containers: list[str] = []
        self.binary: Path | None = None
        self.urls: dict[str, str] = {}

    def record(self, name: str, status: str, detail: str, **metrics):
        self.results.append({"name": name, "status": status, "detail": detail, **metrics})
        print(f"{status:7} {name}: {detail}", flush=True)

    def build(self) -> bool:
        print("正在构建隔离验收测试程序…", flush=True)
        build_flags = [] if self.args.skip_performance else ["--release"]
        result = subprocess.run(["cargo", "test", "--manifest-path", str(MANIFEST), "--lib", "--no-run", "--message-format=json", *build_flags],
                                cwd=ROOT, capture_output=True, text=True)
        if result.returncode:
            # 编译诊断只含代码位置，不回显环境变量或连接 URI。
            print(result.stderr[-12000:], file=sys.stderr)
            self.record("rust_build", "failed", "Rust 测试程序编译失败")
            return False
        for line in result.stdout.splitlines():
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if item.get("reason") == "compiler-artifact" and item.get("profile", {}).get("test") and item.get("executable") and item.get("target", {}).get("name") == "db_connect_lib":
                self.binary = Path(item["executable"])
        if not self.binary:
            self.record("rust_build", "failed", "构建未返回库测试程序")
            return False
        self.record("rust_build", "passed", "已构建当前工作区测试程序")
        return True

    def tests(self, name: str, test_filter: str, *, env: dict[str, str] | None = None, ignored=False, measure=False) -> dict | None:
        assert self.binary
        args = [str(self.binary), test_filter, "--nocapture", "--test-threads=1"]
        if ignored:
            args.append("--ignored")
        if measure and Path("/usr/bin/time").exists():
            args = ["/usr/bin/time", "-l" if sys.platform == "darwin" else "-v", *args]
        process_env = os.environ.copy()
        process_env.update(env or {})
        start = time.monotonic()
        result = subprocess.run(args, cwd=ROOT, env=process_env, capture_output=True, text=True)
        output = result.stdout + "\n" + result.stderr
        summary = re.search(r"test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored", output)
        metrics = {"elapsed_seconds": round(time.monotonic() - start, 3)}
        data = re.search(r"DATA_TASK_METRICS ([^\n]+)", output)
        if data:
            for key, value in re.findall(r"(\w+)=(\d+)", data.group(1)):
                metrics[key] = int(value)
        mac_rss = re.search(r"(\d+)\s+maximum resident set size", output)
        linux_rss = re.search(r"Maximum resident set size \(kbytes\):\s*(\d+)", output)
        if mac_rss:
            metrics["max_rss_bytes"] = int(mac_rss.group(1))
        elif linux_rss:
            metrics["max_rss_bytes"] = int(linux_rss.group(1)) * 1024
        if not summary or int(summary.group(1)) + int(summary.group(2)) == 0:
            self.record(name, "not_run" if result.returncode == 0 else "failed", "没有匹配的真实测试，不能视为通过", **metrics)
            return None
        passed, failed, skipped = map(int, summary.groups())
        if result.returncode or failed:
            # 不打印真实驱动错误正文，避免测试依赖把连接信息带入输出。
            self.record(name, "failed", f"{passed} 通过，{failed} 失败；请单独运行对应 Rust 测试检查脱敏诊断", **metrics)
            return None
        self.record(name, "passed", f"{passed} 通过，{skipped} 个显式忽略的测试另行验收", **metrics)
        return metrics

    def docker_url(self, driver: str) -> str | None:
        image, port, variables = SERVICES[driver]
        if not shutil.which("docker") or subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"], capture_output=True).returncode:
            self.record(driver, "not_run", "Docker 不可用，且未提供专属隔离库环境变量")
            return None
        if self.args.no_pull and subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode:
            self.record(driver, "not_run", "本机没有指定数据库镜像，--no-pull 禁止下载")
            return None
        name = f"db-connect-data-task-validate-{driver}-{uuid.uuid4().hex[:10]}"
        password = "DbTask9!" + secrets.token_hex(12)
        command = ["docker", "run", "--rm", "-d", "--name", name, "--label", "io.db-connect.data-task-validation=true", "-p", f"127.0.0.1::{port}"]
        if driver == "sqlserver":
            command += ["--platform", "linux/amd64"]
        for key, value in variables.items():
            command += ["-e", f"{key}={value.format(password=password)}"]
        result = subprocess.run([*command, image], capture_output=True, text=True)
        if result.returncode:
            self.record(driver, "not_run", "专属数据库容器启动失败，未接触已有容器")
            return None
        self.containers.append(name)
        binding = subprocess.run(["docker", "port", name, f"{port}/tcp"], capture_output=True, text=True)
        try:
            local_port = int(binding.stdout.strip().rsplit(":", 1)[1])
        except (ValueError, IndexError):
            self.record(driver, "not_run", "无法读取专属容器的本地随机端口")
            return None
        deadline = time.monotonic() + 90
        ready = False
        while time.monotonic() < deadline:
            # 只探测 TCP，不在轮询中执行 SQL。
            try:
                with socket.create_connection(("127.0.0.1", local_port), timeout=1):
                    ready = True
                    break
            except OSError:
                time.sleep(0.25)
        if not ready:
            self.record(driver, "not_run", "专属数据库未在 90 秒内监听端口")
            return None
        # 数据库进程可能在监听后继续初始化。真实测试负责登录，不用循环 SELECT 探活。
        time.sleep(3)
        if driver == "postgres":
            return f"postgres://postgres:{password}@127.0.0.1:{local_port}/postgres"
        if driver in ("mysql", "mariadb"):
            return f"mysql://root:{password}@127.0.0.1:{local_port}/mysql"
        if driver == "sqlserver":
            return f"sqlserver://sa:{password}@127.0.0.1:{local_port}/master"
        return f"http://default:{password}@127.0.0.1:{local_port}"

    def real_driver(self, driver: str):
        url = self.urls.get(driver) or os.environ.get(ENV_NAMES[driver])
        if not url and self.args.no_docker:
            self.record(driver, "not_run", "未提供专属隔离库环境变量，且 --no-docker 禁止创建容器")
            return
        url = url or self.docker_url(driver)
        if url:
            self.urls[driver] = url
            module = "mysql" if driver == "mariadb" else driver
            environment = self.driver_environment()
            if driver == "mariadb":
                environment[ENV_NAMES["mysql"]] = url
            test_filter = (f"db::data_tasks::adapters::mysql::tests::real_{driver}_session_contract"
                           if driver in ("mysql", "mariadb") else REAL_PREFIX.format(driver=module))
            self.tests("clickhouse_native_and_source" if driver == "clickhouse" else driver, test_filter, env=environment, ignored=True)
            if driver == "postgres":
                self.tests("postgres_modes", "data_tasks::cross_type_tests::real_postgres_same_type_all_modes", env=environment, ignored=True)
                self.tests("postgres_network_fault_and_query_budget", "data_tasks::acceptance_network_tests::", env=environment, ignored=True)
            if driver == "sqlserver":
                self.tests("sqlserver_modes_and_cancel", "data_tasks::cross_type_tests::real_sqlserver_same_type_executor_and_cancel", env=environment, ignored=True)

    def driver_environment(self) -> dict[str, str]:
        return {ENV_NAMES[driver]: url for driver, url in self.urls.items()}

    def cleanup(self):
        for name in self.containers[:]:
            result = subprocess.run(["docker", "rm", "-f", name], capture_output=True)
            if result.returncode:
                self.record("container_cleanup", "failed", f"无法移除本次创建的专属容器 {name}")
            self.containers.remove(name)

    def run(self) -> int:
        try:
            if self.build():
                self.tests("core_contracts", "data_tasks::")
                if self.args.skip_performance:
                    self.record("sqlite_performance", "not_run", "显式跳过百万行与 RSS 比较")
                else:
                    small = self.tests("sqlite_100k", "acceptance_tests::sqlite_million_rows_transfer_is_complete", env={"DB_CONNECT_DATA_TASK_PERF_ROWS": "100000"}, ignored=True, measure=True)
                    large = self.tests("sqlite_1m", "acceptance_tests::sqlite_million_rows_transfer_is_complete", env={"DB_CONNECT_DATA_TASK_PERF_ROWS": "1000000"}, ignored=True, measure=True)
                    if small and large and "max_rss_bytes" in small and "max_rss_bytes" in large:
                        bounded = large["max_rss_bytes"] <= small["max_rss_bytes"] + 64 * 1024 * 1024
                        self.record("rss_growth", "passed" if bounded else "failed", "同宽行从十万增至百万，RSS 增量预算 64 MiB", rss_100k=small["max_rss_bytes"], rss_1m=large["max_rss_bytes"])
                    else:
                        self.record("rss_growth", "not_run", "缺少两组可比 RSS 测量")
                for driver in ("postgres", "mysql", "mariadb", "sqlserver"):
                    self.real_driver(driver)
                if self.args.phase in ("b", "c"):
                    missing = sorted(set(("postgres", "mysql", "sqlserver")) - self.urls.keys())
                    if missing:
                        self.record("cross_type_matrix", "not_run", "跨类型矩阵缺少专属实例：" + ", ".join(missing))
                    else:
                        self.tests("cross_type_matrix", "data_tasks::cross_type_tests::real_", env=self.driver_environment(), ignored=True)
                if self.args.phase == "c":
                    missing = sorted(set(("postgres", "mysql", "sqlserver")) - self.urls.keys())
                    if missing:
                        self.record("clickhouse", "not_run", "ClickHouse 有向矩阵缺少专属实例：" + ", ".join(missing))
                    else:
                        self.real_driver("clickhouse")
                    self.record("clickhouse_target", "not_run", "目标批次间无法锁定物理表身份，后端禁止 ClickHouse 目标；仅验收源端受限追加")
        finally:
            self.cleanup()
        report = {"phase": self.args.phase, "platform": platform.platform(), "results": self.results}
        if self.args.report:
            self.args.report.parent.mkdir(parents=True, exist_ok=True)
            self.args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if any(r["status"] == "failed" for r in self.results):
            return 1
        return 2 if any(r["status"] == "not_run" for r in self.results) else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=("a", "b", "c"), required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--no-docker", action="store_true", help="只使用明确提供的专属测试库环境变量")
    parser.add_argument("--no-pull", action="store_true", help="没有本地镜像时标记未运行")
    parser.add_argument("--skip-performance", action="store_true")
    args = parser.parse_args()
    return Validation(args).run()


if __name__ == "__main__":
    sys.exit(main())
