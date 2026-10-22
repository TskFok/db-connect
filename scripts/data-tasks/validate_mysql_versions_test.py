"""以可执行 Docker/Rust 夹具验证矩阵工具；不启动 Docker 或连接数据库。"""
import json
import hashlib
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from validate_mysql_versions import image_platform

RUNNER = Path(__file__).with_name("validate_mysql_versions.py")
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
    print('[{"Id":"sha256:fixture-image", "Architecture":"amd64", "RepoDigests":["mysql@sha256:fixture-digest"]}]')
elif args[0] == 'pull': pass
elif args[0] == 'create':
    name = args[args.index('--name') + 1]
    labels = dict(args[i + 1].split('=', 1) for i, x in enumerate(args) if x == '--label')
    image = next(x for x in args if x.startswith('mysql:'))
    environment = pathlib.Path(args[args.index('--env-file') + 1]).read_text()
    state['containers'][name] = {'Name': '/' + name, 'Config': {'Labels': labels}, 'image': image, 'environment': environment}
    state['last_image'] = image
    save()
    if scenario == 'interrupt_create':
        time.sleep(20)
    print(name)
elif args[0] == 'start': pass
elif args[0] == 'port': print('127.0.0.1:' + os.environ['FIXTURE_PORT'])
elif args[0] == 'logs':
    if scenario in ('mysql5_ready', 'mysql5_temporary', 'mysql5_nonadjacent'):
        image = state['containers'][args[-1]]['image']
        timestamp = '261022  6:37:54' if image.startswith('mysql:5.5.') else '2026-10-22T06:37:54.511956Z 0'
        print(timestamp + ' [Note] mysqld: ready for connections.', file=sys.stderr)
        if scenario == 'mysql5_nonadjacent': print('Unrelated initialization message', file=sys.stderr)
        port = 0 if scenario == 'mysql5_temporary' else 3306
        print("Version: '" + image.split(':')[1] + "'  socket: '/var/run/mysqld/mysqld.sock'  port: " + str(port) + "  MySQL Community Server (GPL)", file=sys.stderr)
        print('Unrelated listener configuration port: 3306', file=sys.stderr)
    elif scenario != 'startup_timeout':
        print('MySQL init process done. Ready for start up.')
        print("mysqld: ready for connections. Version: '8.4.0' socket: '/var/run/mysqld/mysqld.sock' port: 3306 MySQL Community Server - GPL.")
elif args[0] == 'inspect':
    if scenario == 'cleanup_daemon_failure': sys.exit(1)
    obj = state['containers'].get(args[-1])
    if not obj:
        print('Error: No such object: ' + args[-1], file=sys.stderr)
        sys.exit(1)
    if scenario == 'wrong_owner': obj['Config']['Labels'] = {}
    print(json.dumps([obj]))
elif args[0] == 'rm':
    if scenario == 'cleanup_failure': sys.exit(1)
    state['containers'].pop(args[-1], None)
    save()
else:
    print('unexpected docker command', file=sys.stderr)
    sys.exit(90)
'''
FAKE_BINARY = r'''#!/usr/bin/env python3
import json, os, pathlib, sys, time
assert '--ignored' in sys.argv and '--exact' in sys.argv
assert 'DB_CONNECT_DATA_TASK_PG_URL' not in os.environ
assert 'DB_CONNECT_DATA_TASK_TLS_CONFIG' not in os.environ
assert os.environ['DB_CONNECT_DATA_TASK_MYSQL_URL'].startswith('mysql://root:')
assert '@127.0.0.1:' in os.environ['DB_CONNECT_DATA_TASK_MYSQL_URL']
state_path = pathlib.Path(os.environ['FIXTURE_STATE'])
state = json.loads(state_path.read_text())
state.setdefault('tests', []).append({'filter': sys.argv[1], 'url': os.environ['DB_CONNECT_DATA_TASK_MYSQL_URL'], 'target': os.environ.get('DB_CONNECT_DATA_TASK_MYSQL_TARGET_URL')})
state_path.write_text(json.dumps(state))
scenario = os.environ.get('FIXTURE_SCENARIO', '')
if scenario == 'test_timeout': time.sleep(20)
if scenario != 'no_version': print('DATA_TASK_MYSQL_VERSION ' + state['last_image'].split(':')[1])
if sys.argv[1].endswith('real_mysql_cross_version_contract') and scenario != 'no_cross_version':
    print('DATA_TASK_MYSQL_CROSS_VERSION source=5.7.44 target=9.7.4')
if scenario == 'zero_tests': print('test result: ok. 0 passed; 0 failed; 0 ignored')
elif scenario == 'test_failure':
    print('private database value')
    print('test result: FAILED. 0 passed; 1 failed; 0 ignored')
    sys.exit(101)
else: print('test result: ok. 1 passed; 0 failed; 0 ignored')
'''


class MySQLImagePlatformTests(unittest.TestCase):
    def test_legacy_official_images_use_amd64_on_arm_hosts(self):
        with patch('validate_mysql_versions.platform.machine', return_value='arm64'):
            for image in ('mysql:5.5', 'mysql:5.5.62', 'mysql:5.6', 'mysql:5.6.51',
                          'mysql:5.7', 'mysql:5.7.9', 'mysql:5.7.44', 'mysql:8.0.11', 'mysql:8.0.28'):
                with self.subTest(image=image):
                    self.assertEqual(image_platform(image, 'auto'), 'linux/amd64')

    def test_explicit_platform_overrides_legacy_image_default(self):
        for image in ('mysql:5.5.62', 'mysql:5.6.51', 'mysql:5.7.9'):
            with self.subTest(image=image):
                self.assertEqual(image_platform(image, 'linux/arm64'), 'linux/arm64')


class MySQLVersionRunnerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="db-connect-mysql-runner-test-")
        self.root = Path(self.directory.name)
        self.state = self.root / "state.json"
        self.state.write_text(json.dumps({"commands": [], "containers": {}}))
        self.report = self.root / "report.json"
        self.binary = self.root / "rust-tests"
        for path, body in ((self.root / "docker", FAKE_DOCKER), (self.binary, FAKE_BINARY)):
            path.write_text(body)
            path.chmod(0o700)
        # TCP 是外部边界；以进程内夹具替代，测试不需要网络或 Docker 权限。
        (self.root / "socket.py").write_text("import contextlib\ndef create_connection(address, timeout):\n    assert address == ('127.0.0.1', 13306)\n    return contextlib.nullcontext()\n")
        self.environment = dict(os.environ, PATH=str(self.root) + os.pathsep + os.environ["PATH"],
                                PYTHONPATH=str(self.root), FIXTURE_STATE=str(self.state), FIXTURE_PORT="13306",
                                DB_CONNECT_DATA_TASK_MYSQL_URL="mysql://business:private@production/database",
                                DB_CONNECT_DATA_TASK_MYSQL_TARGET_URL="mysql://business:private@production/target",
                                DB_CONNECT_DATA_TASK_PG_URL="postgres://business/production",
                                DB_CONNECT_DATA_TASK_TLS_CONFIG="/business/connection.json")

    def tearDown(self):
        self.directory.cleanup()

    def command(self, *extra):
        return [sys.executable, str(RUNNER), "--binary", str(self.binary), "--report", str(self.report),
                "--images", "mysql:5.7.44", "mysql:8.4", "--startup-timeout", "2", "--test-timeout", "2", *extra]

    def run_matrix(self, scenario="", *extra):
        result = subprocess.run(self.command(*extra), env=dict(self.environment, FIXTURE_SCENARIO=scenario),
                                capture_output=True, text=True, timeout=20)
        report = json.loads(self.report.read_text()) if self.report.exists() else None
        return result, report, json.loads(self.state.read_text())

    def test_success_records_each_actual_version_and_removes_isolated_resources(self):
        result, report, state = self.run_matrix()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual([(r['image'], r['server_version'], r['status']) for r in report['results']],
                         [('mysql:5.7.44', '5.7.44', 'passed'), ('mysql:8.4', '8.4', 'passed')])
        creates = [c for c in state['commands'] if c[0] == 'create']
        self.assertEqual(len(creates), 2)
        self.assertNotEqual(creates[0][creates[0].index('--name') + 1], creates[1][creates[1].index('--name') + 1])
        for command in creates:
            self.assertIn('--pull=never', command)
            self.assertEqual(command[command.index('-p') + 1], '127.0.0.1::3306')
            self.assertEqual(command[command.index('--volume') + 1], '/var/lib/mysql')
        self.assertEqual(creates[0][creates[0].index('--platform') + 1], 'linux/amd64')
        self.assertFalse(state['containers'])
        self.assertEqual(len([c for c in state['commands'] if c[:3] == ['rm', '-f', '-v']]), 2)
        self.assertTrue(all(r['status'] == 'removed' for r in report['cleanup']))
        self.assertNotIn('private', result.stdout + self.report.read_text())
        self.assertNotEqual(state['tests'][0]['url'], state['tests'][1]['url'])
        self.assertNotIn('production', json.dumps(state['tests']))

    def test_report_identifies_source_binary_and_resolved_images(self):
        result, report, _state = self.run_matrix()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report.get('binary_sha256'), hashlib.sha256(self.binary.read_bytes()).hexdigest())
        self.assertRegex(report.get('source_revision', ''), r'^[0-9a-f]{40}$')
        self.assertIsInstance(report.get('working_tree_dirty'), bool)
        resolved = report.get('resolved_images', [])
        self.assertEqual(len(resolved), 2)
        self.assertEqual(resolved[0]['image_id'], 'sha256:fixture-image')
        self.assertEqual(resolved[0]['repo_digests'], ['mysql@sha256:fixture-digest'])
        self.assertEqual(resolved[0]['architecture'], 'amd64')

    def test_floating_mysql_80_tag_uses_native_architecture(self):
        result, _report, state = self.run_matrix('', '--images', 'mysql:8.0')
        self.assertEqual(result.returncode, 0, result.stderr)
        create = next(c for c in state['commands'] if c[0] == 'create')
        expected = 'linux/arm64' if platform.machine().lower() in ('arm64', 'aarch64') else 'linux/amd64'
        self.assertEqual(create[create.index('--platform') + 1], expected)

    def test_no_pull_missing_images_are_not_run_and_never_downloaded(self):
        result, report, state = self.run_matrix('missing_image', '--no-pull')
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertTrue(all(r['status'] == 'not_run' for r in report['results']))
        self.assertFalse(any(c[0] in ('pull', 'create') for c in state['commands']))

    def test_missing_fixtures_report_every_planned_cross_version_direction(self):
        result, report, _state = self.run_matrix('missing_image', '--no-pull', '--reference-image', 'mysql:9.7')
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(len(report['results']), 7)
        self.assertTrue(all(r['status'] == 'not_run' for r in report['results']))
        backward = next(r for r in report['results'] if r['name'] == 'reference->mysql:5.7.44')
        self.assertEqual((backward['image'], backward['target_image']), ('mysql:9.7', 'mysql:5.7.44'))

    def test_no_pull_existing_images_disable_create_implicit_downloads(self):
        result, report, state = self.run_matrix('mysql5_ready', '--no-pull', '--images',
                                              'mysql:5.5.62', 'mysql:5.6.51', 'mysql:5.7.9', 'mysql:5.7.44')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(c[0] == 'pull' for c in state['commands']))
        self.assertTrue(all('--pull=never' in c for c in state['commands'] if c[0] == 'create'))
        self.assertEqual(len(report['results']), 4)
        self.assertTrue(all(r['status'] == 'passed' for r in report['results']))
        self.assertEqual(len([c for c in state['commands'] if c[:3] == ['rm', '-f', '-v']]), 4)
        self.assertFalse(state['containers'])

    def test_failed_and_empty_tests_cannot_pass(self):
        for scenario, expected in (('test_failure', 1), ('zero_tests', 2), ('no_version', 2)):
            with self.subTest(scenario=scenario):
                result, report, state = self.run_matrix(scenario)
                self.assertEqual(result.returncode, expected, result.stderr + result.stdout)
                self.assertTrue(all(r['status'] != 'passed' for r in report['results']))
                self.assertFalse(state['containers'])
                self.assertNotIn('private database value', result.stdout + self.report.read_text())

    def test_startup_and_test_timeouts_cleanup_and_are_reported(self):
        for scenario in ('startup_timeout', 'test_timeout'):
            with self.subTest(scenario=scenario):
                result, report, state = self.run_matrix(scenario, '--startup-timeout', '0.2', '--test-timeout', '0.2')
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertTrue(all(r['status'] != 'passed' for r in report['results']))
                self.assertFalse(state['containers'])

    def test_mysql5_two_line_ready_messages_allow_contracts_for_each_version(self):
        result, report, state = self.run_matrix('mysql5_ready', '--images',
                                              'mysql:5.5.62', 'mysql:5.6.51', 'mysql:5.7.9', 'mysql:5.7.44')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual([(r['server_version'], r['status']) for r in report['results']],
                         [('5.5.62', 'passed'), ('5.6.51', 'passed'), ('5.7.9', 'passed'), ('5.7.44', 'passed')])
        self.assertEqual(len(state['tests']), 4)

    def test_mysql5_temporary_or_nonadjacent_ports_do_not_allow_contracts(self):
        for scenario in ('mysql5_temporary', 'mysql5_nonadjacent'):
            with self.subTest(scenario=scenario):
                result, report, state = self.run_matrix(scenario, '--images',
                                                      'mysql:5.5.62', 'mysql:5.6.51', 'mysql:5.7.9', 'mysql:5.7.44',
                                                      '--startup-timeout', '0.2')
                self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
                self.assertEqual(len(report['results']), 4)
                self.assertTrue(all(r['status'] == 'not_run' for r in report['results']))
                self.assertFalse(state.get('tests'))
                self.assertFalse(state['containers'])

    def test_cleanup_failure_is_failure_and_preserves_resource_name(self):
        for scenario in ('cleanup_failure', 'cleanup_daemon_failure', 'wrong_owner'):
            with self.subTest(scenario=scenario):
                result, report, state = self.run_matrix(scenario)
                self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
                self.assertTrue(all(r['status'] == 'failed' and r['container_name'] for r in report['cleanup']))
                self.assertTrue(state['containers'])
                if scenario == 'wrong_owner':
                    names = {r['container_name'] for r in report['cleanup']}
                    self.assertFalse(any(c[0] == 'rm' and c[-1] in names for c in state['commands']))

    def test_reference_runs_both_directions_with_distinct_explicit_urls(self):
        result, report, state = self.run_matrix('', '--reference-image', 'mysql:9.7')
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        cross = [t for t in state['tests'] if t['filter'].endswith('real_mysql_cross_version_contract')]
        self.assertEqual(len(cross), 4)
        for forward, backward in ((cross[0], cross[1]), (cross[2], cross[3])):
            self.assertEqual(forward['url'], backward['target'])
            self.assertEqual(forward['target'], backward['url'])
            self.assertNotEqual(forward['url'], forward['target'])
        self.assertEqual(len(report['results']), 7)
        self.assertFalse(state['containers'])

    def test_cross_version_tests_without_both_version_markers_cannot_pass(self):
        result, report, state = self.run_matrix('no_cross_version', '--reference-image', 'mysql:9.7')
        self.assertEqual(result.returncode, 2, result.stderr + result.stdout)
        cross = [item for item in report['results'] if 'target_image' in item]
        self.assertEqual(len(cross), 4)
        self.assertTrue(all(item['status'] == 'not_run' for item in cross))
        self.assertEqual(len([item for item in report['results'] if item['status'] == 'passed']), 3)
        self.assertFalse(state['containers'])

    def test_sigint_during_create_cleans_up_and_reports_remaining_images_not_run(self):
        with subprocess.Popen(self.command(), env=dict(self.environment, FIXTURE_SCENARIO='interrupt_create'),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True) as process:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                state = json.loads(self.state.read_text())
                if state['containers']:
                    os.killpg(process.pid, signal.SIGINT)
                    break
                time.sleep(0.02)
            stdout, stderr = process.communicate(timeout=5)
        self.assertNotEqual(process.returncode, 0, stderr + stdout)
        self.assertTrue(self.report.exists(), stderr + stdout)
        report = json.loads(self.report.read_text())
        self.assertEqual(len(report['results']), 2)
        self.assertTrue(all(r['status'] != 'passed' for r in report['results']))
        self.assertFalse(json.loads(self.state.read_text())['containers'])

    def test_only_explicit_official_mysql_numeric_tags_are_accepted(self):
        for image in ('mysql:latest', 'mysql:8.4;touch', 'other/mysql:8.4', 'mariadb:11.4'):
            with self.subTest(image=image):
                result = subprocess.run(self.command('--images', image), env=self.environment, capture_output=True, text=True)
                self.assertEqual(result.returncode, 2)
                self.assertFalse(json.loads(self.state.read_text())['commands'])

    def test_reference_image_cannot_duplicate_a_candidate(self):
        result, _report, state = self.run_matrix('', '--reference-image', 'mysql:8.4')
        self.assertEqual(result.returncode, 2)
        self.assertFalse(state['commands'])


if __name__ == '__main__':
    unittest.main()
