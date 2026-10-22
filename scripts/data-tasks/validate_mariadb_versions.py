#!/usr/bin/env python3
"""MariaDB 多版本隔离验收：仅创建本次专属官方数据库容器。

默认验收 MariaDB 10.0–10.11、11.0–11.8、12.0–12.3，并与 mysql:8.4 参考实例双向传输。
可用 --images 明确选择数字版本；列表只代表待验收范围，不代表已验证支持。
示例：python3 scripts/data-tasks/validate_mariadb_versions.py
  --images mariadb:11.8 mariadb:12.0 --reference-image mariadb:11.4
  --report artifacts/data-tasks/mariadb-versions.json

--binary 复用当前工作区的 Rust 库测试程序；省略时只构建一次。
退出码：0 全部通过且资源已清理；1 测试/清理失败或中断；2 存在未运行项目。
不读取应用连接或业务 URL；JSON 和控制台不输出密码、连接 URL 或原始驱动错误。
"""
from __future__ import annotations

import argparse
from pathlib import Path
import re
import signal
import sys

from validate import ROOT
from validate_mysql_versions import MySQLVersionValidation, image_platform, mysql_image, positive_seconds

DEFAULT_IMAGES = [*(f"mariadb:10.{minor}" for minor in range(12)),
                  *(f"mariadb:11.{minor}" for minor in range(9)),
                  *(f"mariadb:12.{minor}" for minor in range(4))]
SINGLE_TEST = "db::data_tasks::adapters::mysql::tests::real_mariadb_session_contract"


def mariadb_image(value: str) -> str:
    if not re.fullmatch(r"mariadb:\d+\.\d+(?:\.\d+)?", value):
        raise argparse.ArgumentTypeError("镜像必须是官方 mariadb:<数字版本>，例如 mariadb:11.4 或 mariadb:11.8.3")
    return value


def reference_image(value: str) -> str:
    if value.startswith("mysql:"):
        return mysql_image(value)
    return mariadb_image(value)


class MariaDBVersionValidation(MySQLVersionValidation):
    scope = "disposable_official_mariadb_versions_loopback"
    label = "io.db-connect.mariadb-version-validation"
    resource_prefix = "db-connect-mariadb-versions"

    @staticmethod
    def select_platform(image: str, selected: str) -> str:
        # 历史 MariaDB 标签保守使用 amd64，显式 --platform 可覆盖。
        if selected == "auto" and image.startswith("mariadb:"):
            version = tuple(map(int, image.split(":")[1].split(".")))
            if version[:2] < (10, 6):
                return "linux/amd64"
        return image_platform(image, selected)

    def single_contract(self, image: str) -> tuple[str, str]:
        if image.startswith("mariadb:"):
            return SINGLE_TEST, "DB_CONNECT_DATA_TASK_MARIADB_URL"
        return super().single_contract(image)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--images", type=mariadb_image, nargs="+", default=DEFAULT_IMAGES,
                        help="显式选择的官方 MariaDB 版本列表；默认覆盖 10.0–10.11、11.0–11.8、12.0–12.3")
    parser.add_argument("--reference-image", type=reference_image, default="mysql:8.4",
                        help="官方 MySQL 或 MariaDB 参考实例；默认 mysql:8.4")
    parser.add_argument("--binary", type=Path, help="复用当前工作区编译的 Rust 库测试程序")
    parser.add_argument("--report", type=Path, default=ROOT / "artifacts/data-tasks/mariadb-versions.json")
    parser.add_argument("--platform", choices=("auto", "linux/amd64", "linux/arm64"), default="auto")
    parser.add_argument("--no-pull", action="store_true", help="只用本地镜像，并禁止 docker create 隐式下载")
    for name, default in (("startup", 180), ("test", 300), ("docker", 60), ("pull", 600), ("build", 900)):
        parser.add_argument(f"--{name}-timeout", type=positive_seconds, default=default, metavar="SECONDS")
    args = parser.parse_args()
    args.images = list(dict.fromkeys(args.images))
    if args.reference_image in args.images:
        parser.error("参考镜像不能同时出现在候选版本列表中；参考实例会单独执行单库验收")
    args.skip_performance = True

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, interrupted)
    return MariaDBVersionValidation(args).run()


if __name__ == "__main__":
    sys.exit(main())
