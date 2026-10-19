"""对真实 PG runner 注入子进程故障；不启动 Docker、Cargo 或数据库。"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


RUNNER = Path(__file__).with_name("metadata-postgres-validation.py")
SPEC = importlib.util.spec_from_file_location("metadata_postgres_validation", RUNNER)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CleanupEvidenceTests(unittest.TestCase):
    def invoke_main(self, *, cleanup_fault=None, cargo_failure=False,
                    launch_fault=None, container_missing=False):
        calls = []
        marker = None
        published_before_cleanup = False
        credentials_mode = None
        secret = "synthetic-secret-must-not-be-published"
        stdout = io.StringIO()
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Path(temporary) / "fixture"
            fixture.mkdir(mode=0o700)
            output = Path(temporary) / "evidence.json"

            def fake_run(args, **kwargs):
                nonlocal marker, published_before_cleanup, credentials_mode
                calls.append(args)
                text, stderr, code = "", "", 0
                if args[:3] == ["docker", "image", "inspect"]:
                    text = "sha256:synthetic"
                elif args[:2] == ["docker", "run"]:
                    marker = args[args.index("--name") + 1]
                    if launch_fault == "timeout":
                        raise subprocess.TimeoutExpired(args, 60, output=secret)
                    if launch_fault == "exit":
                        code, stderr = 7, secret
                elif args[:2] == ["docker", "port"]:
                    text = "127.0.0.1:54321"
                elif args[:2] == ["docker", "exec"]:
                    pass
                elif args[:2] == ["cargo", "test"]:
                    config = fixture / "fixture.json"
                    credentials_mode = config.stat().st_mode & 0o777
                    self.assertEqual(kwargs["env"]["DB_CONNECT_METADATA_PG_FIXTURE"], str(fixture))
                    if cargo_failure:
                        code, stderr = 7, secret
                    else:
                        text = ('METADATA_POSTGRES_VALIDATION {"passed":true}\n'
                                'METADATA_POSTGRES_PAGINATION {"passed":true}\n')
                elif args[:2] == ["docker", "inspect"]:
                    printed_success = any(
                        json.loads(line).get("status") == "passed"
                        for line in stdout.getvalue().splitlines() if line.startswith("{")
                    )
                    published_before_cleanup = output.exists() or (fixture / "result.json").exists() or printed_success
                    if container_missing:
                        code, stderr = 1, "Error: No such object: " + marker
                    elif cleanup_fault == "inspect":
                        code, stderr = 1, secret
                    else:
                        text = "not-owned" if cleanup_fault == "label" else marker
                elif args[:2] == ["docker", "rm"]:
                    if cleanup_fault == "remove":
                        code, stderr = 1, secret
                elif args[:2] == ["rustc", "--version"]:
                    text = "rustc synthetic"
                elif args[:2] == ["git", "rev-parse"]:
                    text = "synthetic-head"
                else:
                    self.fail(f"未预期的子进程命令：{args[:2]}")
                return subprocess.CompletedProcess(args, code, stdout=text, stderr=stderr)

            error = None
            with patch.object(MODULE.subprocess, "run", side_effect=fake_run), \
                    patch.object(MODULE.tempfile, "mkdtemp", return_value=str(fixture)), \
                    patch.object(MODULE.platform, "platform", return_value="synthetic-platform"), \
                    patch.object(sys, "argv", [str(RUNNER), "--output", str(output)]), \
                    contextlib.redirect_stdout(stdout):
                try:
                    MODULE.main()
                except BaseException as caught:
                    error = caught
            self.assertTrue(output.is_file(), "成功和失败路径都必须保存最终脱敏证据")
            evidence = json.loads(output.read_text())
            self.assertEqual(json.loads((fixture / "result.json").read_text()), evidence)
            self.assertNotIn(secret, output.read_text() + stdout.getvalue())
            self.assertFalse((fixture / "fixture.json").exists(), "异常路径也必须删除凭据")
            return evidence, calls, error, published_before_cleanup, credentials_mode

    def test_success_is_published_only_after_cleanup_and_includes_shared_source(self):
        evidence, _, error, early, mode = self.invoke_main()
        self.assertIsNone(error)
        self.assertFalse(early)
        self.assertEqual(mode, 0o600)
        self.assertEqual(evidence["status"], "passed")
        self.assertEqual(evidence["measurement_status"], "passed")
        self.assertEqual(evidence["cleanup_status"], "removed")
        self.assertTrue(evidence["container_and_volumes_removed"])
        self.assertTrue(evidence["credentials_removed"])
        self.assertIn("src-tauri/src/db/metadata_pg_tests.rs", evidence["source_sha256"])

    def test_cleanup_errors_keep_measurements_without_publishing_success(self):
        for fault, stage in [("inspect", "inspect"), ("label", "label_check"), ("remove", "remove")]:
            with self.subTest(fault=fault):
                evidence, calls, error, early, _ = self.invoke_main(cleanup_fault=fault)
                self.assertIsInstance(error, RuntimeError)
                self.assertFalse(early)
                self.assertEqual(evidence["status"], "failed")
                self.assertEqual(evidence["measurement_status"], "passed")
                self.assertTrue(evidence["pagination"]["passed"])
                self.assertEqual(evidence["cleanup_error"]["stage"], stage)
                self.assertFalse(evidence["container_and_volumes_removed"])
                if fault != "remove":
                    self.assertFalse(any(call[:2] == ["docker", "rm"] for call in calls))

    def test_cleanup_error_does_not_replace_measurement_failure(self):
        evidence, _, error, _, _ = self.invoke_main(cleanup_fault="remove", cargo_failure=True)
        self.assertIsInstance(error, RuntimeError)
        self.assertIn("cargo", str(error))
        self.assertEqual(evidence["status"], "failed")
        self.assertEqual(evidence["measurement_status"], "failed")
        self.assertEqual(evidence["measurement_error"]["type"], "RuntimeError")
        self.assertEqual(evidence["cleanup_error"]["stage"], "remove")

    def test_failed_launch_still_cleans_owned_container(self):
        evidence, calls, error, _, _ = self.invoke_main(launch_fault="exit")
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual(evidence["status"], "failed")
        self.assertFalse(evidence["measurement_run"])
        self.assertEqual(evidence["cleanup_status"], "removed")
        self.assertTrue(any(call[:2] == ["docker", "rm"] for call in calls))

    def test_timed_out_launch_preserves_failure_when_no_container_exists(self):
        evidence, calls, error, _, _ = self.invoke_main(launch_fault="timeout", container_missing=True)
        self.assertIsInstance(error, subprocess.TimeoutExpired)
        self.assertEqual(evidence["status"], "failed")
        self.assertEqual(evidence["measurement_error"]["type"], "TimeoutExpired")
        self.assertEqual(evidence["cleanup_status"], "not_found")
        self.assertNotIn("cleanup_error", evidence)
        self.assertFalse(any(call[:2] == ["docker", "rm"] for call in calls))


if __name__ == "__main__":
    unittest.main()
