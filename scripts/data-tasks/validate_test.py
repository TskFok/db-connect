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

    def test_mysql_version_is_preserved_in_safe_metrics(self):
        self.fixture("DATA_TASK_MYSQL_VERSION 5.7.44\ntest result: ok. 1 passed; 0 failed; 0 ignored")
        with contextlib.redirect_stdout(io.StringIO()):
            result = self.validation.tests("mysql:5.7.44", "real_mysql_session_contract")
        self.assertEqual(result.get("server_version"), "5.7.44")

    def test_mysql_cross_versions_are_preserved_without_database_output(self):
        self.fixture("DATA_TASK_MYSQL_CROSS_VERSION source=5.7.44 target=9.7.4\ntest result: ok. 1 passed; 0 failed; 0 ignored")
        with contextlib.redirect_stdout(io.StringIO()):
            result = self.validation.tests("mysql-cross", "real_mysql_cross_version_contract")
        self.assertEqual(result.get("source_server_version"), "5.7.44")
        self.assertEqual(result.get("target_server_version"), "9.7.4")

    def test_mariadb_package_versions_are_preserved_in_single_metrics(self):
        for version in ("11.4.5-MariaDB-0+deb12u1", "11.4.5-MariaDB-1:11.4.5+maria~ubu2404"):
            with self.subTest(version=version):
                self.fixture(f"DATA_TASK_MYSQL_VERSION {version}\ntest result: ok. 1 passed; 0 failed; 0 ignored")
                with contextlib.redirect_stdout(io.StringIO()):
                    result = self.validation.tests("mariadb", "real_mariadb_session_contract")
                self.assertEqual(result.get("server_version"), version)

    def test_mariadb_package_versions_are_preserved_in_both_cross_metrics(self):
        versions = ("11.4.5-MariaDB-0+deb12u1", "11.4.5-MariaDB-1:11.4.5+maria~ubu2404")
        for source, target in (versions, versions[::-1]):
            with self.subTest(source=source, target=target):
                self.fixture(f"DATA_TASK_MYSQL_CROSS_VERSION source={source} target={target}\ntest result: ok. 1 passed; 0 failed; 0 ignored")
                with contextlib.redirect_stdout(io.StringIO()):
                    result = self.validation.tests("mariadb-cross", "real_mysql_cross_version_contract")
                self.assertEqual(result.get("source_server_version"), source)
                self.assertEqual(result.get("target_server_version"), target)

    def test_version_metrics_stop_at_spaces_and_newlines_without_retaining_urls(self):
        version = "11.4.5-MariaDB-1:11.4.5+maria~ubu2404"
        private_url = "mysql://business:private@production/database"
        for separator in (" ", "\n", "\t"):
            with self.subTest(separator=repr(separator)):
                self.fixture(f"DATA_TASK_MYSQL_VERSION {version}{separator}{private_url}\n"
                             f"DATA_TASK_MYSQL_CROSS_VERSION source={version} target={version}{separator}{private_url}\n"
                             "test result: ok. 1 passed; 0 failed; 0 ignored")
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    result = self.validation.tests("versions", "real_")
                self.assertEqual(result.get("server_version"), version)
                self.assertEqual(result.get("source_server_version"), version)
                self.assertEqual(result.get("target_server_version"), version)
                self.assertNotIn(private_url, str(self.validation.results) + output.getvalue())

    def test_version_metrics_reject_urls_and_cross_line_source_target_pairs(self):
        for token in ("mysql://business:private@production/database", "11.4.5:mysql://business:private@production/database"):
            with self.subTest(token=token):
                self.fixture(f"DATA_TASK_MYSQL_VERSION {token}\n"
                             f"DATA_TASK_MYSQL_CROSS_VERSION source={token} target=8.4.0\n"
                             f"DATA_TASK_MYSQL_CROSS_VERSION source=8.4.0 target={token}\n"
                             "DATA_TASK_MYSQL_CROSS_VERSION source=11.4.5-MariaDB\ntarget=8.4.0\n"
                             "test result: ok. 1 passed; 0 failed; 0 ignored")
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    result = self.validation.tests("versions", "real_", required_metrics=("server_version",))
                self.assertIsNone(result)
                report = self.validation.results[-1]
                self.assertEqual(report["status"], "not_run")
                self.assertFalse({"server_version", "source_server_version", "target_server_version"} & report.keys())
                self.assertNotIn("private", str(report) + output.getvalue())

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
