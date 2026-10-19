"""模拟子进程故障，验证真实 budget runner main；不启动 Docker/Cargo。"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


RUNNER = Path(__file__).with_name("mysql-budget-validation.py")
SPEC = importlib.util.spec_from_file_location("mysql_budget_validation", RUNNER)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CleanupEvidenceTests(unittest.TestCase):
    def invoke_main(self, *, cleanup_fault=None, cargo_exit_code=0):
        calls = []
        fixture = None
        inspect_count = 0

        def fake_run(args, **kwargs):
            nonlocal fixture, inspect_count
            calls.append(args)
            stdout = ""
            returncode = 0
            if args[:3] == ["docker", "image", "inspect"]:
                pass
            elif args[:2] == ["docker", "run"]:
                name = args[args.index("--name") + 1]
                fixture = Path("/private/tmp") / name
            elif args[:2] == ["docker", "inspect"]:
                inspect_count += 1
                if inspect_count == 2 and cleanup_fault == "inspect":
                    raise subprocess.CalledProcessError(1, args)
                marker = fixture.name.removeprefix("db-connect-budget-mysql-")
                if inspect_count == 2 and cleanup_fault == "label":
                    marker = "not-owned"
                stdout = json.dumps([{
                    "Image": "sha256:synthetic",
                    "Config": {"Labels": {"db-connect-budget-fixture": marker}},
                    "NetworkSettings": {"Ports": {"3306/tcp": [{"HostIp": "127.0.0.1", "HostPort": "54321"}]}},
                }])
            elif args[:2] == ["docker", "rm"]:
                if cleanup_fault == "remove":
                    raise subprocess.CalledProcessError(1, args)
            elif args[:2] == ["docker", "exec"]:
                if "mysqladmin" not in args:
                    stdout = "8.4.11\tsynthetic-uuid\t0\t3306\n"
            elif args[:2] == ["git", "rev-parse"]:
                stdout = "synthetic-head\n"
            elif args[:2] == ["cargo", "test"]:
                self.assertEqual(Path(kwargs["env"]["DB_CONNECT_BUDGET_MYSQL_FIXTURE"]), fixture)
                returncode = cargo_exit_code
                if returncode == 0:
                    (fixture / "results.json").write_text(json.dumps({"passed": ["synthetic-main-probe"]}))
            else:
                self.fail(f"未预期的子进程命令：{args[:2]}")
            return subprocess.CompletedProcess(args, returncode, stdout=stdout)

        try:
            with tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary) / "evidence.json"
                with patch.object(MODULE.subprocess, "run", side_effect=fake_run), patch.object(sys, "argv", [str(RUNNER), "--output", str(output)]), contextlib.redirect_stdout(io.StringIO()):
                    if cleanup_fault or cargo_exit_code:
                        with self.assertRaises(RuntimeError):
                            MODULE.main()
                    else:
                        MODULE.main()
                self.assertTrue(output.is_file(), "异常路径也必须写出证据")
                return json.loads(output.read_text()), calls
        finally:
            if fixture is not None:
                shutil.rmtree(fixture, ignore_errors=True)

    def test_cleanup_inspect_failure_keeps_successful_measurement_and_fails_run(self):
        evidence, calls = self.invoke_main(cleanup_fault="inspect")
        self.assert_cleanup_failure(evidence, "inspect")
        self.assertFalse(any(call[:2] == ["docker", "rm"] for call in calls))

    def test_cleanup_remove_failure_keeps_successful_measurement_and_fails_run(self):
        evidence, _ = self.invoke_main(cleanup_fault="remove")
        self.assert_cleanup_failure(evidence, "remove")

    def test_cleanup_label_mismatch_never_removes_container(self):
        evidence, calls = self.invoke_main(cleanup_fault="label")
        self.assert_cleanup_failure(evidence, "label_check")
        self.assertFalse(any(call[:2] == ["docker", "rm"] for call in calls))

    def test_measurement_and_cleanup_failures_are_both_preserved(self):
        evidence, _ = self.invoke_main(cleanup_fault="remove", cargo_exit_code=7)
        self.assertEqual(evidence["status"], "failed")
        self.assertEqual(evidence["measurement_status"], "failed")
        self.assertEqual(evidence["cargo_exit_code"], 7)
        self.assertEqual(evidence["measurement_error"]["type"], "RuntimeError")
        self.assertEqual(evidence["cleanup_error"]["stage"], "remove")
        self.assertFalse(evidence["container_and_volumes_removed"])
        self.assertIn("finished_at", evidence)

    def test_successful_run_retains_passed_result_and_cleanup_confirmation(self):
        evidence, _ = self.invoke_main()
        self.assertEqual(evidence["status"], "passed")
        self.assertEqual(evidence["cargo_exit_code"], 0)
        self.assertTrue(evidence["container_and_volumes_removed"])
        self.assertNotIn("cleanup_error", evidence)

    def assert_cleanup_failure(self, evidence, stage):
        self.assertEqual(evidence["status"], "failed")
        self.assertEqual(evidence["measurement_status"], "passed")
        self.assertEqual(evidence["cargo_exit_code"], 0)
        self.assertEqual(evidence["assertions"], {"passed": ["synthetic-main-probe"]})
        self.assertFalse(evidence["container_and_volumes_removed"])
        self.assertEqual(evidence["cleanup_error"]["stage"], stage)
        self.assertIn("finished_at", evidence)


if __name__ == "__main__":
    unittest.main()
