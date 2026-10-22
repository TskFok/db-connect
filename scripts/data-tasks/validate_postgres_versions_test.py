"""通过可执行 Docker/Rust 夹具验证 PostgreSQL 矩阵，不启动 Docker 或连接数据库。"""
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

RUNNER = Path(__file__).with_name("validate_postgres_versions.py")
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
if args[0] == 'info': print('27.0.0')
elif args[:2] == ['image', 'inspect']:
    if scenario == 'missing_image': sys.exit(1)
    print('[{"Id":"sha256:fixture", "Architecture":"arm64", "RepoDigests":["postgres@sha256:fixture"]}]')
elif args[0] == 'pull': pass
elif args[0] == 'create':
    name = args[args.index('--name') + 1]
    labels = dict(args[i + 1].split('=', 1) for i, value in enumerate(args) if value == '--label')
    image = next(value for value in args if value.startswith('postgres:'))
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
        print('2026-10-22 [48] LOG:  database system is ready to accept connections', file=sys.stderr)
        print('PostgreSQL init process complete; ready for start up.')
        if scenario != 'temporary_ready':
            print('2026-10-22 [1] LOG:  database system is ready to accept connections', file=sys.stderr)
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
    if item and scenario != 'volume_leftover':
        state['volumes'].remove(item['Mounts'][0]['Name'])
    save()
else: sys.exit(90)
'''
FAKE_BINARY = r'''#!/usr/bin/env python3
import json, os, pathlib, sys, time
assert '--ignored' in sys.argv and '--exact' in sys.argv and '--test-threads=1' in sys.argv
test_filter = sys.argv[1]
is_cross = test_filter.endswith('real_postgres_cross_version_contract')
source_key = 'DB_CONNECT_DATA_TASK_PG_URL'
keys = {source_key}
if is_cross: keys.add('DB_CONNECT_DATA_TASK_PG_TARGET_URL')
assert {key for key in os.environ if key.startswith('DB_CONNECT_DATA_TASK_')} == keys
state_path = pathlib.Path(os.environ['FIXTURE_STATE'])
state = json.loads(state_path.read_text())
url = os.environ[source_key]
target = os.environ.get('DB_CONNECT_DATA_TASK_PG_TARGET_URL')
def version(connection):
    assert connection.startswith('postgres://postgres:') and '@127.0.0.1:' in connection
    for item in state['containers'].values():
        password = item['environment'].splitlines()[0].split('=', 1)[1]
        if password in connection:
            version = item['image'].split(':')[1].removesuffix('-alpine')
            return version if '.' in version else version + '.0'
    raise AssertionError('URL is not from an owned fixture')
source_version = version(url)
state.setdefault('tests', []).append({'filter': test_filter, 'url': url, 'target': target})
state_path.write_text(json.dumps(state))
scenario = os.environ.get('FIXTURE_SCENARIO', '')
if scenario == 'test_timeout': time.sleep(20)
if is_cross:
    if scenario != 'no_cross_version':
        print('DATA_TASK_POSTGRES_CROSS_VERSION source=' + source_version + ' target=' + version(target))
elif test_filter.endswith('real_postgres_native_snapshot_and_lock_contract') and scenario != 'no_version':
    print('DATA_TASK_POSTGRES_VERSION ' + source_version)
if scenario == 'zero_tests': print('test result: ok. 0 passed; 0 failed; 0 ignored')
elif scenario == 'test_failure' or (scenario == 'last_case_failure' and test_filter.endswith('real_postgres_cancel_pending_target_lock_is_rolled_back')):
    print('private database value ' + url)
    print('test result: FAILED. 0 passed; 1 failed; 0 ignored')
    sys.exit(101)
else: print('test result: ok. 1 passed; 0 failed; 0 ignored')
'''


class PostgresVersionRunnerTests(unittest.TestCase):
    def setUp(self):
        mysql_tests.MySQLVersionRunnerTests.setUp(self)
        (self.root / 'docker').write_text(FAKE_DOCKER)
        self.binary.write_text(FAKE_BINARY)
        self.environment['DB_CONNECT_DATA_TASK_PG_TARGET_URL'] = 'postgres://business:private@production/target'

    tearDown = mysql_tests.MySQLVersionRunnerTests.tearDown

    def command(self, *extra):
        return [sys.executable, str(RUNNER), '--binary', str(self.binary), '--report', str(self.report),
                '--images', 'postgres:10.23', 'postgres:17-alpine', '--startup-timeout', '2',
                '--test-timeout', '2', *extra]

    def run_matrix(self, scenario='', *extra):
        result = subprocess.run(self.command(*extra), env=dict(self.environment, FIXTURE_SCENARIO=scenario),
                                capture_output=True, text=True, timeout=90)
        report = json.loads(self.report.read_text()) if self.report.exists() else None
        return result, report, json.loads(self.state.read_text())

    def test_every_version_runs_all_single_cases_and_distinct_bidirectional_contracts(self):
        result, report, state = self.run_matrix()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(report['scope'], 'disposable_official_postgres_versions_loopback')
        self.assertEqual(report['reference_image'], 'postgres:18')
        self.assertEqual(len(report['results']), 7)
        singles = [row for row in report['results'] if 'target_image' not in row]
        self.assertEqual([(row['image'], row['server_version']) for row in singles],
                         [('postgres:18', '18.0'), ('postgres:10.23', '10.23'), ('postgres:17-alpine', '17.0')])
        for single in singles:
            self.assertEqual(len(single['cases']), 17)
            self.assertTrue(all(case['status'] == 'passed' for case in single['cases']))
            names = [case['test_filter'] for case in single['cases']]
            self.assertEqual(len(set(names)), 17)
            self.assertEqual(sum('::adapters::postgres::' in name for name in names), 9)
            self.assertEqual(sum('::acceptance_network_tests::' in name for name in names), 7)
            self.assertEqual(sum('::cross_type_tests::' in name for name in names), 1)
            self.assertFalse(any('version_tests' in name for name in names))
        cross = [test for test in state['tests'] if test['target']]
        self.assertEqual(len(cross), 4)
        for forward, backward in ((cross[0], cross[1]), (cross[2], cross[3])):
            self.assertEqual((forward['url'], forward['target']), (backward['target'], backward['url']))
            self.assertNotEqual(forward['url'], forward['target'])
        self.assertEqual(len(state['tests']), 55)

    def test_resources_use_correct_data_volumes_and_cleanup_is_verified(self):
        result, report, state = self.run_matrix()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        creates = [command for command in state['commands'] if command[0] == 'create']
        self.assertEqual(len(creates), 3)
        self.assertEqual(len({command[command.index('--name') + 1] for command in creates}), 3)
        for command, expected_volume in zip(creates, ['/var/lib/postgresql', '/var/lib/postgresql/data', '/var/lib/postgresql/data']):
            self.assertIn('--pull=never', command)
            self.assertEqual(command[command.index('-p') + 1], '127.0.0.1::5432')
            self.assertEqual(command[command.index('--volume') + 1], expected_volume)
            self.assertTrue(command[command.index('--label') + 1].startswith('io.db-connect.postgres-version-validation='))
            self.assertFalse(Path(command[command.index('--env-file') + 1]).exists())
        self.assertEqual(state['env_modes'], [0o600] * 3)
        self.assertFalse(state['containers'])
        self.assertFalse(state['volumes'])
        self.assertTrue(any(command[:2] == ['volume', 'ls'] for command in state['commands']))
        self.assertTrue(all(row['status'] == 'removed' and row['anonymous_data_volume'] == 'removed' for row in report['cleanup']))
        self.assertEqual(report['binary_sha256'], hashlib.sha256(self.binary.read_bytes()).hexdigest())
        self.assertEqual(len(report['resolved_images']), 3)
        output = result.stdout + result.stderr + self.report.read_text()
        for test in state['tests']:
            self.assertNotIn(test['url'], output)
            self.assertNotIn(urlsplit(test['url']).password, output)
        self.assertNotIn('production', json.dumps(state['tests']))
        self.assertFalse(any(command[0] == 'exec' for command in state['commands']))

    def test_default_versions_cover_10_through_18(self):
        command = self.command()
        index = command.index('--images')
        del command[index:index + 3]
        result = subprocess.run(command, env=self.environment, capture_output=True, text=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        report = json.loads(self.report.read_text())
        self.assertEqual(report['images'], ['postgres:10', 'postgres:11', 'postgres:12', 'postgres:13',
                                            'postgres:14', 'postgres:15', 'postgres:16', 'postgres:17'])
        self.assertEqual(len(report['results']), 25)
        self.assertEqual(len(report['cleanup']), 9)

    def test_invalid_tags_and_duplicate_reference_are_rejected_before_docker(self):
        for extra in (('--images', 'postgres:latest'), ('--images', 'postgres:19'),
                      ('--images', 'postgres:9.6'), ('--images', 'vendor/postgres:17'),
                      ('--images', 'postgres:18rc1'), ('--images', 'postgres:18;touch'),
                      ('--images', 'postgres:018'), ('--images', 'postgres:18.06'),
                      ('--images', 'postgres:18.6.1'), ('--images', 'postgres:18-alpine;touch'),
                      ('--reference-image', 'mysql:8.4'), ('--reference-image', 'postgres:17-alpine')):
            with self.subTest(extra=extra):
                result = subprocess.run(self.command(*extra), env=self.environment, capture_output=True, text=True)
                self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
                self.assertFalse(json.loads(self.state.read_text())['commands'])

    def test_missing_images_report_all_directions_without_pulling(self):
        result, report, state = self.run_matrix('missing_image', '--no-pull')
        self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
        self.assertEqual(len(report['results']), 7)
        self.assertTrue(all(row['status'] == 'not_run' for row in report['results']))
        self.assertFalse(any(command[0] in ('pull', 'create') for command in state['commands']))

    def test_reference_major_cannot_match_a_differently_tagged_candidate(self):
        for extra in (('--images', 'postgres:18.6'), ('--images', 'postgres:18-alpine'),
                      ('--reference-image', 'postgres:10')):
            with self.subTest(extra=extra):
                result = subprocess.run(self.command(*extra), env=self.environment, capture_output=True, text=True)
                self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
                self.assertFalse(json.loads(self.state.read_text())['commands'])

    def test_only_final_postgres_process_readiness_can_trigger_tests(self):
        for scenario in ('startup_timeout', 'temporary_ready'):
            with self.subTest(scenario=scenario):
                result, report, state = self.run_matrix(scenario, '--startup-timeout', '0.1')
                self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
                self.assertTrue(all(row['status'] == 'not_run' for row in report['results']))
                self.assertFalse(state.get('tests'))
                self.assertFalse(state['containers'])

    def test_single_failures_or_missing_metrics_block_success_even_if_other_cases_pass(self):
        for scenario, expected in (('last_case_failure', 1), ('zero_tests', 2), ('no_version', 2), ('test_timeout', 1)):
            with self.subTest(scenario=scenario):
                extra = ('--test-timeout', '0.1') if scenario == 'test_timeout' else ()
                result, report, state = self.run_matrix(scenario, *extra)
                self.assertEqual(result.returncode, expected, result.stderr + result.stdout)
                self.assertTrue(all(row['status'] != 'passed' for row in report['results']))
                self.assertFalse(state['containers'])
                self.assertNotIn('private database value', result.stdout + result.stderr + self.report.read_text())

    def test_missing_cross_metrics_never_count_as_success(self):
        result, report, _state = self.run_matrix('no_cross_version')
        self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
        cross = [row for row in report['results'] if 'target_image' in row]
        self.assertEqual(len(cross), 4)
        self.assertTrue(all(row['status'] == 'not_run' for row in cross))

    def test_cleanup_failure_wrong_owner_and_remaining_volumes_never_pass(self):
        for scenario in ('cleanup_failure', 'cleanup_daemon_failure', 'wrong_owner', 'volume_leftover', 'volume_list_failure'):
            with self.subTest(scenario=scenario):
                result, report, state = self.run_matrix(scenario, '--images', 'postgres:17')
                self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
                self.assertTrue(all(row['status'] == 'failed' for row in report['cleanup']))
                if scenario == 'wrong_owner':
                    names = {row['container_name'] for row in report['cleanup']}
                    self.assertFalse(any(command[0] == 'rm' and command[-1] in names for command in state['commands']))

    def test_interrupted_create_cleans_owned_resources_and_reports_unrun_directions(self):
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
        self.assertTrue(report['interrupted'])
        self.assertFalse(json.loads(self.state.read_text())['containers'])


if __name__ == '__main__':
    unittest.main()
