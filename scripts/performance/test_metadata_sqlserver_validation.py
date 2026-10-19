"""SQL Server runner 故障注入；仅替换外部进程/就绪探测，不访问 Docker 或数据库。"""
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


RUNNER_PATH = Path(__file__).with_name("metadata-sqlserver-validation.py")
SPEC = importlib.util.spec_from_file_location("metadata_sqlserver_runner", RUNNER_PATH)
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class RunnerSafetyTests(unittest.TestCase):
    def invoke_main(self, *, launch_timeout=False, cleanup_fault=None,
                    missing_message=None, cargo_failure=False, hash_failure=False,
                    archive_failure=False):
        calls = []
        fixture = None
        container = None
        mode = None
        early = False
        secrets = ["private-command-output-must-not-be-published"]
        stdout = io.StringIO()
        original_open = Path.open
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "evidence.json"

            def fake_process(command, **kwargs):
                nonlocal fixture, container, mode, early
                calls.append(command)
                text, stderr, code = "", "", 0
                if command[:2] == ["docker", "create"]:
                    container = command[command.index("--name") + 1]
                    fixture = Path("/private/tmp") / container
                    if launch_timeout:
                        raise subprocess.TimeoutExpired(command, 60, output=secrets[0])
                elif command[:2] == ["docker", "start"]:
                    text = container
                elif command[:2] == ["docker", "port"]:
                    text = "127.0.0.1:54321"
                elif command[:2] == ["docker", "exec"]:
                    self.assertIn("CREATE EVENT SESSION", kwargs["input"])
                elif command[:2] == ["cargo", "test"]:
                    config_path = fixture / "fixture.json"
                    mode = config_path.stat().st_mode & 0o777
                    config = json.loads(config_path.read_text())
                    secrets.extend(config[key] for key in
                                   ("password", "owner_password", "reader_password", "denied_password"))
                    if cargo_failure:
                        code, stderr = 7, secrets[0]
                    else:
                        text = 'METADATA_SQLSERVER_VALIDATION {"status":"passed"}\n'
                elif command[:2] == ["docker", "inspect"]:
                    early = output.exists() or (fixture / "result.json").exists()
                    if cleanup_fault == "interrupt":
                        raise KeyboardInterrupt
                    if missing_message:
                        code, stderr = 1, missing_message
                    else:
                        text = "not-owned" if cleanup_fault == "label" else container
                elif command[:2] == ["docker", "rm"]:
                    if cleanup_fault == "remove":
                        code, stderr = 7, secrets[0]
                elif command[:2] == ["git", "rev-parse"]:
                    text = "synthetic-head"
                else:
                    self.fail(f"未预期的外部进程：{command[:2]}")
                return subprocess.CompletedProcess(command, code, text, stderr)

            def controlled_open(path, *args, **kwargs):
                if archive_failure and path == output:
                    raise OSError(secrets[0])
                return original_open(path, *args, **kwargs)

            try:
                with contextlib.ExitStack() as stack:
                    stack.enter_context(patch.object(RUNNER, "preflight", return_value={
                        "image": "synthetic-image", "image_id": "sha256:synthetic",
                        "supported_configuration": False,
                    }))
                    stack.enter_context(patch.object(RUNNER, "wait_ready", return_value=None))
                    stack.enter_context(patch.object(RUNNER.platform, "platform", return_value="synthetic-platform"))
                    stack.enter_context(patch.object(RUNNER.subprocess, "run", side_effect=fake_process))
                    stack.enter_context(patch.object(Path, "open", controlled_open))
                    stack.enter_context(patch.object(sys, "argv", [str(RUNNER_PATH), "--output", str(output)]))
                    stack.enter_context(contextlib.redirect_stdout(stdout))
                    if hash_failure:
                        stack.enter_context(patch.object(RUNNER.hashlib, "sha256", side_effect=OSError(secrets[0])))
                    exit_code = 0
                    try:
                        RUNNER.main()
                    except SystemExit as error:
                        exit_code = error.code
                self.assertIsNotNone(fixture)
                local = fixture / "result.json"
                self.assertTrue(local.is_file(), "失败也必须保留本次脱敏归档")
                saved = json.loads(local.read_text())
                if not archive_failure:
                    self.assertEqual(saved, json.loads(output.read_text()))
                self.assertFalse((fixture / "fixture.json").exists())
                for secret in secrets:
                    self.assertNotIn(secret, local.read_text() + stdout.getvalue())
                return saved, calls, exit_code, mode, early, stdout.getvalue()
            finally:
                if fixture is not None:
                    shutil.rmtree(fixture, ignore_errors=True)

    def test_success_uses_private_credentials_and_archives_after_cleanup(self):
        evidence, _, code, mode, early, _ = self.invoke_main()
        self.assertEqual(code, 0)
        self.assertEqual(evidence["status"], "passed")
        self.assertEqual(evidence["measurement_status"], "passed")
        self.assertEqual(mode, 0o600)
        self.assertFalse(early)
        self.assertTrue(evidence["container_and_volumes_removed"])
        self.assertTrue(evidence["credentials_file_removed"])

    def test_create_timeout_still_cleans_container_created_by_daemon(self):
        evidence, calls, code, _, _, _ = self.invoke_main(launch_timeout=True)
        self.assertEqual(code, 1)
        self.assertEqual(evidence["failure"], {"stage": "create", "type": "TimeoutExpired"})
        self.assertEqual(evidence["cleanup_result"], "removed")
        self.assertTrue(any(call[:2] == ["docker", "rm"] for call in calls))

    def test_wrong_label_never_removes_container(self):
        evidence, calls, code, _, _, _ = self.invoke_main(cleanup_fault="label")
        self.assertEqual(code, 1)
        self.assertEqual(evidence["status"], "failed")
        self.assertIn("cleanup_failure", evidence)
        self.assertFalse(any(call[:2] == ["docker", "rm"] for call in calls))

    def test_measurement_and_cleanup_failures_are_both_retained(self):
        evidence, _, code, _, _, _ = self.invoke_main(cargo_failure=True, cleanup_fault="remove")
        self.assertEqual(code, 1)
        self.assertEqual(evidence["failure"]["stage"], "cargo_test")
        self.assertEqual(evidence["failure"]["exit_code"], 7)
        self.assertEqual(evidence["cleanup_failure"]["type"], "RuntimeError")
        self.assertEqual(evidence["status"], "failed")

    def test_cleanup_interrupt_still_deletes_credentials(self):
        evidence, _, code, mode, _, _ = self.invoke_main(cleanup_fault="interrupt")
        self.assertEqual(mode, 0o600)
        self.assertEqual(code, 1)
        self.assertEqual(evidence["cleanup_failure"]["type"], "KeyboardInterrupt")
        self.assertTrue(evidence["credentials_file_removed"])

    def test_hash_failure_preserves_measurement_failure(self):
        evidence, _, code, _, _, _ = self.invoke_main(cargo_failure=True, hash_failure=True)
        self.assertEqual(code, 1)
        self.assertEqual(evidence["failure"]["stage"], "cargo_test")
        self.assertEqual(evidence["source_archive_failure"]["type"], "OSError")
        self.assertEqual(evidence["cleanup_result"], "removed")

    def test_output_failure_marks_local_evidence_failed(self):
        evidence, _, code, _, _, _ = self.invoke_main(archive_failure=True)
        self.assertEqual(code, 1)
        self.assertEqual(evidence["status"], "failed")
        self.assertIn("archive_failure", evidence)
        self.assertTrue(evidence["container_and_volumes_removed"])

    def test_missing_container_message_variants_are_accepted(self):
        for message in ["Error: No such object: fixture", "error: no such container: fixture",
                        "ERROR: no\t such   object: fixture"]:
            with self.subTest(message=message):
                evidence, _, code, _, _, _ = self.invoke_main(missing_message=message)
                self.assertEqual(code, 0)
                self.assertEqual(evidence["status"], "passed")
                self.assertEqual(evidence["cleanup_result"], "not_created_or_already_removed")


if __name__ == "__main__":
    unittest.main()
