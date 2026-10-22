"""用可执行夹具验证验收工具的状态裁决，不连接数据库。"""
import argparse
import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("data_task_validation", Path(__file__).with_name("validate.py"))
validation_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validation_module)


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="db-connect-validation-test-")
        args = argparse.Namespace(phase="a", report=None, no_docker=True, no_pull=True, skip_performance=True)
        self.validation = validation_module.Validation(args)

    def tearDown(self):
        self.directory.cleanup()

    def fixture(self, text, exit_code=0):
        executable = Path(self.directory.name) / "tests"
        executable.write_text("#!/usr/bin/env python3\n" + f"print({text!r})\nraise SystemExit({exit_code})\n", encoding="utf-8")
        executable.chmod(0o700)
        self.validation.binary = executable

    def test_blocked_capability_is_incomplete_not_passed_or_failed(self):
        self.assertEqual(validation_module.verdict([{"status": "blocked"}]), 2)
        self.assertEqual(validation_module.verdict([{"status": "passed"}]), 0)
        self.assertEqual(validation_module.verdict([{"status": "failed"}, {"status": "blocked"}]), 1)

    def test_cancellation_timings_are_preserved_without_query_content(self):
        self.fixture("DATA_TASK_CANCEL_METRICS phase=pending_snapshot elapsed_ms=51\nDATA_TASK_CANCEL_METRICS phase=pending_target_lock elapsed_ms=62\ntest result: ok. 2 passed; 0 failed; 0 ignored")
        with contextlib.redirect_stdout(io.StringIO()):
            result = self.validation.tests("network", "real_")
        self.assertEqual(result["cancellation_latency_ms"], {"pending_snapshot": 51, "pending_target_lock": 62})

    def test_zero_matched_tests_are_not_reported_as_success(self):
        self.fixture("test result: ok. 0 passed; 0 failed; 4 ignored")
        with contextlib.redirect_stdout(io.StringIO()):
            result = self.validation.tests("missing_driver", "missing")
        self.assertIsNone(result)
        self.assertEqual(self.validation.results[-1]["status"], "not_run")

    def test_failure_is_reported_without_echoing_database_values(self):
        self.fixture("private database value\nfailures:\n    db::data_tasks::real_cancel\ntest result: FAILED. 2 passed; 1 failed; 0 ignored", 101)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = self.validation.tests("driver", "real_")
        self.assertIsNone(result)
        self.assertEqual(self.validation.results[-1]["status"], "failed")
        self.assertNotIn("private database value", output.getvalue())
        self.assertEqual(self.validation.results[-1]["failed_tests"], ["db::data_tasks::real_cancel"])

    def test_metrics_keep_exact_integer_counts(self):
        self.fixture("DATA_TASK_METRICS rows=1000000 peak_spool_bytes=9007199254740993\ntest result: ok. 1 passed; 0 failed; 0 ignored")
        with contextlib.redirect_stdout(io.StringIO()):
            result = self.validation.tests("performance", "real_")
        self.assertEqual(result["rows"], 1000000)
        self.assertEqual(result["peak_spool_bytes"], 9007199254740993)

    def test_missing_database_is_explicitly_not_run(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.validation.real_driver("postgres")
        self.assertEqual(self.validation.results[-1]["status"], "not_run")

    def test_real_drivers_share_explicit_fixture_environment_with_matrix(self):
        self.validation.urls = {"postgres": "postgres://isolated@127.0.0.1:55432/postgres",
                                "sqlserver": "sqlserver://isolated@127.0.0.1:51433/master"}
        executable = Path(self.directory.name) / "environment_test"
        executable.write_text("""#!/usr/bin/env python3
import os, sys
assert os.environ['DB_CONNECT_DATA_TASK_PG_URL'].endswith('/postgres')
assert os.environ['DB_CONNECT_DATA_TASK_SQLSERVER_URL'].startswith('sqlserver://')
assert any('sqlserver::' in item or 'real_sqlserver_same_type' in item for item in sys.argv)
print('test result: ok. 1 passed; 0 failed; 0 ignored')
""", encoding="utf-8")
        executable.chmod(0o700)
        self.validation.binary = executable
        with contextlib.redirect_stdout(io.StringIO()):
            self.validation.real_driver("sqlserver")
        self.assertEqual([item["status"] for item in self.validation.results], ["passed", "passed"])
        self.assertEqual(len(self.validation.driver_environment()), 2)


if __name__ == "__main__":
    unittest.main()
