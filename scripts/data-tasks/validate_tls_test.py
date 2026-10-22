"""TLS 夹具清理回归：无需 Docker，不允许把通信/删除失败报告为清理成功。"""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("validate_tls", Path(__file__).with_name("validate_tls.py"))
tls = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tls)
NAME = "db-connect-data-task-validate-tls-mock-owned"


def result(code=0, stdout="", stderr=""):
    return subprocess.CompletedProcess([], code, stdout, stderr)


def owned(name=NAME):
    return result(stdout=json.dumps([{"Name": "/" + name, "Config": {"Labels": {"io.db-connect.data-task-validation": "true"}}}]))


class CleanupTests(unittest.TestCase):
    def test_created_container_inspect_daemon_failure_is_failed_and_preserves_name(self):
        with patch.object(tls, "run", return_value=result(1, stderr="Cannot connect to Docker daemon")) as run:
            cleanup = tls.cleanup_container(NAME, created=True)
        self.assertEqual(cleanup["container"], "failed")
        self.assertEqual(cleanup["container_name"], NAME)
        self.assertEqual(run.call_count, 1)

    def test_interrupted_create_inspect_failure_does_not_claim_not_created(self):
        with patch.object(tls, "run", return_value=result(1, stderr="connection reset")):
            cleanup = tls.cleanup_container(NAME, created=False)
        self.assertEqual(cleanup["container"], "failed")
        self.assertEqual(cleanup["container_name"], NAME)

    def test_only_exact_missing_object_proves_create_did_not_leave_container(self):
        for prefix in ("Error: No such object: ", "error: no such object: "):
            with self.subTest(prefix=prefix), patch.object(tls, "run", return_value=result(1, stderr=f"{prefix}{NAME}\n")):
                self.assertEqual(tls.cleanup_container(NAME, created=False), {"container": "not_created"})

    def test_known_created_container_cannot_be_reported_never_created(self):
        with patch.object(tls, "run", return_value=result(1, stderr=f"Error: No such object: {NAME}\n")):
            cleanup = tls.cleanup_container(NAME, created=True)
        # 即使容器被外部移除，也无法证明本次匿名卷已经清理。
        self.assertEqual(cleanup["container"], "failed")
        self.assertEqual(cleanup["container_name"], NAME)

    def test_delete_failure_preserves_container_name(self):
        with patch.object(tls, "run", side_effect=[owned(), result(1)]):
            cleanup = tls.cleanup_container(NAME, created=True)
        self.assertEqual(cleanup["container"], "failed")
        self.assertEqual(cleanup["anonymous_data_volume"], "failed")
        self.assertEqual(cleanup["container_name"], NAME)

    def test_ownership_mismatch_is_never_removed(self):
        with patch.object(tls, "run", return_value=owned("unrelated")) as run:
            cleanup = tls.cleanup_container(NAME, created=True)
        self.assertEqual(cleanup["container"], "failed")
        self.assertEqual(run.call_count, 1)

    def test_invalid_inspect_response_is_failed(self):
        with patch.object(tls, "run", return_value=result(stdout="invalid-json")):
            self.assertEqual(tls.cleanup_container(NAME, created=True)["container"], "failed")

    def test_missing_docker_executable_is_failed(self):
        with patch.object(tls, "run", side_effect=FileNotFoundError):
            self.assertEqual(tls.cleanup_container(NAME, created=True)["container"], "failed")

    def test_owned_container_deletion_includes_anonymous_volume(self):
        with patch.object(tls, "run", side_effect=[owned(), result()]) as run:
            cleanup = tls.cleanup_container(NAME, created=True)
        self.assertEqual(cleanup, {"container": "removed", "anonymous_data_volume": "removed"})
        self.assertEqual(run.call_args.args[0], ["docker", "rm", "-f", "-v", NAME])

    def test_main_successful_tests_but_cleanup_failure_returns_one(self):
        def fake_run(args, **_kwargs):
            if args[:2] == ["docker", "port"]:
                return result(stdout="127.0.0.1:15432")
            if args[:2] == ["docker", "logs"]:
                return result(stderr="PostgreSQL init process complete\ndatabase system is ready to accept connections\ndatabase system is ready to accept connections")
            if args[:2] == ["docker", "inspect"]:
                return result(1, stderr="Cannot connect to Docker daemon")
            if args[0] != "docker":
                return result(stdout="test result: ok. 4 passed; 0 failed;")
            return result()
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "report.json"
            arguments = ["validate_tls.py", "--binary", "/mock/test-binary", "--report", str(report), "--log", str(Path(directory) / "log.txt")]
            with patch.object(tls.sys, "argv", arguments), patch.object(tls.shutil, "which", return_value="/mock/tool"), patch.object(tls, "certificates"), patch.object(tls.signal, "signal"), patch.object(tls, "run", side_effect=fake_run), contextlib.redirect_stdout(io.StringIO()):
                code = tls.main()
            saved = json.loads(report.read_text())
        self.assertEqual(code, 1)
        self.assertEqual(saved["results"][0]["status"], "passed")
        self.assertEqual(saved["cleanup"]["container"], "failed")
        self.assertTrue(saved["cleanup"]["container_name"].startswith("db-connect-data-task-validate-tls-"))
        self.assertEqual(saved["cleanup"]["temporary_certificates"], "removed")


if __name__ == "__main__":
    unittest.main()
