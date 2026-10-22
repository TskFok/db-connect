"""运行真实矩阵编排，Docker、TCP、Rust 用可执行边界夹具替代。"""
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

RUNNER = Path(__file__).with_name('validate_sqlserver_versions.py')
PREFIX = 'mcr.microsoft.com/mssql/server:'
FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, pathlib, sys, time
args = sys.argv[1:]
state_path = pathlib.Path(os.environ['FIXTURE_STATE'])
state = json.loads(state_path.read_text())
state['commands'].append(args)
scenario = os.environ.get('FIXTURE_SCENARIO', '')
def save():
    temporary = state_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state))
    temporary.replace(state_path)
save()
if args[0] == 'info': print('29.8.2')
elif args[:2] == ['image', 'inspect']:
    if scenario == 'missing_image': sys.exit(1)
    print(json.dumps([{'Id':'sha256:fixture', 'Os':'linux', 'Architecture':'arm64' if scenario == 'wrong_architecture' else 'amd64', 'RepoDigests':['mcr.microsoft.com/mssql/server@sha256:fixture']}]))
elif args[0] == 'pull': pass
elif args[0] == 'create':
    name = args[args.index('--name') + 1]
    labels = dict(args[i + 1].split('=', 1) for i, value in enumerate(args) if value == '--label')
    image = next(value for value in args if value.startswith('mcr.microsoft.com/mssql/server:'))
    path = pathlib.Path(args[args.index('--env-file') + 1])
    environment = path.read_text()
    volume = 'anonymous_' + name
    state.setdefault('volumes', []).append(volume)
    state.setdefault('env_modes', []).append(path.stat().st_mode & 0o777)
    state['containers'][name] = {'Name': '/' + name, 'Config': {'Labels': labels},
        'image': image, 'environment': environment,
        'Mounts': [{'Type': 'volume', 'Name': volume, 'Destination': args[args.index('--volume') + 1]}]}
    save()
    if scenario == 'interrupt_create': time.sleep(20)
    print(name)
elif args[0] == 'start': pass
elif args[0] == 'port': print('127.0.0.1:' + os.environ['FIXTURE_PORT'])
elif args[0] == 'logs':
    if scenario != 'startup_timeout':
        print('SQL Server is now ready for client connections. This is an informational message.')
        if scenario != 'ready_without_recovery': print('Recovery is complete. This is an informational message only.')
elif args[0] == 'exec':
    assert '--interactive' in args
    assert args[args.index('--env') + 1] == 'SQLCMDPASSWORD'
    name = args[args.index('--env') + 2]
    item = state['containers'][name]
    password = dict(line.split('=', 1) for line in item['environment'].splitlines())['MSSQL_SA_PASSWORD']
    assert os.environ['SQLCMDPASSWORD'] == password
    sql = sys.stdin.read()
    state.setdefault('setup', []).append({'name': name, 'sql': sql})
    save()
    if scenario == 'setup_failure':
        print('private setup failure ' + password, file=sys.stderr)
        sys.exit(1)
elif args[0] == 'inspect':
    if scenario == 'cleanup_daemon_failure': sys.exit(1)
    item = state['containers'].get(args[-1])
    if not item:
        print('Error: No such object: ' + args[-1], file=sys.stderr)
        sys.exit(1)
    if scenario == 'wrong_owner': item['Config']['Labels'] = {}
    print(json.dumps([item]))
elif args[:2] == ['volume', 'ls']:
    if scenario == 'volume_list_failure': sys.exit(1)
    print('\n'.join(state.get('volumes', [])))
elif args[0] == 'rm':
    if scenario == 'cleanup_failure': sys.exit(1)
    item = state['containers'].pop(args[-1], None)
    if item and scenario != 'volume_leftover': state['volumes'].remove(item['Mounts'][0]['Name'])
    save()
else: sys.exit(90)
'''
FAKE_BINARY = r'''#!/usr/bin/env python3
import json, os, pathlib, sys, time
assert '--ignored' in sys.argv and '--exact' in sys.argv and '--test-threads=1' in sys.argv
test_filter = sys.argv[1]
is_cross = test_filter.endswith('real_sqlserver_cross_version_contract')
source_key = 'DB_CONNECT_DATA_TASK_SQLSERVER_URL'
keys = {source_key}
if is_cross: keys.add('DB_CONNECT_DATA_TASK_SQLSERVER_TARGET_URL')
assert {key for key in os.environ if key.startswith('DB_CONNECT_DATA_TASK_')} == keys
state_path = pathlib.Path(os.environ['FIXTURE_STATE'])
state = json.loads(state_path.read_text())
url = os.environ[source_key]
target = os.environ.get('DB_CONNECT_DATA_TASK_SQLSERVER_TARGET_URL')
def version(connection):
    assert connection.startswith('sqlserver://sa:') and '@127.0.0.1:' in connection
    for item in state['containers'].values():
        password = dict(line.split('=', 1) for line in item['environment'].splitlines())['MSSQL_SA_PASSWORD']
        if password in connection:
            assert any(setup['name'] == item['Name'][1:] for setup in state['setup'])
            return {'2017':'14.0.3475.1', '2019':'15.0.4455.2', '2022':'16.0.4236.2', '2025':'17.0.1000.7'}[item['image'].split(':')[1].split('-')[0]]
    raise AssertionError('URL is not from an owned fixture')
source_version = version(url)
state.setdefault('tests', []).append({'filter': test_filter, 'url': url, 'target': target})
state_path.write_text(json.dumps(state))
scenario = os.environ.get('FIXTURE_SCENARIO', '')
if scenario == 'test_timeout': time.sleep(20)
if is_cross:
    if scenario != 'no_cross_version':
        reported_source = ('15.0.4455.2' if source_version.startswith('14.') else '14.0.3475.1') if scenario == 'wrong_cross_source' else source_version
        reported_target = ('15.0.4455.2' if version(target).startswith('14.') else '14.0.3475.1') if scenario == 'wrong_cross_target' else version(target)
        print('DATA_TASK_SQLSERVER_CROSS_VERSION source=' + reported_source + ' target=' + reported_target)
elif test_filter.endswith('real_sqlserver_version_contract') and scenario != 'no_version':
    print('DATA_TASK_SQLSERVER_VERSION ' + (('15.0.4455.2' if source_version.startswith('14.') else '14.0.3475.1') if scenario == 'wrong_single_version' else source_version))
if scenario == 'zero_tests': print('test result: ok. 0 passed; 0 failed; 0 ignored')
elif scenario == 'test_failure' or (scenario == 'last_case_failure' and test_filter.endswith('real_sqlserver_same_type_executor_and_cancel')):
    print('private database value ' + url)
    print('test result: FAILED. 0 passed; 1 failed; 0 ignored')
    sys.exit(101)
else: print('test result: ok. 1 passed; 0 failed; 0 ignored')
'''


class SQLServerVersionRunnerTests(unittest.TestCase):
    def setUp(self):
        mysql_tests.MySQLVersionRunnerTests.setUp(self)
        (self.root / 'docker').write_text(FAKE_DOCKER)
        self.binary.write_text(FAKE_BINARY)
        self.environment['DB_CONNECT_DATA_TASK_SQLSERVER_URL'] = 'sqlserver://business:private@production/master'
        self.environment['DB_CONNECT_DATA_TASK_SQLSERVER_TARGET_URL'] = 'sqlserver://business:private@production/target'

    tearDown = mysql_tests.MySQLVersionRunnerTests.tearDown

    def command(self, *extra):
        return [sys.executable, str(RUNNER), '--binary', str(self.binary), '--report', str(self.report),
                '--images', PREFIX + '2017-latest', PREFIX + '2022-latest', '--startup-timeout', '2',
                '--test-timeout', '2', *extra]

    def run_matrix(self, scenario='', *extra):
        result = subprocess.run(self.command(*extra), env=dict(self.environment, FIXTURE_SCENARIO=scenario),
                                capture_output=True, text=True, timeout=45)
        report = json.loads(self.report.read_text()) if self.report.exists() else None
        return result, report, json.loads(self.state.read_text())

    def test_each_version_runs_five_exact_cases_and_both_distinct_directions(self):
        result, report, state = self.run_matrix()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(report['scope'], 'disposable_official_sqlserver_versions_loopback')
        self.assertEqual(report['reference_image'], PREFIX + '2025-latest')
        self.assertEqual(len(report['results']), 7)
        singles = [row for row in report['results'] if 'target_image' not in row]
        self.assertEqual([row['server_version'] for row in singles], ['17.0.1000.7', '14.0.3475.1', '16.0.4236.2'])
        expected = {'real_sqlserver_rejects_invisible_external_foreign_keys', 'real_sqlserver_rejects_invisible_external_row_security',
                    'real_sqlserver_native_lossless_snapshot_identity_and_protected_rollback',
                    'real_sqlserver_same_type_executor_and_cancel', 'real_sqlserver_version_contract'}
        for single in singles:
            self.assertEqual(len(single['cases']), 5)
            self.assertEqual({case['test_filter'].rsplit('::', 1)[-1] for case in single['cases']}, expected)
        cross = [test for test in state['tests'] if test['target']]
        self.assertEqual(len(cross), 4)
        for forward, backward in ((cross[0], cross[1]), (cross[2], cross[3])):
            self.assertEqual((forward['url'], forward['target']), (backward['target'], backward['url']))
            self.assertNotEqual(forward['url'], forward['target'])
        self.assertEqual(len(state['tests']), 19)

    def test_private_credentials_loopback_amd64_one_setup_and_verified_cleanup(self):
        result, report, state = self.run_matrix()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        creates = [command for command in state['commands'] if command[0] == 'create']
        self.assertEqual(len(creates), 3)
        for command in creates:
            self.assertIn('--pull=never', command)
            self.assertEqual(command[command.index('--platform') + 1], 'linux/amd64')
            self.assertEqual(command[command.index('-p') + 1], '127.0.0.1::1433')
            self.assertEqual(command[command.index('--volume') + 1], '/var/opt/mssql')
            self.assertTrue(command[command.index('--label') + 1].startswith('io.db-connect.sqlserver-version-validation='))
            self.assertFalse(Path(command[command.index('--env-file') + 1]).exists())
        self.assertEqual(state['env_modes'], [0o600] * 3)
        self.assertEqual(len(state['setup']), 3)
        self.assertTrue(all(item['sql'] == 'ALTER DATABASE [master] SET ALLOW_SNAPSHOT_ISOLATION ON;\nGO\n' for item in state['setup']))
        self.assertFalse(state['containers'])
        self.assertFalse(state['volumes'])
        self.assertTrue(all(row['status'] == 'removed' and row['anonymous_data_volume'] == 'removed' for row in report['cleanup']))
        self.assertEqual(report['binary_sha256'], hashlib.sha256(self.binary.read_bytes()).hexdigest())
        output = result.stdout + result.stderr + self.report.read_text() + json.dumps(state['commands'])
        for test in state['tests']:
            self.assertNotIn(test['url'], output)
            self.assertNotIn(urlsplit(test['url']).password, output)
        self.assertNotIn('production', json.dumps(state['tests']))

    def test_defaults_cover_2017_2019_2022_and_2025_reference(self):
        command = self.command()
        index = command.index('--images')
        del command[index:index + 3]
        result = subprocess.run(command, env=self.environment, capture_output=True, text=True, timeout=45)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        report = json.loads(self.report.read_text())
        self.assertEqual(report['images'], [PREFIX + '2017-latest', PREFIX + '2019-latest', PREFIX + '2022-latest'])
        self.assertEqual(len(report['results']), 10)
        self.assertEqual(len(report['cleanup']), 4)

    def test_untrusted_tags_duplicate_reference_and_arm_are_rejected_before_docker(self):
        for extra in (('--images', PREFIX + 'latest'), ('--images', PREFIX + '2016-latest'),
                      ('--images', 'vendor/mssql:2022-latest'), ('--images', PREFIX + '2022-latest;touch'),
                      ('--images', PREFIX + '2025-latest'), ('--platform', 'linux/arm64')):
            with self.subTest(extra=extra):
                result = subprocess.run(self.command(*extra), env=self.environment, capture_output=True, text=True)
                self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
                self.assertFalse(json.loads(self.state.read_text())['commands'])

    def test_missing_or_wrong_architecture_never_creates_fixtures(self):
        for scenario in ('missing_image', 'wrong_architecture'):
            with self.subTest(scenario=scenario):
                result, report, state = self.run_matrix(scenario, '--no-pull')
                self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
                self.assertEqual(len(report['results']), 7)
                self.assertTrue(all(row['status'] == 'not_run' for row in report['results']))
                self.assertFalse(any(command[0] in ('pull', 'create') for command in state['commands']))

    def test_startup_never_polls_sql_and_setup_failure_runs_no_rust(self):
        for scenario in ('startup_timeout', 'setup_failure'):
            with self.subTest(scenario=scenario):
                result, report, state = self.run_matrix(scenario, '--startup-timeout', '0.1')
                self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
                self.assertFalse(state.get('tests'))
                self.assertFalse(state['containers'])
                if scenario == 'startup_timeout': self.assertFalse(state.get('setup'))
                self.assertNotIn('private setup failure', result.stdout + result.stderr + self.report.read_text())

    def test_ready_before_recovery_never_attempts_login_or_runs_tests(self):
        result, report, state = self.run_matrix('ready_without_recovery', '--startup-timeout', '0.1')
        self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
        self.assertFalse(state.get('setup'))
        self.assertFalse(state.get('tests'))
        self.assertFalse(state['containers'])
        self.assertTrue(all(row['status'] == 'not_run' for row in report['results']))

    def test_failed_cases_zero_matches_missing_metrics_and_timeout_never_pass(self):
        for scenario, expected in (('last_case_failure', 1), ('zero_tests', 2), ('no_version', 2), ('test_timeout', 1)):
            with self.subTest(scenario=scenario):
                extra = ('--test-timeout', '0.1') if scenario == 'test_timeout' else ()
                result, report, state = self.run_matrix(scenario, *extra)
                self.assertEqual(result.returncode, expected, result.stderr + result.stdout)
                self.assertTrue(all(row['status'] != 'passed' for row in report['results']))
                self.assertFalse(state['containers'])
                self.assertNotIn('private database value', result.stdout + result.stderr + self.report.read_text())

    def test_missing_cross_versions_block_only_cross_contracts(self):
        result, report, _state = self.run_matrix('no_cross_version')
        self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
        cross = [row for row in report['results'] if 'target_image' in row]
        self.assertEqual(len(cross), 4)
        self.assertTrue(all(row['status'] == 'not_run' for row in cross))

    def test_wrong_actual_major_never_passes_single_or_either_cross_direction(self):
        for scenario in ('wrong_single_version', 'wrong_cross_source', 'wrong_cross_target'):
            with self.subTest(scenario=scenario):
                result, report, state = self.run_matrix(scenario)
                self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
                rows = [row for row in report['results'] if ('target_image' in row) == (scenario != 'wrong_single_version')]
                self.assertTrue(rows)
                self.assertTrue(all(row['status'] == 'failed' for row in rows))
                self.assertFalse(state['containers'])

    def test_wrong_owner_cleanup_failure_and_remaining_volumes_never_pass(self):
        for scenario in ('cleanup_failure', 'cleanup_daemon_failure', 'wrong_owner', 'volume_leftover', 'volume_list_failure'):
            with self.subTest(scenario=scenario):
                result, report, state = self.run_matrix(scenario, '--images', PREFIX + '2022-latest')
                self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
                self.assertTrue(all(row['status'] == 'failed' for row in report['cleanup']))
                if scenario == 'wrong_owner':
                    names = {row['container_name'] for row in report['cleanup']}
                    self.assertFalse(any(command[0] == 'rm' and command[-1] in names for command in state['commands']))

    def test_interrupted_create_cleans_owned_resources_and_records_all_directions(self):
        with subprocess.Popen(self.command(), env=dict(self.environment, FIXTURE_SCENARIO='interrupt_create'),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True) as process:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if json.loads(self.state.read_text())['containers']:
                    os.killpg(process.pid, signal.SIGINT)
                    break
                if process.poll() is not None: break
                time.sleep(0.02)
            stdout, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 1, stderr + stdout)
        report = json.loads(self.report.read_text())
        self.assertEqual(len(report['results']), 7)
        self.assertTrue(report['interrupted'])
        self.assertFalse(json.loads(self.state.read_text())['containers'])


if __name__ == '__main__':
    unittest.main()
