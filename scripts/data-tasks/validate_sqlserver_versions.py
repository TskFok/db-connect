#!/usr/bin/env python3
"""SQL Server 2017–2025 多版本隔离验收，仅访问本次创建的官方容器。

默认候选 2017/2019/2022-latest，参考 2025-latest，固定 linux/amd64。
每个版本运行五项单库合约，候选与参考运行双向跨实例合约。
--binary 可复用当前工作区的 Rust 测试程序；省略时只构建一次。
就绪循环只检查日志/TCP，随后一次 SQL 配置 master 快照隔离。
控制台与报告不输出密码、连接 URL 或原始数据库错误。
退出码：0 全部通过且清理成功；1 测试/清理失败或中断；2 存在未运行项目。
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
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
from validate_mysql_versions import FixtureError, positive_seconds
from validate_postgres_versions import PostgresVersionValidation

IMAGE_PREFIX = "mcr.microsoft.com/mssql/server:"
DEFAULT_IMAGES = [IMAGE_PREFIX + year + "-latest" for year in ("2017", "2019", "2022")]
VERSION_TEST = "db::data_tasks::adapters::sqlserver::version_tests::real_sqlserver_version_contract"
CROSS_TEST = "db::data_tasks::adapters::sqlserver::version_tests::real_sqlserver_cross_version_contract"
SINGLE_TESTS = (
    "db::data_tasks::adapters::sqlserver::native_tests::real_sqlserver_rejects_invisible_external_foreign_keys",
    "db::data_tasks::adapters::sqlserver::native_tests::real_sqlserver_rejects_invisible_external_row_security",
    "db::data_tasks::adapters::sqlserver::native_tests::real_sqlserver_native_lossless_snapshot_identity_and_protected_rollback",
    "db::data_tasks::cross_type_tests::real_sqlserver_same_type_executor_and_cancel",
    VERSION_TEST,
)


def sqlserver_image(value: str) -> str:
    if not re.fullmatch(re.escape(IMAGE_PREFIX) + r"(?:2017|2019|2022|2025)-latest", value):
        raise argparse.ArgumentTypeError("镜像必须是官方 mcr.microsoft.com/mssql/server 的 2017/2019/2022/2025-latest")
    return value


def matches_image_version(image: str, version: str) -> bool:
    expected_major = {"2017": "14", "2019": "15", "2022": "16", "2025": "17"}[image.rsplit(":", 1)[1].split("-", 1)[0]]
    return version.split(".", 1)[0] == expected_major


class SQLServerVersionValidation(PostgresVersionValidation):
    # 复用既有隔离编排，以及所有权校验、rm -v 后确认匿名卷消失的清理逻辑。
    scope = "disposable_official_sqlserver_versions_loopback"
    label = "io.db-connect.sqlserver-version-validation"
    resource_prefix = "db-connect-sqlserver-versions"

    @staticmethod
    def select_platform(_image: str, _selected: str) -> str:
        return "linux/amd64"

    def prepare_image(self, image: str, selected_platform: str):
        super().prepare_image(image, selected_platform)
        if self.prepared_images[(image, selected_platform)]["architecture"] != "amd64":
            raise FixtureError("SQL Server 隔离镜像必须为 linux/amd64")

    def create_fixture(self, image: str, role: str) -> dict:
        selected_platform = "linux/amd64"
        self.prepare_image(image, selected_platform)
        resource = {"name": f"{self.resource_prefix}-{role}-{uuid.uuid4().hex[:16]}",
                    "image": image, "platform": selected_platform, "data_volume": "/var/opt/mssql",
                    "created": False, "cleaned": False}
        password = "DbTask9!" + secrets.token_hex(16)
        with tempfile.TemporaryDirectory(prefix=self.resource_prefix + "-") as temporary:
            env_file = Path(temporary) / "container.env"
            env_file.write_text(f"ACCEPT_EULA=Y\nMSSQL_PID=Developer\nMSSQL_MEMORY_LIMIT_MB=2048\nMSSQL_SA_PASSWORD={password}\n", encoding="utf-8")
            env_file.chmod(0o600)
            self.resources.append(resource)
            created = self.docker("create", "--pull=never", "--name", resource["name"],
                                  "--label", f"{self.label}={self.run_id}", "--platform", selected_platform,
                                  "-p", "127.0.0.1::1433", "--volume", resource["data_volume"],
                                  "--memory", "2560m", "--cpus", "2", "--env-file", str(env_file), image)
            if created.returncode:
                raise FixtureError("专属 SQL Server 容器创建失败，未接触已有容器")
            resource["created"] = True
        if self.docker("start", resource["name"]).returncode:
            raise FixtureError("专属 SQL Server 容器启动失败")
        binding = self.docker("port", resource["name"], "1433/tcp")
        matched = re.fullmatch(r"127\.0\.0\.1:(\d+)\s*", binding.stdout)
        if binding.returncode or not matched or not 0 < int(matched.group(1)) <= 65535:
            raise FixtureError("未能确认容器仅绑定到本机随机 TCP 端口")
        port = int(matched.group(1))
        deadline = time.monotonic() + self.args.startup_timeout
        ready = False
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            logs = self.docker("logs", resource["name"], timeout=max(0.01, min(remaining, self.args.docker_timeout)))
            if logs.returncode:
                raise FixtureError("无法读取专属 SQL Server 启动日志")
            startup_log = logs.stdout + logs.stderr
            # SQL Server 2025 的 ready/TCP 早于恢复完成，窗口内 sa 登录可能失败。
            # 等待恢复完成日志后只初始化一次，不以失败 SQL 重试来探活。
            if ("SQL Server is now ready for client connections" in startup_log
                    and "Recovery is complete." in startup_log):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=min(1, max(0.01, remaining))):
                        ready = True
                        break
                except OSError:
                    pass
            time.sleep(min(0.25, max(0, deadline - time.monotonic())))
        if not ready:
            raise FixtureError("专属 SQL Server 启动超时；未执行 SQL 探活")
        # 老镜像提供 mssql-tools，新镜像提供 mssql-tools18；只选工具，不重试 SQL。
        sqlcmd = ('if [ -x /opt/mssql-tools18/bin/sqlcmd ]; then '
                  'exec /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -d master -C -b; '
                  'elif [ -x /opt/mssql-tools/bin/sqlcmd ]; then '
                  'exec /opt/mssql-tools/bin/sqlcmd -S localhost -U sa -d master -C -b; '
                  'else exit 127; fi')
        prepared = subprocess.run(["docker", "exec", "--interactive", "--env", "SQLCMDPASSWORD", resource["name"],
                                   "/bin/sh", "-c", sqlcmd],
                                  env=dict(os.environ, SQLCMDPASSWORD=password), capture_output=True, text=True,
                                  input="ALTER DATABASE [master] SET ALLOW_SNAPSHOT_ISOLATION ON;\nGO\n",
                                  timeout=self.args.docker_timeout)
        if prepared.returncode:
            raise FixtureError("专属 SQL Server 快照隔离初始化失败；未重试 SQL")
        resource["url"] = f"sqlserver://sa:{password}@127.0.0.1:{port}/master"
        return resource

    def contract(self, name: str, source: dict, target: dict | None = None):
        environment = {key: value for key, value in os.environ.items() if not key.startswith("DB_CONNECT_DATA_TASK_")}
        environment["DB_CONNECT_DATA_TASK_SQLSERVER_URL"] = source["url"]
        metadata = {"image": source["image"], "docker_platform": source["platform"]}
        if target:
            environment["DB_CONNECT_DATA_TASK_SQLSERVER_TARGET_URL"] = target["url"]
            self.tests(name, CROSS_TEST, env=environment, ignored=True, exact=True, inherit_env=False,
                       timeout=self.args.test_timeout, required_metrics=("source_server_version", "target_server_version"))
            result = self.results[-1]
            result.update(**metadata, target_image=target["image"])
            if result["status"] == "passed" and not (
                    matches_image_version(source["image"], result["source_server_version"])
                    and matches_image_version(target["image"], result["target_server_version"])):
                result.update(status="failed", detail="跨版本源端或目标端实际主版本与镜像系列不符")
                print(f"failed  {name}: {result['detail']}", flush=True)
            return
        cases = []
        for test_filter in SINGLE_TESTS:
            self.tests(name + ":" + test_filter.rsplit("::", 1)[-1], test_filter,
                       env=environment, ignored=True, exact=True, inherit_env=False,
                       timeout=self.args.test_timeout, required_metrics=("server_version",) if test_filter == VERSION_TEST else ())
            case = self.results.pop()
            case["test_filter"] = test_filter
            if test_filter == VERSION_TEST and case["status"] == "passed" and not matches_image_version(source["image"], case["server_version"]):
                case.update(status="failed", detail="服务器实际主版本与镜像系列不符")
            cases.append(case)
            if "server_version" in case:
                metadata["server_version"] = case["server_version"]
        status = ("failed" if any(case["status"] == "failed" for case in cases)
                  else "not_run" if any(case["status"] != "passed" for case in cases) else "passed")
        self.record(name, status, f"{sum(case['status'] == 'passed' for case in cases)}/{len(SINGLE_TESTS)} 项 SQL Server 单库合约通过",
                    **metadata, cases=cases, elapsed_seconds=round(sum(case["elapsed_seconds"] for case in cases), 3))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--images", type=sqlserver_image, nargs="+", default=DEFAULT_IMAGES)
    parser.add_argument("--reference-image", type=sqlserver_image, default=IMAGE_PREFIX + "2025-latest")
    parser.add_argument("--binary", type=Path, help="复用当前工作区构建的 Rust 库测试程序")
    parser.add_argument("--report", type=Path, default=ROOT / "artifacts/data-tasks/sqlserver-versions.json")
    parser.add_argument("--platform", choices=("linux/amd64",), default="linux/amd64")
    parser.add_argument("--no-pull", action="store_true", help="只使用本地镜像，禁止隐式下载")
    for name, default in (("startup", 180), ("test", 300), ("docker", 60), ("pull", 600), ("build", 900)):
        parser.add_argument(f"--{name}-timeout", type=positive_seconds, default=default, metavar="SECONDS")
    args = parser.parse_args()
    args.images = list(dict.fromkeys(args.images))
    if args.reference_image in args.images:
        parser.error("参考镜像与候选镜像必须是不同 SQL Server 主版本；参考实例会单独执行单库验收")
    args.skip_performance = True

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, interrupted)
    return SQLServerVersionValidation(args).run()


if __name__ == "__main__":
    sys.exit(main())
