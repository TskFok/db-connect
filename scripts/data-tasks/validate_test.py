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

    def test_postgres_versions_are_preserved_without_retaining_package_or_url_text(self):
        private_url = "postgres://business:private@production/database"
        self.fixture(f"DATA_TASK_POSTGRES_VERSION 10.23 (Debian build) {private_url}\n"
                     f"DATA_TASK_POSTGRES_CROSS_VERSION source=10.23 target=18.6 {private_url}\n"
                     "test result: ok. 1 passed; 0 failed; 0 ignored")
        with contextlib.redirect_stdout(io.StringIO()):
            result = self.validation.tests("postgres", "real_")
        self.assertEqual(result.get("server_version"), "10.23")
        self.assertEqual(result.get("source_server_version"), "10.23")
        self.assertEqual(result.get("target_server_version"), "18.6")
        self.assertNotIn("private", str(self.validation.results))

    def test_postgres_version_metrics_reject_malformed_or_cross_line_tokens(self):
        for token in ("18beta1", "18.6postgres://private", "postgres://private", "18.6.1", "18.6-rc1"):
            with self.subTest(token=token):
                self.fixture(f"DATA_TASK_POSTGRES_VERSION {token}\n"
                             f"DATA_TASK_POSTGRES_CROSS_VERSION source={token} target=10.23\n"
                             f"DATA_TASK_POSTGRES_CROSS_VERSION source=10.23 target={token}\n"
                             "DATA_TASK_POSTGRES_CROSS_VERSION source=10.23\ntarget=18.6\n"
                             "test result: ok. 1 passed; 0 failed; 0 ignored")
                with contextlib.redirect_stdout(io.StringIO()):
                    result = self.validation.tests("postgres", "real_", required_metrics=("server_version",))
                self.assertIsNone(result)
                self.assertFalse({"server_version", "source_server_version", "target_server_version"}
                                 & self.validation.results[-1].keys())

    def test_sqlserver_four_part_versions_are_preserved_without_private_text(self):
        self.fixture("DATA_TASK_SQLSERVER_VERSION 16.0.4236.2 sqlserver://private\n"
                     "DATA_TASK_SQLSERVER_CROSS_VERSION source=14.0.3475.1 target=17.0.1000.7 sqlserver://private\n"
                     "test result: ok. 1 passed; 0 failed; 0 ignored")
        with contextlib.redirect_stdout(io.StringIO()):
            result = self.validation.tests("sqlserver", "real_")
        self.assertEqual(result.get("server_version"), "16.0.4236.2")
        self.assertEqual(result.get("source_server_version"), "14.0.3475.1")
        self.assertEqual(result.get("target_server_version"), "17.0.1000.7")
        self.assertNotIn("private", str(self.validation.results))

    def test_sqlserver_versions_reject_partial_suffix_and_cross_line_tokens(self):
        for token in ("16.0.1", "16.0.1.2.3", "16.0.1.2-rc1", "16.0.1.2sqlserver://private", "sqlserver://private"):
            with self.subTest(token=token):
                self.fixture(f"DATA_TASK_SQLSERVER_VERSION {token}\n"
                             f"DATA_TASK_SQLSERVER_CROSS_VERSION source={token} target=17.0.1000.7\n"
                             f"DATA_TASK_SQLSERVER_CROSS_VERSION source=14.0.3475.1 target={token}\n"
                             "DATA_TASK_SQLSERVER_CROSS_VERSION source=14.0.3475.1\ntarget=17.0.1000.7\n"
                             "test result: ok. 1 passed; 0 failed; 0 ignored")
                with contextlib.redirect_stdout(io.StringIO()):
                    result = self.validation.tests("sqlserver", "real_", required_metrics=("server_version",))
                self.assertIsNone(result)
                self.assertFalse({"server_version", "source_server_version", "target_server_version"}
                                 & self.validation.results[-1].keys())

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

    def test_postgres_single_instance_runner_excludes_cross_version_contract(self):
        self.validation.urls = {"postgres": "postgres://isolated@127.0.0.1:55432/postgres"}
        selected_path = Path(self.directory.name) / "selected.txt"
        executable = Path(self.directory.name) / "postgres_tests"
        executable.write_text("""#!/usr/bin/env python3
import os, sys
from pathlib import Path
tests = [
    'db::data_tasks::adapters::postgres::tests::real_postgres_native_snapshot_and_lock_contract',
    'db::data_tasks::adapters::postgres::end_to_end_tests::real_postgres_end_to_end_merge_stale_and_rollback',
    'db::data_tasks::adapters::postgres::atomicity_tests::real_postgres_identity_sequence_lock_cancel_and_default_insert',
    'db::data_tasks::adapters::postgres::version_tests::real_postgres_cross_version_contract',
    'db::data_tasks::cross_type_tests::real_postgres_same_type_all_modes',
    'db::data_tasks::acceptance_network_tests::real_postgres_one_table_has_fixed_query_budget',
]
selected = [test for test in tests if sys.argv[1] in test]
with Path(SELECTED_PATH).open('a') as log:
    log.write('\\n'.join(selected) + '\\n')
failed = sum('::version_tests::' in test and 'DB_CONNECT_DATA_TASK_PG_TARGET_URL' not in os.environ for test in selected)
print(f'test result: {"FAILED" if failed else "ok"}. {len(selected)-failed} passed; {failed} failed; 0 ignored')
raise SystemExit(101 if failed else 0)
""".replace("SELECTED_PATH", repr(str(selected_path))), encoding="utf-8")
        executable.chmod(0o700)
        self.validation.binary = executable
        with contextlib.redirect_stdout(io.StringIO()):
            self.validation.real_driver("postgres")
        self.assertTrue(all(result["status"] == "passed" for result in self.validation.results))
        selected = selected_path.read_text().splitlines()
        self.assertEqual(len(selected), 5)
        self.assertFalse(any("::version_tests::" in name for name in selected))
        for module in ("::postgres::tests::", "::end_to_end_tests::", "::atomicity_tests::",
                       "::cross_type_tests::", "::acceptance_network_tests::"):
            self.assertTrue(any(module in name for name in selected), module)

    def test_sqlserver_single_instance_runner_excludes_cross_version_contract(self):
        self.validation.urls = {"sqlserver": "sqlserver://isolated@127.0.0.1:51433/master"}
        executable = Path(self.directory.name) / "sqlserver_tests"
        executable.write_text("""#!/usr/bin/env python3
import sys
tests = [
 'db::data_tasks::adapters::sqlserver::native_tests::real_sqlserver_native_lossless_snapshot_identity_and_protected_rollback',
 'db::data_tasks::adapters::sqlserver::version_tests::real_sqlserver_cross_version_contract',
 'db::data_tasks::cross_type_tests::real_sqlserver_same_type_executor_and_cancel',
]
selected = [name for name in tests if sys.argv[1] in name]
failed = sum('cross_version' in name for name in selected)
print(f'test result: {"FAILED" if failed else "ok"}. {len(selected)-failed} passed; {failed} failed; 0 ignored')
raise SystemExit(101 if failed else 0)
""", encoding="utf-8")
        executable.chmod(0o700)
        self.validation.binary = executable
        with contextlib.redirect_stdout(io.StringIO()):
            self.validation.real_driver("sqlserver")
        self.assertEqual([row["status"] for row in self.validation.results], ["passed", "passed"])

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
