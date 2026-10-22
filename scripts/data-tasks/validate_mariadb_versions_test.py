"""运行 MariaDB 版本验收入口；仅使用可执行夹具，不访问 Docker 或数据库。"""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import unittest
from urllib.parse import urlsplit

import validate_mysql_versions_test as mysql_tests

RUNNER = Path(__file__).with_name("validate_mariadb_versions.py")
# MariaDB 与 MySQL 共用相同 Docker 边界，只扩展允许的夹具镜像与就绪横幅。
FAKE_DOCKER = mysql_tests.FAKE_DOCKER.replace(
    "x.startswith('mysql:')", "x.startswith(('mysql:', 'mariadb:'))"
).replace("MySQL Community Server", "MariaDB Server").replace(
    "state['last_image'] = image",
    "state['last_image'] = image\n    state.setdefault('env_modes', []).append(pathlib.Path(args[args.index('--env-file') + 1]).stat().st_mode & 0o777)"
)
FAKE_BINARY = r'''#!/usr/bin/env python3
import json, os, pathlib, sys, time
assert '--ignored' in sys.argv and '--exact' in sys.argv
test_filter = sys.argv[1]
is_cross = test_filter.endswith('real_mysql_cross_version_contract')
is_mariadb = test_filter.endswith('real_mariadb_session_contract')
source_key = 'DB_CONNECT_DATA_TASK_MARIADB_URL' if is_mariadb else 'DB_CONNECT_DATA_TASK_MYSQL_URL'
keys = {source_key}
if is_cross: keys.add('DB_CONNECT_DATA_TASK_MYSQL_TARGET_URL')
assert {key for key in os.environ if key.startswith('DB_CONNECT_DATA_TASK_')} == keys
url = os.environ[source_key]
target = os.environ.get('DB_CONNECT_DATA_TASK_MYSQL_TARGET_URL')
state_path = pathlib.Path(os.environ['FIXTURE_STATE'])
state = json.loads(state_path.read_text())
def version(connection):
    assert connection.startswith('mysql://root:') and '@127.0.0.1:' in connection
    for container in state['containers'].values():
        password = container['environment'].splitlines()[0].split('=', 1)[1]
        if password in connection:
            image = container['image']
            return image.split(':')[1] + ('-MariaDB' if image.startswith('mariadb:') else '')
    raise AssertionError('URL is not from an owned fixture')
source_version = version(url)
assert is_cross or (is_mariadb == ('MariaDB' in source_version))
state.setdefault('tests', []).append({'filter': test_filter, 'url': url, 'target': target, 'environment_keys': sorted(keys)})
state_path.write_text(json.dumps(state))
scenario = os.environ.get('FIXTURE_SCENARIO', '')
if scenario == 'test_timeout': time.sleep(20)
if is_cross:
    if scenario != 'no_cross_version':
        print('DATA_TASK_MYSQL_CROSS_VERSION source=' + source_version + ' target=' + version(target))
elif scenario != 'no_version': print('DATA_TASK_MYSQL_VERSION ' + source_version)
if scenario == 'zero_tests': print('test result: ok. 0 passed; 0 failed; 0 ignored')
elif scenario == 'test_failure':
    print('private database value ' + url)
    print('test result: FAILED. 0 passed; 1 failed; 0 ignored')
    sys.exit(101)
else: print('test result: ok. 1 passed; 0 failed; 0 ignored')
'''


class MariaDBVersionRunnerTests(unittest.TestCase):
    def setUp(self):
        mysql_tests.MySQLVersionRunnerTests.setUp(self)
        (self.root / 'docker').write_text(FAKE_DOCKER)
        self.binary.write_text(FAKE_BINARY)
        self.environment['DB_CONNECT_DATA_TASK_MARIADB_URL'] = 'mysql://business:private@production/mariadb'

    tearDown = mysql_tests.MySQLVersionRunnerTests.tearDown
    run_matrix = mysql_tests.MySQLVersionRunnerTests.run_matrix

    def command(self, *extra):
        return [sys.executable, str(RUNNER), '--binary', str(self.binary), '--report', str(self.report),
                '--images', 'mariadb:10.6', 'mariadb:11.4', '--startup-timeout', '2', '--test-timeout', '2', *extra]

    def test_candidates_use_mariadb_contract_and_default_mysql_reference_both_directions(self):
        result, report, state = self.run_matrix()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(report['scope'], 'disposable_official_mariadb_versions_loopback')
        self.assertEqual(report['reference_image'], 'mysql:8.4')
        singles = [row for row in report['results'] if 'target_image' not in row]
        self.assertEqual([(row['image'], row['server_version']) for row in singles],
                         [('mysql:8.4', '8.4'), ('mariadb:10.6', '10.6-MariaDB'), ('mariadb:11.4', '11.4-MariaDB')])
        self.assertEqual(len(report['results']), 7)
        cross = [test for test in state['tests'] if test['target']]
        self.assertEqual(len(cross), 4)
        for forward, backward in ((cross[0], cross[1]), (cross[2], cross[3])):
            self.assertEqual((forward['url'], forward['target']), (backward['target'], backward['url']))
            self.assertNotEqual(forward['url'], forward['target'])
        self.assertEqual(len([test for test in state['tests'] if test['filter'].endswith('real_mariadb_session_contract')]), 2)

    def test_mariadb_reference_uses_mariadb_single_contract(self):
        result, report, state = self.run_matrix('', '--images', 'mariadb:10.2', 'mariadb:12.2',
                                              '--reference-image', 'mariadb:11.4')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        singles = [test for test in state['tests'] if not test['target']]
        self.assertEqual(len(singles), 3)
        self.assertTrue(all(test['filter'].endswith('real_mariadb_session_contract') for test in singles))
        self.assertTrue(all('MariaDB' in row['server_version'] for row in report['results'] if 'target_image' not in row))

    def test_default_versions_are_isolated_and_have_auditable_sanitized_evidence(self):
        command = self.command()
        start = command.index('--images')
        del command[start:start + 3]
        result = subprocess.run(command, env=self.environment, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        report = json.loads(self.report.read_text())
        state = json.loads(self.state.read_text())
        self.assertEqual(report['images'], ['mariadb:11.0', 'mariadb:11.1', 'mariadb:11.2', 'mariadb:11.3',
                                            'mariadb:11.4', 'mariadb:11.5', 'mariadb:11.6', 'mariadb:11.7',
                                            'mariadb:11.8', 'mariadb:12.0', 'mariadb:12.1', 'mariadb:12.2', 'mariadb:12.3'])
        creates = [c for c in state['commands'] if c[0] == 'create']
        self.assertEqual(len(creates), 14)
        self.assertEqual(len({c[c.index('--name') + 1] for c in creates}), 14)
        for command in creates:
            self.assertIn('--pull=never', command)
            self.assertEqual(command[command.index('-p') + 1], '127.0.0.1::3306')
            self.assertEqual(command[command.index('--volume') + 1], '/var/lib/mysql')
            self.assertTrue(command[command.index('--label') + 1].startswith('io.db-connect.mariadb-version-validation='))
            self.assertFalse(Path(command[command.index('--env-file') + 1]).exists())
        self.assertEqual(state['env_modes'], [0o600] * 14)
        self.assertFalse(state['containers'])
        self.assertTrue(all(row['status'] == 'removed' and row['anonymous_data_volume'] == 'removed' for row in report['cleanup']))
        self.assertEqual(report['binary_sha256'], hashlib.sha256(self.binary.read_bytes()).hexdigest())
        self.assertRegex(report['source_revision'], r'^[0-9a-f]{40}$')
        self.assertEqual(len(report['resolved_images']), 14)
        output = result.stdout + result.stderr + self.report.read_text()
        for test in state['tests']:
            self.assertNotIn(test['url'], output)
            self.assertNotIn(urlsplit(test['url']).password, output)
        self.assertNotIn('production', json.dumps(state['tests']))
        self.assertFalse(any(c[0] == 'exec' for c in state['commands']))

    def test_old_mariadb_images_use_amd64_and_platform_override_is_honored(self):
        result, _report, state = self.run_matrix('', '--images', 'mariadb:10.2')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        create = next(c for c in state['commands'] if c[0] == 'create' and 'mariadb:10.2' in c)
        self.assertEqual(create[create.index('--platform') + 1], 'linux/amd64')
        result, _report, state = self.run_matrix('', '--images', 'mariadb:10.2', '--platform', 'linux/arm64')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        create = [c for c in state['commands'] if c[0] == 'create' and 'mariadb:10.2' in c][-1]
        self.assertEqual(create[create.index('--platform') + 1], 'linux/arm64')

    def test_invalid_candidate_reference_and_duplicate_are_rejected_before_docker(self):
        for extra in (('--images', 'mysql:8.4'), ('--images', 'mariadb:latest'),
                      ('--images', 'mariadb:11.4;touch'), ('--images', 'vendor/mariadb:11.4'),
                      ('--reference-image', 'mysql:latest'), ('--reference-image', 'vendor/mysql:8.4'),
                      ('--reference-image', 'mariadb:11.4')):
            with self.subTest(extra=extra):
                result = subprocess.run(self.command(*extra), env=self.environment, capture_output=True, text=True)
                self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
                self.assertFalse(json.loads(self.state.read_text())['commands'])

    def test_missing_images_report_every_unrun_direction_without_downloading(self):
        result, report, state = self.run_matrix('missing_image', '--no-pull')
        self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
        self.assertEqual(len(report['results']), 7)
        self.assertTrue(all(row['status'] == 'not_run' for row in report['results']))
        self.assertFalse(any(c[0] in ('pull', 'create') for c in state['commands']))

    def test_failures_missing_test_markers_and_timeouts_never_pass(self):
        for scenario, expected in (('test_failure', 1), ('zero_tests', 2), ('no_version', 2),
                                   ('startup_timeout', 2), ('mysql5_temporary', 2), ('mysql5_nonadjacent', 2),
                                   ('test_timeout', 1)):
            with self.subTest(scenario=scenario):
                result, report, state = self.run_matrix(scenario, '--startup-timeout', '0.2', '--test-timeout', '0.2')
                self.assertEqual(result.returncode, expected, result.stderr + result.stdout)
                self.assertTrue(all(row['status'] != 'passed' for row in report['results']))
                self.assertFalse(state['containers'])
                self.assertNotIn('private database value', result.stdout + result.stderr + self.report.read_text())

    def test_two_line_mariadb_readiness_and_no_pull_allow_contracts(self):
        result, report, state = self.run_matrix('mysql5_ready', '--no-pull')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue(all(row['status'] == 'passed' for row in report['results']))
        self.assertFalse(any(c[0] == 'pull' for c in state['commands']))

    def test_missing_cross_version_markers_do_not_count_as_transfer_success(self):
        result, report, state = self.run_matrix('no_cross_version')
        self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
        cross = [row for row in report['results'] if 'target_image' in row]
        self.assertEqual(len(cross), 4)
        self.assertTrue(all(row['status'] == 'not_run' for row in cross))
        self.assertFalse(state['containers'])

    def test_cleanup_failure_or_wrong_ownership_is_not_success(self):
        for scenario in ('cleanup_failure', 'cleanup_daemon_failure', 'wrong_owner'):
            with self.subTest(scenario=scenario):
                result, report, state = self.run_matrix(scenario)
                self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
                self.assertTrue(all(row['status'] == 'failed' for row in report['cleanup']))
                if scenario == 'wrong_owner':
                    names = {row['container_name'] for row in report['cleanup']}
                    self.assertFalse(any(c[0] == 'rm' and c[-1] in names for c in state['commands']))

    def test_interruption_during_create_cleans_up_and_preserves_unrun_matrix(self):
        with subprocess.Popen(self.command(), env=dict(self.environment, FIXTURE_SCENARIO='interrupt_create'),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True) as process:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if json.loads(self.state.read_text())['containers']:
                    os.killpg(process.pid, signal.SIGINT)
                    break
                if process.poll() is not None:
                    break
                time.sleep(0.02)
            stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 1, stderr + stdout)
        report = json.loads(self.report.read_text())
        self.assertEqual(len(report['results']), 7)
        self.assertTrue(all(row['status'] == 'not_run' for row in report['results']))
        self.assertTrue(report['interrupted'])
        self.assertFalse(json.loads(self.state.read_text())['containers'])


if __name__ == '__main__':
    unittest.main()
