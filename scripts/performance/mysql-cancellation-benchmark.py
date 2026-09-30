#!/usr/bin/env python3
"""在独立 macOS MySQL 5.7 实例中测量旧/新取消路径及冷/热连接池。

示例（会启动自己的临时实例并执行基准）：
    python3 scripts/performance/mysql-cancellation-benchmark.py \
        --mysqld /opt/homebrew/opt/mysql@5.7/bin/mysqld --samples 20

可用 --output docs/performance 指定输出根目录。每次运行创建独立结果目录，
包含 metadata.json、samples.jsonl、summary.json；失败时仅写入脱敏状态。
冷/热指每个 Rust 测试进程中的业务连接池，热池预先建立五条连接，并非重启服务器。
仅使用 Python 标准库及已安装的 MySQL 5.7、mysqladmin、Cargo，不安装依赖。
不会读取业务连接配置；不删除临时目录，退出时只关闭本脚本创建并持有的进程。
"""

import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import platform
import re
import socket
import subprocess
import sys
import tempfile
import time
import uuid


WORKSPACE = Path(__file__).resolve().parents[2]
TEMP_ROOT = Path("/private/tmp")
GROUPS = (("old", "cold"), ("old", "warm"), ("new", "cold"), ("new", "warm"))
METRICS = (
    "cancel_ms",
    "capacity_ms",
    "execution_return_ms",
    "server_target_total_ms",
    "server_after_kill_ms",
)
COUNTERS = (
    "normal_registration_sql_count",
    "normal_sql_before_count",
    "server_error_code",
    "running_queries",
    "pool_max",
    "prewarmed_connections",
)
SAMPLE_MARKER = "MYSQL_CANCEL_BENCH "
SAMPLE_TIMEOUT = 900


class BenchmarkFailure(Exception):
    """只保存固定错误分类和数字，不保存子进程原始输出。"""

    def __init__(self, stage, reason, **counts):
        super().__init__(reason)
        self.details = {"stage": stage, "reason": reason, **counts}


def positive_int(value):
    try:
        number = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("样本数必须是正整数") from error
    if number <= 0:
        raise argparse.ArgumentTypeError("样本数必须是正整数")
    return number


def parse_args():
    parser = argparse.ArgumentParser(
        description="在独立临时 MySQL 5.7 实例中采集取消延迟；只支持已验证的 macOS 流程。",
        epilog="--help 不启动实例。真实采样不会删除夹具或结果目录，不会停止已有实例。",
        add_help=False,
    )
    parser.add_argument("-h", "--help", action="help", help="显示帮助信息并退出")
    parser.add_argument(
        "--mysqld", required=True, type=Path,
        help="已安装的 MySQL 5.7 mysqld 路径；同目录须有 mysqladmin",
    )
    parser.add_argument(
        "--samples", type=positive_int, default=20,
        help="旧/新 × 冷/热各组的样本数（默认：20，共 80 次单样本测试）",
    )
    parser.add_argument(
        "--output", type=Path, default=TEMP_ROOT,
        help="输出根目录，每次创建独立结果子目录（默认：/private/tmp）",
    )
    return parser.parse_args()


def write_json(path, value):
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )


def emit(event, **values):
    # stdout 只输出固定分类、数量、时间和随机标识，不转发服务器/Cargo 输出。
    print(json.dumps({"event": event, **values}, allow_nan=False), flush=True)


def stop_owned_process(process):
    """只通过持有的 Popen 对象终止自己的直接子进程，不读取 PID 文件杀进程。"""
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
    else:
        process.wait()


def run_captured(command, env, stage, timeout, cwd=None):
    process = subprocess.Popen(
        command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
    )
    try:
        try:
            output, _ = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            raise BenchmarkFailure(stage, "timeout", timeout_seconds=timeout) from error
        return process.returncode, output
    finally:
        stop_owned_process(process)
        if process.stdout is not None:
            process.stdout.close()


def fixture_environment(fixture):
    # --no-defaults 之外，mysqladmin 还可能读取登录路径文件；显式指向新的空路径。
    # 不改 HOME，不继承 MYSQL_PWD、MYSQL_HOST 等隐式连接来源。
    env = {key: value for key, value in os.environ.items() if not key.startswith("MYSQL_")}
    env["MYSQL_TEST_LOGIN_FILE"] = str(fixture / "no-login.cnf")
    return env


def allocate_loopback_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    if port <= 1024 or port == 3306:
        raise BenchmarkFailure("fixture", "invalid_temporary_port")
    # 若释放预留 socket 后发生端口竞争，mysqld 启动失败；绝不连接或停止竞争实例。
    return port


def server_arguments(mysqld, fixture, port):
    return [
        str(mysqld), "--no-defaults", "--basedir=" + str(mysqld.parent.parent),
        "--datadir=" + str(fixture / "data"), "--bind-address=127.0.0.1",
        "--port=" + str(port), "--socket=" + str(fixture / "mysql.sock"),
        "--pid-file=" + str(fixture / "mysqld.pid"),
        "--log-error=" + str(fixture / "mysqld-error.log"),
        "--general-log=OFF", "--slow-query-log=OFF", "--max-connections=32",
        "--innodb-buffer-pool-size=32M", "--innodb-log-file-size=8M",
        "--performance-schema=ON",
        "--performance-schema-consumer-events-statements-current=ON",
        "--performance-schema-consumer-events-statements-history=ON",
        "--performance-schema-consumer-events-statements-history-long=ON",
        "--performance-schema-events-statements-history-long-size=10000",
        "--performance-schema-instrument=statement/%=ON",
    ]


def wait_until_ready(process, mysqladmin, fixture, env):
    deadline = time.monotonic() + 60
    command = [
        str(mysqladmin), "--no-defaults", "--protocol=SOCKET",
        "--socket=" + str(fixture / "mysql.sock"), "--user=root", "ping",
    ]
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise BenchmarkFailure("startup", "server_exited", exit_code=process.returncode)
        # mysqladmin ping 使用协议探活，不循环执行 SQL。
        code, _ = run_captured(command, env, "startup_ping", timeout=2)
        if code == 0 and process.poll() is None:
            if int((fixture / "mysqld.pid").read_text().strip()) != process.pid:
                raise BenchmarkFailure("startup", "pid_mismatch")
            return
        time.sleep(0.2)
    raise BenchmarkFailure("startup", "timeout", timeout_seconds=60)


def validated_sample(output, variant, thermal, sample):
    matches = [line.split(SAMPLE_MARKER, 1)[1]
               for line in output.splitlines() if SAMPLE_MARKER in line]
    if len(matches) != 1:
        raise BenchmarkFailure("sample", "marker_count", count=len(matches))
    try:
        row = json.loads(matches[0])
        if not isinstance(row, dict):
            raise ValueError()
        if row.get("variant") != variant or row.get("thermal") != thermal:
            raise ValueError()
        run_id = row.get("run_id")
        if not isinstance(run_id, str) or not re.fullmatch(r"[0-9a-f]{32}", run_id):
            raise ValueError()
        clean = {"variant": variant, "thermal": thermal, "sample": sample, "run_id": run_id}
        for key in METRICS + COUNTERS:
            value = row[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError()
            if not math.isfinite(value) or value < 0:
                raise ValueError()
            if key in COUNTERS and not isinstance(value, int):
                raise ValueError()
            clean[key] = value
        return clean
    except (KeyError, TypeError, ValueError, OverflowError) as error:
        raise BenchmarkFailure("sample", "invalid_measurement") from error


def summarize(rows):
    summary = []
    for variant, thermal in GROUPS:
        selected = [row for row in rows if row["variant"] == variant and row["thermal"] == thermal]
        group = {"variant": variant, "thermal": thermal, "samples": len(selected)}
        for metric in METRICS:
            values = sorted(row[metric] for row in selected)
            group[metric] = {
                "min": values[0], "p50": values[math.ceil(0.5 * len(values)) - 1],
                "p95": values[math.ceil(0.95 * len(values)) - 1], "max": values[-1],
            }
        for counter in COUNTERS:
            group[counter] = sorted({row[counter] for row in selected})
        summary.append(group)
    return summary


def collect_samples(fixture, output, env, samples, run_id):
    command = [
        "cargo", "test", "--offline", "--locked",
        "--manifest-path", "src-tauri/Cargo.toml", "--lib",
        "mysql_query_bench_isolated_sample", "--", "--ignored", "--nocapture",
        "--test-threads=1",
    ]
    rows = []
    started = time.monotonic()
    for variant, thermal in GROUPS:
        for sample in range(1, samples + 1):
            sample_env = dict(env)
            sample_env.update({
                "DB_CONNECT_MYSQL_BENCH_FIXTURE": str(fixture),
                "DB_CONNECT_MYSQL_BENCH_VARIANT": variant,
                "DB_CONNECT_MYSQL_BENCH_THERMAL": thermal,
            })
            code, captured = run_captured(
                command, sample_env, "sample", SAMPLE_TIMEOUT, cwd=WORKSPACE,
            )
            if code:
                raise BenchmarkFailure("sample", "cargo_exit", exit_code=code, sample=sample)
            row = validated_sample(captured, variant, thermal, sample)
            rows.append(row)
            with (output / "samples.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(row, sort_keys=True, allow_nan=False) + "\n")
            emit("progress", run_id=run_id, variant=variant, thermal=thermal,
                 completed=sample, elapsed_seconds=round(time.monotonic() - started, 3))
    summary = summarize(rows)
    write_json(output / "summary.json", summary)
    emit("summary", run_id=run_id, groups=summary,
         elapsed_seconds=round(time.monotonic() - started, 3))


def main():
    args = parse_args()
    output = None
    server = None
    exit_code = 0
    run_id = uuid.uuid4().hex
    try:
        if platform.system() != "Darwin":
            raise BenchmarkFailure("preflight", "requires_macos")
        mysqld = args.mysqld.expanduser().resolve(strict=True)
        mysqladmin = mysqld.parent / "mysqladmin"
        if not mysqld.is_file() or not os.access(mysqld, os.X_OK):
            raise BenchmarkFailure("preflight", "mysqld_not_executable")
        if not mysqladmin.is_file() or not os.access(mysqladmin, os.X_OK):
            raise BenchmarkFailure("preflight", "mysqladmin_not_executable")
        if not (WORKSPACE / "src-tauri/Cargo.toml").is_file():
            raise BenchmarkFailure("preflight", "workspace_not_found")

        fixture = Path(tempfile.mkdtemp(prefix="db-connect-mysql-cancel-", dir=TEMP_ROOT))
        (fixture / "data").mkdir(mode=0o700)
        env = fixture_environment(fixture)
        code, version_output = run_captured([str(mysqld), "--no-defaults", "--version"], env, "version", 15)
        version_match = re.search(r"\bVer\s+(5\.7\.\d+)\b", version_output)
        if code or not version_match:
            raise BenchmarkFailure("preflight", "requires_mysql_5_7")
        version = version_match.group(1)

        output_root = args.output.expanduser().resolve()
        output_root.mkdir(parents=True, exist_ok=True)
        output = output_root / ("mysql-cancellation-" + run_id)
        output.mkdir()
        print("结果目录：" + str(output), file=sys.stderr, flush=True)
        print("隔离夹具目录：" + str(fixture), file=sys.stderr, flush=True)
        port = allocate_loopback_port()
        config = {
            "directory": str(fixture), "datadir": str(fixture / "data"), "port": port,
            "socket": str(fixture / "mysql.sock"), "pid_file": str(fixture / "mysqld.pid"),
            "error_log": str(fixture / "mysqld-error.log"), "basedir": str(mysqld.parent.parent),
            "server_version": version, "mysql_test_login_file": env["MYSQL_TEST_LOGIN_FILE"],
        }
        write_json(fixture / "fixture.json", config)
        write_json(output / "metadata.json", {
            "run_id": run_id, "started_utc": datetime.now(timezone.utc).isoformat(),
            "profile": "debug", "server_version": version, "platform": platform.system(),
            "architecture": platform.machine(), "samples_per_group": args.samples,
            "pool_max": 5, "blocker_duration_ms": 1500, "target_timeout_ms": 30000,
            "warmup_connections_in_same_process": 5, "percentile_method": "nearest-rank",
            "normal_query_counter_scope": "独立新池，包含驱动启动 SQL",
            "server_after_kill_scope": "服务端目标 TIMER_END 减服务端 KILL TIMER_START",
        })
        code, _ = run_captured([
            str(mysqld), "--no-defaults", "--initialize-insecure",
            "--basedir=" + str(mysqld.parent.parent), "--datadir=" + str(fixture / "data"),
            "--log-error=" + str(fixture / "initialize.log"),
            "--innodb-buffer-pool-size=32M", "--innodb-log-file-size=8M",
        ], env, "initialize", 120)
        if code:
            raise BenchmarkFailure("initialize", "server_exit", exit_code=code)
        with (fixture / "launcher.log").open("ab") as launcher:
            server = subprocess.Popen(
                server_arguments(mysqld, fixture, port), env=env, stdin=subprocess.DEVNULL,
                stdout=launcher, stderr=launcher, start_new_session=True,
            )
        config["pid"] = server.pid
        write_json(fixture / "fixture.json", config)
        wait_until_ready(server, mysqladmin, fixture, env)
        collect_samples(fixture, output, env, args.samples, run_id)
    except KeyboardInterrupt:
        exit_code = 130
        details = {"stage": "interrupted", "reason": "user_interrupt"}
    except BenchmarkFailure as error:
        exit_code = 1
        details = error.details
    except Exception:
        # 包括操作系统、解析和启动异常；原始异常可能含命令参数，禁止直接记录。
        exit_code = 1
        details = {"stage": "runtime", "reason": "operation_failed"}
    finally:
        if server is not None:
            try:
                stop_owned_process(server)
            except Exception:
                exit_code = 1
                details = {"stage": "shutdown", "reason": "owned_process_cleanup_failed"}
        if exit_code:
            if output is not None:
                try:
                    write_json(output / "failure.json", {"run_id": run_id, **details})
                except OSError:
                    pass
            emit("failure", run_id=run_id, **details)
            print("基准未完成；失败状态已脱敏，临时目录保留供检查。", file=sys.stderr)
    if not exit_code:
        emit("complete", run_id=run_id, samples=args.samples * len(GROUPS))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
