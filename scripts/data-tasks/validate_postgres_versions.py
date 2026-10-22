#!/usr/bin/env python3
"""PostgreSQL 10–18 多版本隔离验收：仅访问本次创建的官方容器。

默认候选 postgres:10 至 postgres:17，以 postgres:18 为参考，逐版本执行
17 项单库合约，并运行候选与参考的双向跨实例合约。示例：
python3 scripts/data-tasks/validate_postgres_versions.py --images postgres:10.23
  postgres:11.22 --reference-image postgres:18 --report artifacts/data-tasks/postgres-versions.json

--binary 可复用当前工作区的 Rust 库测试程序；省略时只构建一次。
退出码：0 全部通过且资源已清理；1 测试/清理失败或中断；2 存在未运行项目。
不读取应用保存连接。控制台和 JSON 不输出密码、连接 URL 或原始数据库错误。
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import re
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid

from validate import ROOT
from validate_mysql_versions import FixtureError, MySQLVersionValidation, positive_seconds

DEFAULT_IMAGES = [f"postgres:{major}" for major in range(10, 18)]
CROSS_TEST = "db::data_tasks::adapters::postgres::version_tests::real_postgres_cross_version_contract"
# 必须 exact：新增双实例测试也位于 postgres 模块，不能按整个模块前缀执行。
SINGLE_TESTS = (
    "db::data_tasks::adapters::postgres::tests::real_postgres_native_snapshot_and_lock_contract",
    "db::data_tasks::adapters::postgres::end_to_end_tests::real_postgres_end_to_end_merge_stale_and_rollback",
    "db::data_tasks::adapters::postgres::atomicity_tests::real_postgres_identity_sequence_lock_cancel_and_default_insert",
    "db::data_tasks::adapters::postgres::atomicity_tests::real_postgres_append_late_conflict_and_verification_failure_roll_back",
    "db::data_tasks::adapters::postgres::atomicity_tests::real_postgres_external_fk_and_inheritance_are_preflight_blocked",
    "db::data_tasks::adapters::postgres::atomicity_tests::real_postgres_inherited_rows_are_never_written_through_parent",
    "db::data_tasks::adapters::postgres::atomicity_tests::real_postgres_write_rule_is_rejected_before_preview",
    "db::data_tasks::adapters::postgres::atomicity_tests::real_postgres_rule_added_after_preview_causes_zero_write_stale_failure",
    "db::data_tasks::adapters::postgres::atomicity_tests::real_postgres_schema_usage_and_all_write_permissions_are_required",
    "db::data_tasks::cross_type_tests::real_postgres_same_type_all_modes",
    "db::data_tasks::acceptance_network_tests::real_postgres_lost_commit_ack_is_unknown_and_never_replayed",
    "db::data_tasks::acceptance_network_tests::real_postgres_stalled_commit_ack_is_bounded_and_never_replayed",
    "db::data_tasks::acceptance_network_tests::real_postgres_one_table_has_fixed_query_budget",
    "db::data_tasks::acceptance_network_tests::real_postgres_ten_tables_have_fixed_query_budget",
    "db::data_tasks::acceptance_network_tests::real_postgres_hundred_tables_have_fixed_query_budget",
    "db::data_tasks::acceptance_network_tests::real_postgres_cancel_pending_snapshot_is_bounded",
    "db::data_tasks::acceptance_network_tests::real_postgres_cancel_pending_target_lock_is_rolled_back",
)


def postgres_image(value: str) -> str:
    if not re.fullmatch(r"postgres:1[0-8](?:\.(?:0|[1-9][0-9]*))?(?:-alpine)?", value):
        raise argparse.ArgumentTypeError("镜像必须是官方 PostgreSQL 10–18 数字版本，可附加 -alpine，例如 postgres:10.23 或 postgres:18")
    return value


def postgres_tcp_ready(log: str) -> bool:
    # 官方镜像的初始化临时服务也打印 ready。最终 exec postgres 的 PID 为 1，
    # 不接受临时进程就绪，也不在探活循环执行 SQL。
    return bool(re.search(r"(?m)^.*\[1\]\s+LOG:\s+database system is ready to accept connections\s*$", log))


class PostgresVersionValidation(MySQLVersionValidation):
    scope = "disposable_official_postgres_versions_loopback"
    label = "io.db-connect.postgres-version-validation"
    resource_prefix = "db-connect-postgres-versions"

    @staticmethod
    def select_platform(_image: str, selected: str) -> str:
        if selected != "auto":
            return selected
        return "linux/arm64" if platform.machine().lower() in ("arm64", "aarch64") else "linux/amd64"

    def create_fixture(self, image: str, role: str) -> dict:
        selected_platform = self.select_platform(image, self.args.platform)
        self.prepare_image(image, selected_platform)
        major = int(image.split(":")[1].split(".")[0].split("-")[0])
        data_volume = "/var/lib/postgresql" if major >= 18 else "/var/lib/postgresql/data"
        resource = {"name": f"{self.resource_prefix}-{role}-{uuid.uuid4().hex[:16]}",
                    "image": image, "platform": selected_platform, "data_volume": data_volume,
                    "created": False, "cleaned": False}
        password = "DbTask9!" + secrets.token_hex(16)
        with tempfile.TemporaryDirectory(prefix=self.resource_prefix + "-") as temporary:
            env_file = Path(temporary) / "container.env"
            env_file.write_text(f"POSTGRES_PASSWORD={password}\n", encoding="utf-8")
            env_file.chmod(0o600)
            # 先登记唯一名称；create 被中断或超时仍会按运行标签校验并清理。
            self.resources.append(resource)
            created = self.docker("create", "--pull=never", "--name", resource["name"],
                                  "--label", f"{self.label}={self.run_id}", "--platform", selected_platform,
                                  "-p", "127.0.0.1::5432", "--volume", data_volume,
                                  "--env-file", str(env_file), image)
            if created.returncode:
                raise FixtureError("专属 PostgreSQL 容器创建失败，未接触已有容器")
            resource["created"] = True
        if self.docker("start", resource["name"]).returncode:
            raise FixtureError("专属 PostgreSQL 容器启动失败")
        binding = self.docker("port", resource["name"], "5432/tcp")
        matched = re.fullmatch(r"127\.0\.0\.1:(\d+)\s*", binding.stdout)
        if binding.returncode or not matched or not 0 < int(matched.group(1)) <= 65535:
            raise FixtureError("未能确认容器仅绑定到本机随机 TCP 端口")
        port = int(matched.group(1))
        deadline = time.monotonic() + self.args.startup_timeout
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            logs = self.docker("logs", resource["name"], timeout=max(0.01, min(remaining, self.args.docker_timeout)))
            if logs.returncode:
                raise FixtureError("无法读取专属 PostgreSQL 启动日志")
            if postgres_tcp_ready(logs.stdout) or postgres_tcp_ready(logs.stderr):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=min(1, max(0.01, remaining))):
                        resource["url"] = f"postgres://postgres:{password}@127.0.0.1:{port}/postgres"
                        return resource
                except OSError:
                    pass
            time.sleep(min(0.25, max(0, deadline - time.monotonic())))
        raise FixtureError("专属 PostgreSQL 启动超时；未执行 SQL 探活")

    def cleanup_resource(self, resource: dict):
        if resource["cleaned"]:
            return
        volumes = []
        try:
            inspected = self.docker("inspect", resource["name"])
            if inspected.returncode == 0:
                items = json.loads(inspected.stdout)
                if (isinstance(items, list) and len(items) == 1
                        and items[0].get("Name") == "/" + resource["name"]
                        and items[0].get("Config", {}).get("Labels", {}).get(self.label) == self.run_id):
                    volumes = [mount["Name"] for mount in items[0].get("Mounts", [])
                               if mount.get("Type") == "volume" and mount.get("Destination") == resource["data_volume"]
                               and isinstance(mount.get("Name"), str) and mount["Name"]]
        except (OSError, ValueError, TypeError, AttributeError, subprocess.TimeoutExpired, KeyboardInterrupt):
            pass
        # 保留共用实现的运行标签检查、rm -v 与失败裁决，再核对本次匿名数据卷消失。
        super().cleanup_resource(resource)
        result = self.cleanup_results[-1]
        if result["status"] != "removed":
            return
        try:
            remaining = self.docker("volume", "ls", "--format", "{{.Name}}")
            if volumes and remaining.returncode == 0 and not set(volumes).intersection(remaining.stdout.splitlines()):
                return
        except (OSError, subprocess.TimeoutExpired, KeyboardInterrupt):
            pass
        result.update(status="failed", anonymous_data_volume="unconfirmed")
        print(f"failed  cleanup: {resource['name']} 的匿名数据卷未确认清理", flush=True)

    def contract(self, name: str, source: dict, target: dict | None = None):
        environment = {key: value for key, value in os.environ.items() if not key.startswith("DB_CONNECT_DATA_TASK_")}
        environment["DB_CONNECT_DATA_TASK_PG_URL"] = source["url"]
        metadata = {"image": source["image"], "docker_platform": source["platform"]}
        if target:
            environment["DB_CONNECT_DATA_TASK_PG_TARGET_URL"] = target["url"]
            self.tests(name, CROSS_TEST, env=environment, ignored=True, exact=True, inherit_env=False,
                       timeout=self.args.test_timeout, required_metrics=("source_server_version", "target_server_version"))
            self.results[-1].update(**metadata, target_image=target["image"])
            return
        cases = []
        for index, test_filter in enumerate(SINGLE_TESTS):
            self.tests(name + ":" + test_filter.rsplit("::", 1)[-1], test_filter,
                       env=environment, ignored=True, exact=True, inherit_env=False,
                       timeout=self.args.test_timeout, required_metrics=("server_version",) if index == 0 else ())
            case = self.results.pop()
            case["test_filter"] = test_filter
            cases.append(case)
        status = ("failed" if any(case["status"] == "failed" for case in cases)
                  else "not_run" if any(case["status"] != "passed" for case in cases) else "passed")
        if "server_version" in cases[0]:
            metadata["server_version"] = cases[0]["server_version"]
        self.record(name, status, f"{sum(case['status'] == 'passed' for case in cases)}/{len(SINGLE_TESTS)} 项 PostgreSQL 单库合约通过",
                    **metadata, cases=cases, elapsed_seconds=round(sum(case["elapsed_seconds"] for case in cases), 3))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--images", type=postgres_image, nargs="+", default=DEFAULT_IMAGES)
    parser.add_argument("--reference-image", type=postgres_image, default="postgres:18")
    parser.add_argument("--binary", type=Path, help="复用当前工作区构建的 Rust 库测试程序")
    parser.add_argument("--report", type=Path, default=ROOT / "artifacts/data-tasks/postgres-versions.json")
    parser.add_argument("--platform", choices=("auto", "linux/amd64", "linux/arm64"), default="auto")
    parser.add_argument("--no-pull", action="store_true", help="只使用本地镜像，禁止隐式下载")
    for name, default in (("startup", 180), ("test", 300), ("docker", 60), ("pull", 600), ("build", 900)):
        parser.add_argument(f"--{name}-timeout", type=positive_seconds, default=default, metavar="SECONDS")
    args = parser.parse_args()
    args.images = list(dict.fromkeys(args.images))
    reference_major = args.reference_image.split(":")[1].split(".")[0].split("-")[0]
    if any(image.split(":")[1].split(".")[0].split("-")[0] == reference_major for image in args.images):
        parser.error("参考镜像与候选镜像必须是不同 PostgreSQL 主版本；参考实例会单独执行单库验收")
    args.skip_performance = True

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, interrupted)
    return PostgresVersionValidation(args).run()


if __name__ == "__main__":
    sys.exit(main())
