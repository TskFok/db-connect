#!/usr/bin/env python3
"""MySQL 多版本隔离验收：仅使用本次创建的官方 MySQL 容器。

示例：python3 scripts/data-tasks/validate_mysql_versions.py --images
mysql:5.5.62 mysql:5.6.51 mysql:5.7.19 mysql:5.7.44
mysql:8.0.11 mysql:8.0.36 mysql:8.0.46 mysql:8.4
--reference-image mysql:9.7 --report artifacts/data-tasks/mysql-versions.json

--binary 可复用当前工作区的 Rust 库测试程序；省略时只构建一次。
退出码：0 全部通过且资源已清理；1 测试/清理失败或中断；2 存在未运行项目。
不读取应用连接或业务 URL；JSON 和控制台不输出密码、连接 URL 或原始驱动错误。
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid

from validate import ROOT, Validation, verdict

SINGLE_TEST = "db::data_tasks::adapters::mysql::tests::real_mysql_session_contract"
CROSS_TEST = "db::data_tasks::adapters::mysql::version_tests::real_mysql_cross_version_contract"
LABEL = "io.db-connect.mysql-version-validation"


class FixtureError(Exception):
    """只允许固定、脱敏的错误描述。"""


def mysql_image(value: str) -> str:
    if not re.fullmatch(r"mysql:\d+\.\d+(?:\.\d+)?", value):
        raise argparse.ArgumentTypeError("镜像必须是官方 mysql:<数字版本>，例如 mysql:5.7.44 或 mysql:8.4")
    return value


def positive_seconds(value: str) -> float:
    parsed = float(value)
    if not 0 < parsed < float("inf"):
        raise argparse.ArgumentTypeError("超时必须为正数")
    return parsed


def image_platform(image: str, selected: str) -> str:
    if selected != "auto":
        return selected
    version = tuple(map(int, image.split(":")[1].split(".")))
    # 官方 5.5/5.6/5.7 和早期 8.0 没有 ARM64 镜像；Docker Desktop 可使用 amd64 仿真。
    if version[:2] in ((5, 5), (5, 6), (5, 7)) or (version[:2] == (8, 0) and len(version) == 3 and version < (8, 0, 29)):
        return "linux/amd64"
    return "linux/arm64" if platform.machine().lower() in ("arm64", "aarch64") else "linux/amd64"


def mysql_tcp_ready(log: str) -> bool:
    """端口必须来自同一条就绪消息，兼容 MySQL 5.x 紧随的 Version 行。"""
    lines = log.splitlines()
    for index, line in enumerate(lines):
        ready = re.search(r"\bready for connections\b", line, re.IGNORECASE)
        if not ready:
            continue
        details = line[ready.end():]
        port = re.search(r"\bport:\s*(\d+)\b", details, re.IGNORECASE)
        if not port and index + 1 < len(lines) and re.match(r"\s*Version:\s", lines[index + 1], re.IGNORECASE):
            port = re.search(r"\bport:\s*(\d+)\b", lines[index + 1], re.IGNORECASE)
        if port and int(port.group(1)) == 3306:
            return True
    return False


class MySQLVersionValidation(Validation):
    def __init__(self, args: argparse.Namespace):
        super().__init__(args)
        self.run_id = uuid.uuid4().hex
        self.resources: list[dict] = []
        self.cleanup_results: list[dict] = []
        self.prepared_images: dict[tuple[str, str], dict] = {}
        self.binary_sha256: str | None = None
        self.interrupted = False

    def docker(self, *arguments: str, timeout: float | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(["docker", *arguments], capture_output=True, text=True,
                              timeout=timeout or self.args.docker_timeout)

    def prepare_image(self, image: str, selected_platform: str):
        key = (image, selected_platform)
        if key in self.prepared_images:
            return
        if not self.args.no_pull and self.docker("pull", "--platform", selected_platform, image, timeout=self.args.pull_timeout).returncode:
            raise FixtureError("指定官方镜像拉取失败，未运行该版本")
        inspected = self.docker("image", "inspect", image)
        if inspected.returncode:
            raise FixtureError("本机没有指定镜像；--no-pull 禁止下载" if self.args.no_pull else "无法确认拉取后的本地镜像")
        try:
            item = json.loads(inspected.stdout)[0]
            self.prepared_images[key] = {"image": image, "docker_platform": selected_platform,
                                         "image_id": item["Id"], "repo_digests": item.get("RepoDigests") or [],
                                         "architecture": item["Architecture"]}
        except (ValueError, KeyError, TypeError, IndexError):
            raise FixtureError("无法读取本地镜像标识或架构") from None

    def create_fixture(self, image: str, role: str) -> dict:
        selected_platform = image_platform(image, self.args.platform)
        self.prepare_image(image, selected_platform)
        resource = {"name": f"db-connect-mysql-versions-{role}-{uuid.uuid4().hex[:16]}",
                    "image": image, "platform": selected_platform, "created": False, "cleaned": False}
        password = "DbTask9!" + secrets.token_hex(16)
        with tempfile.TemporaryDirectory(prefix="db-connect-mysql-version-") as temporary:
            env_file = Path(temporary) / "container.env"
            env_file.write_text(f"MYSQL_ROOT_PASSWORD={password}\nMYSQL_ROOT_HOST=%\n", encoding="utf-8")
            env_file.chmod(0o600)
            # 在请求创建之前登记唯一名称，中断或超时也会核对所有权并清理。
            self.resources.append(resource)
            created = self.docker("create", "--pull=never", "--name", resource["name"],
                                  "--label", f"{LABEL}={self.run_id}", "--platform", selected_platform,
                                  "-p", "127.0.0.1::3306", "--volume", "/var/lib/mysql",
                                  "--env-file", str(env_file), image)
            if created.returncode:
                raise FixtureError("专属容器创建失败，未接触已有容器")
            resource["created"] = True
        if self.docker("start", resource["name"]).returncode:
            raise FixtureError("专属容器启动失败")
        binding = self.docker("port", resource["name"], "3306/tcp")
        matched = re.fullmatch(r"127\.0\.0\.1:(\d+)\s*", binding.stdout)
        if binding.returncode or not matched or not 0 < int(matched.group(1)) <= 65535:
            raise FixtureError("未能确认容器仅绑定到本机随机 TCP 端口")
        port = int(matched.group(1))
        deadline = time.monotonic() + self.args.startup_timeout
        while time.monotonic() < deadline:
            # 官方入口的临时初始化服务禁用 TCP；只接受最终服务的 3306 就绪日志。
            # 严禁在探活循环中执行 SQL。
            remaining = deadline - time.monotonic()
            logs = self.docker("logs", resource["name"], timeout=max(0.01, min(remaining, self.args.docker_timeout)))
            if logs.returncode:
                raise FixtureError("无法读取专属容器启动日志")
            if mysql_tcp_ready(logs.stdout) or mysql_tcp_ready(logs.stderr):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=min(1, max(0.01, remaining))):
                        resource["url"] = f"mysql://root:{password}@127.0.0.1:{port}/mysql"
                        return resource
                except OSError:
                    pass
            time.sleep(min(0.25, max(0, deadline - time.monotonic())))
        raise FixtureError("专属数据库启动超时；未执行 SQL 探活")

    def cleanup_resource(self, resource: dict):
        if resource["cleaned"]:
            return
        name = resource["name"]
        result = {"image": resource["image"], "container_name": name, "status": "failed",
                  "anonymous_data_volume": "unconfirmed"}
        try:
            inspected = self.docker("inspect", name)
            missing = {f"error: no such object: {name}", f"error: no such container: {name}"}
            if inspected.returncode == 1 and inspected.stderr.strip().casefold() in missing and not resource["created"]:
                result.update(status="not_created", anonymous_data_volume="not_created")
            elif inspected.returncode == 0:
                items = json.loads(inspected.stdout)
                if (isinstance(items, list) and len(items) == 1 and items[0].get("Name") == "/" + name
                        and items[0].get("Config", {}).get("Labels", {}).get(LABEL) == self.run_id):
                    removed = self.docker("rm", "-f", "-v", name)
                    if removed.returncode == 0:
                        result.update(status="removed", anonymous_data_volume="removed")
        except (OSError, ValueError, TypeError, AttributeError, subprocess.TimeoutExpired, KeyboardInterrupt):
            pass
        resource["cleaned"] = True
        self.cleanup_results.append(result)
        print(f"{result['status']:7} cleanup: {name}", flush=True)

    def contract(self, name: str, source: dict, target: dict | None = None):
        # 清除父进程全部数据任务配置，只有本次容器的 URL 可以进入真实测试。
        environment = {key: value for key, value in os.environ.items() if not key.startswith("DB_CONNECT_DATA_TASK_")}
        environment["DB_CONNECT_DATA_TASK_MYSQL_URL"] = source["url"]
        if target:
            environment["DB_CONNECT_DATA_TASK_MYSQL_TARGET_URL"] = target["url"]
        self.tests(name, CROSS_TEST if target else SINGLE_TEST, env=environment, ignored=True, exact=True,
                   inherit_env=False, timeout=self.args.test_timeout,
                   required_metrics=("source_server_version", "target_server_version") if target else ("server_version",))
        self.results[-1].update(image=source["image"], docker_platform=source["platform"])
        if target:
            self.results[-1]["target_image"] = target["image"]

    def fixture_failure(self, name: str, image: str, error: BaseException):
        if isinstance(error, KeyboardInterrupt):
            self.interrupted = True
            self.record(name, "failed", "验收被中断", image=image)
        elif isinstance(error, FixtureError):
            self.record(name, "not_run", str(error), image=image)
        else:
            self.record(name, "not_run", "夹具命令超时或执行失败，未完成该版本验收", image=image)

    def record_unrun_contracts(self):
        """环境失败和中断也必须显式列出未执行的每个版本、每个方向。"""
        planned = []
        if self.args.reference_image:
            planned.append(("reference:" + self.args.reference_image, self.args.reference_image, None))
        for image in self.args.images:
            planned.append((image, image, None))
            if self.args.reference_image:
                planned.extend(((image + "->reference", image, self.args.reference_image),
                                ("reference->" + image, self.args.reference_image, image)))
        recorded = {item["name"] for item in self.results}
        for name, image, target in planned:
            if name not in recorded:
                metrics = {"image": image}
                if target:
                    metrics["target_image"] = target
                self.record(name, "not_run", "前置步骤失败或中断，未执行此验收", **metrics)

    def run(self) -> int:
        reference = None
        completed: set[str] = set()
        try:
            if not shutil.which("docker") or self.docker("info", "--format", "{{.ServerVersion}}").returncode:
                raise FixtureError("Docker 不可用")
            if self.args.binary:
                self.binary = self.args.binary.resolve()
                if not self.binary.is_file() or not os.access(self.binary, os.X_OK):
                    raise FixtureError("指定 Rust 测试程序不存在或不可执行")
            elif not self.build():
                raise FixtureError("Rust 测试程序未成功构建")
            digest = hashlib.sha256()
            with self.binary.open("rb") as binary:
                for block in iter(lambda: binary.read(1024 * 1024), b""):
                    digest.update(block)
            self.binary_sha256 = digest.hexdigest()
            if self.args.reference_image:
                try:
                    reference = self.create_fixture(self.args.reference_image, "reference")
                    self.contract("reference:" + self.args.reference_image, reference)
                    if self.results[-1]["status"] != "passed":
                        reference = None
                except (FixtureError, OSError, subprocess.TimeoutExpired) as error:
                    self.fixture_failure("reference:" + self.args.reference_image, self.args.reference_image, error)
            for image in self.args.images:
                start = len(self.resources)
                try:
                    candidate = self.create_fixture(image, "candidate")
                    self.contract(image, candidate)
                    if reference:
                        self.contract(image + "->reference", candidate, reference)
                        self.contract("reference->" + image, reference, candidate)
                except (FixtureError, OSError, subprocess.TimeoutExpired, KeyboardInterrupt) as error:
                    self.fixture_failure(image, image, error)
                    if isinstance(error, KeyboardInterrupt):
                        raise
                finally:
                    for resource in self.resources[start:]:
                        self.cleanup_resource(resource)
                    completed.add(image)
        except (FixtureError, OSError, subprocess.TimeoutExpired, KeyboardInterrupt) as error:
            self.interrupted = self.interrupted or isinstance(error, KeyboardInterrupt)
            for image in self.args.images:
                if image not in completed:
                    self.record(image, "not_run", "中断后未执行" if self.interrupted else "验收前置条件不可用", image=image)
            if not self.results:
                self.fixture_failure("mysql_versions", "", error)
        finally:
            for resource in self.resources:
                self.cleanup_resource(resource)
            self.record_unrun_contracts()
            revision = dirty = None
            try:
                revision_result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, timeout=10)
                dirty_result = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, timeout=10)
                revision = revision_result.stdout.strip() if revision_result.returncode == 0 else None
                dirty = bool(dirty_result.stdout) if dirty_result.returncode == 0 else None
            except (OSError, subprocess.TimeoutExpired, KeyboardInterrupt):
                pass
            report = {"scope": "disposable_official_mysql_versions_loopback", "images": self.args.images,
                      "reference_image": self.args.reference_image, "platform": platform.platform(),
                      "generated_at": datetime.now(timezone.utc).isoformat(), "interrupted": self.interrupted,
                      "source_revision": revision, "working_tree_dirty": dirty, "binary_sha256": self.binary_sha256,
                      "resolved_images": list(self.prepared_images.values()),
                      "results": self.results, "cleanup": self.cleanup_results}
            self.args.report.parent.mkdir(parents=True, exist_ok=True)
            self.args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if self.interrupted or any(item["status"] == "failed" for item in self.cleanup_results):
            return 1
        return verdict(self.results)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--images", type=mysql_image, nargs="+", required=True, help="显式选择的官方 MySQL 版本列表")
    parser.add_argument("--reference-image", type=mysql_image, help="专属参考实例；额外验收每个候选版本与其双向传输")
    parser.add_argument("--binary", type=Path, help="复用当前工作区编译的 Rust 库测试程序")
    parser.add_argument("--report", type=Path, default=ROOT / "artifacts/data-tasks/mysql-versions.json")
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
    return MySQLVersionValidation(args).run()


if __name__ == "__main__":
    sys.exit(main())
