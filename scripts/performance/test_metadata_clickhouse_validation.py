"""ClickHouse runner 的内存安全回归；不调用 Docker、不建立网络连接或查询 SQL。"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "metadata_clickhouse_runner", Path(__file__).with_name("metadata-clickhouse-validation.py"))
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def completed(code=0, stdout="", stderr=""):
    return subprocess.CompletedProcess([], code, stdout, stderr)


class RunnerSafetyTests(unittest.TestCase):
    def test_preflight_distinguishes_missing_image_and_socket_denial(self):
        with patch.object(RUNNER.subprocess, "run", return_value=completed(1, stderr="No such image")):
            self.assertEqual(RUNNER.preflight()["status"], "image_missing")
        with patch.object(RUNNER.subprocess, "run", return_value=completed(1, stderr="permission denied")):
            self.assertEqual(RUNNER.preflight()["status"], "docker_unavailable")

    def test_preflight_records_only_image_identity(self):
        image = {"Id": "sha256:fixture", "Architecture": "arm64", "Config": {"Env": ["SECRET=value"]}}
        with patch.object(RUNNER.subprocess, "run", return_value=completed(stdout=json.dumps(image))):
            result = RUNNER.preflight()
        self.assertEqual(result["status"], "ready")
        self.assertNotIn("SECRET", json.dumps(result))

    def test_already_absent_lowercase_message_is_successful_cleanup(self):
        with patch.object(RUNNER.subprocess, "run", return_value=completed(1, stderr="error: no such object: fixture")):
            self.assertTrue(RUNNER.cleanup_owned("fixture")["owned_container_absent"])

    def test_absence_messages_accept_case_and_whitespace_variants(self):
        self.assertTrue(RUNNER.missing_container("ERROR:  No\tSuch   Object: fixture"))
        self.assertTrue(RUNNER.missing_container("No\n such\tcontainer: fixture"))
        self.assertFalse(RUNNER.missing_container("permission denied"))

    def test_matching_label_removes_owned_container_and_volumes(self):
        values = [completed(stdout=json.dumps({RUNNER.LABEL: "fixture"})), completed(stdout="fixture"),
                  completed(1, stderr="error: no such object: fixture")]
        with patch.object(RUNNER.subprocess, "run", side_effect=values) as execute:
            result = RUNNER.cleanup_owned("fixture")
        self.assertEqual(result["status"], "removed")
        self.assertIn("--volumes", execute.call_args_list[1].args[0])

    def test_wrong_label_never_removes_any_container(self):
        with patch.object(RUNNER.subprocess, "run", return_value=completed(stdout=json.dumps({RUNNER.LABEL: "other"}))) as execute:
            with self.assertRaises(RUNNER.StageFailure) as failure:
                RUNNER.cleanup_owned("fixture")
        self.assertEqual(failure.exception.stage, "cleanup_label_mismatch")
        self.assertEqual(execute.call_count, 1)

    def test_unknown_inspect_failure_is_not_reported_as_absent(self):
        with patch.object(RUNNER.subprocess, "run", return_value=completed(1, stderr="permission denied")):
            with self.assertRaises(RUNNER.StageFailure) as failure:
                RUNNER.cleanup_owned("fixture")
        self.assertEqual(failure.exception.stage, "cleanup_inspect")

    def test_run_creation_failure_preserved_when_cleanup_also_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "fixture"
            fixture.mkdir()
            credentials = fixture / "fixture.json"
            credentials.write_text('{"password":"private-fixture-value"}')
            output = Path(directory) / "evidence.json"
            with patch.object(RUNNER, "preflight", return_value={"status": "ready"}), \
                 patch.object(RUNNER.tempfile, "mkdtemp", return_value=str(fixture)), \
                 patch.object(RUNNER, "run", side_effect=RUNNER.StageFailure("create_container", 125)), \
                 patch.object(RUNNER, "cleanup_owned", side_effect=RUNNER.StageFailure("cleanup_inspect", 1)) as cleanup, \
                 patch("sys.argv", ["runner", "--output", str(output)]), contextlib.redirect_stdout(io.StringIO()):
                code = RUNNER.main()
            result = json.loads(output.read_text())
            self.assertEqual(code, 1)
            self.assertEqual(result["failure"]["stage"], "create_container")
            self.assertEqual(result["cleanup"]["stage"], "cleanup_inspect")
            self.assertTrue(result["credential_file_removed"])
            self.assertFalse(credentials.exists())
            self.assertNotIn("private-fixture-value", output.read_text())
            cleanup.assert_called_once()

    def test_cleanup_keyboard_interrupt_still_deletes_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "fixture"
            fixture.mkdir()
            (fixture / "fixture.json").write_text('{"password":"private-fixture-value"}')
            output = Path(directory) / "evidence.json"
            with patch.object(RUNNER, "preflight", return_value={"status": "ready"}), \
                 patch.object(RUNNER.tempfile, "mkdtemp", return_value=str(fixture)), \
                 patch.object(RUNNER, "run", side_effect=RUNNER.StageFailure("create_container", 125)), \
                 patch.object(RUNNER, "cleanup_owned", side_effect=KeyboardInterrupt), \
                 patch("sys.argv", ["runner", "--output", str(output)]), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(RUNNER.main(), 1)
            result = json.loads(output.read_text())
            self.assertEqual(result["failure"]["stage"], "create_container")
            self.assertEqual(result["cleanup"]["exception_type"], "KeyboardInterrupt")
            self.assertTrue(result["credential_file_removed"])

    def test_hash_failure_preserves_primary_failure_and_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / "fixture"
            fixture.mkdir()
            output = Path(directory) / "evidence.json"
            with patch.object(RUNNER, "preflight", return_value={"status": "ready"}), \
                 patch.object(RUNNER.tempfile, "mkdtemp", return_value=str(fixture)), \
                 patch.object(RUNNER, "run", side_effect=RUNNER.StageFailure("create_container", 125)), \
                 patch.object(RUNNER, "cleanup_owned", return_value={"status": "absent"}), \
                 patch.object(RUNNER, "source_hashes", side_effect=OSError), \
                 patch("sys.argv", ["runner", "--output", str(output)]), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(RUNNER.main(), 1)
            result = json.loads(output.read_text())
            self.assertEqual(result["failure"]["stage"], "create_container")
            self.assertEqual(result["cleanup"]["status"], "absent")
            self.assertEqual(result["source_hash_error"]["exception_type"], "OSError")

    def test_output_archive_failure_retains_temporary_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory)
            evidence = {"status": "failed", "failure": {"stage": "primary"}, "cleanup": {"status": "removed"}}
            # 不存在的父目录触发写最终路径失败；临时副本必须包含同一主失败和归档错误。
            RUNNER.archive(evidence, fixture, fixture / "absent" / "evidence.json")
            saved = json.loads((fixture / "result.json").read_text())
            self.assertEqual(saved["failure"]["stage"], "primary")
            self.assertEqual(saved["cleanup"]["status"], "removed")
            self.assertEqual(saved["archive_error"]["exception_type"], "FileNotFoundError")


if __name__ == "__main__":
    unittest.main()
