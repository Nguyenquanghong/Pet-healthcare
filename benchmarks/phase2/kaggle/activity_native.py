"""Disposable D1 functional trial; no Q6 runner, load generator or V2 worker.

Imported only after the notebook verifies every source bundle member. Secrets,
database and private logs stay under /tmp; export uses a fixed allowlist.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import secrets
import shutil
import signal
import socket
import subprocess
import tarfile
import time
import urllib.request
import uuid
import zipfile
from contextlib import contextmanager
from datetime import datetime, timezone

PUBLIC_FILES = ('summary.json', 'profile.json', 'fixture.json', 'http.json',
                'parity.json', 'seed-action.json', 'http-action.json',
                'plans.json', 'plans-action.json', 'browser.json', 'stages.json')


@contextmanager
def deny_service_autostart(policy=Path('/usr/sbin/policy-rc.d')):
    content = '#!/bin/sh\nexit 101\n'
    created, identity = False, None
    if policy.exists():
        check = subprocess.run([str(policy), 'postgresql', 'start'], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=5)
        if check.returncode != 101:
            raise RuntimeError('EXISTING_SERVICE_POLICY_DOES_NOT_DENY_AUTOSTART')
    else:
        with policy.open('x') as handle:
            handle.write(content)
        policy.chmod(0o755); created = True; identity = policy.stat().st_ino
    try:
        yield
    finally:
        if created:
            if not policy.is_file() or policy.is_symlink() or policy.stat().st_ino != identity or policy.read_text() != content:
                raise RuntimeError('SERVICE_POLICY_CHANGED_CONCURRENTLY')
            policy.unlink()  # only the exact temporary policy this invocation created


def clean_environment():
    return {k: os.environ[k] for k in ('PATH', 'HOME', 'LANG', 'TMPDIR') if k in os.environ}


def validate_run_paths(root, private, output, run):
    if str(uuid.UUID(run, version=4)) != run or uuid.UUID(run).version != 4:
        raise ValueError('INVALID_RUN')
    if Path(private) != Path('/tmp') / ('clinic-activity-d1-' + run):
        raise ValueError('INVALID_PRIVATE_PATH')
    if Path(output) != Path('/kaggle/working') / ('clinic-activity-d1-' + run):
        raise ValueError('INVALID_OUTPUT_PATH')
    if Path(root) != Path(private) / 'source':
        raise ValueError('INVALID_SOURCE_PATH')
    for path in (private, root, output):
        if Path(path).is_symlink() or Path(path).resolve() != Path(path):
            raise ValueError('SYMLINK_RUN_PATH')


def write_json(path, value, exclusive=False):
    with Path(path).open('x' if exclusive else 'w', encoding='utf-8') as handle:
        os.chmod(path, 0o600)
        json.dump(value, handle, indent=2)
        handle.write('\n')


class FunctionalTrial:
    def __init__(self, root, private, output, run, bundle_sha):
        validate_run_paths(root, private, output, run)
        if not re.fullmatch('[a-f0-9]{64}', bundle_sha):
            raise ValueError('INVALID_BUNDLE_HASH')
        self.root, self.private, self.output = Path(root), Path(private), Path(output)
        self.run, self.bundle_sha = run, bundle_sha
        self.stage, self.pg_attempted = 'preflight', False
        self.env, self.pg_prefix = clean_environment(), []
        self.env['PLAYWRIGHT_BROWSERS_PATH'] = str(self.private / 'playwright-browsers')
        self.pg_bin, self.pg_port = None, None
        self.context = None

    def progress(self, stage):
        self.stage = stage
        print(json.dumps({'stage': stage, 'benchmark': False}), flush=True)

    def command(self, args, *, env=None, input=None, timeout=900, cwd=None):
        # Never echo argv/environment: generate/migrate URLs contain credentials.
        with (self.private / 'commands.log').open('ab') as log:
            os.chmod(self.private / 'commands.log', 0o600)
            process = subprocess.Popen(args, cwd=cwd or self.root, env=env or self.env,
                                       stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            if input is not None:
                process.stdin.write(input.encode()); process.stdin.close()
            end = time.monotonic() + timeout
            try:
                while True:
                    try:
                        code = process.wait(timeout=min(30, max(.1, end-time.monotonic())))
                        if code:
                            raise RuntimeError('PRIVATE_COMMAND_FAILED')
                        return
                    except subprocess.TimeoutExpired:
                        if time.monotonic() >= end:
                            raise TimeoutError('PRIVATE_COMMAND_TIMEOUT')
                        print(json.dumps({'stage': self.stage, 'running': True}), flush=True)
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL); process.wait(timeout=5)

    def capture(self, args, *, env=None, input=None, cwd=None, stderr=subprocess.DEVNULL):
        return subprocess.check_output(args, cwd=cwd or self.root, env=env or self.env,
                                       input=input, text=True, stderr=stderr, timeout=15).strip()

    def verify_source(self):
        archive = self.private / 'source.zip'
        raw = archive.read_bytes()
        if hashlib.sha256(raw).hexdigest() != self.bundle_sha:
            raise RuntimeError('SOURCE_ARCHIVE_CHANGED')
        with zipfile.ZipFile(archive) as z:
            manifest = json.loads(z.read('bundle-manifest.json'))
        for row in manifest['files']:
            path = self.root / row['path']
            if path.is_symlink() or not path.resolve().is_relative_to(self.root) or hashlib.sha256(path.read_bytes()).hexdigest() != row['sha256']:
                raise RuntimeError('SOURCE_CHANGED_AFTER_VERIFICATION')
        return manifest['sourceTreeSha256']

    def prerequisites(self):
        if platform.system() != 'Linux' or not Path('/kaggle/working').is_dir() or os.geteuid() != 0:
            raise RuntimeError('KAGGLE_LINUX_ROOT_REQUIRED')
        self.pg_bin = Path('/usr/lib/postgresql/16/bin')
        packages = []
        if not all((self.pg_bin / n).is_file() for n in ('initdb', 'pg_ctl', 'psql', 'postgres')):
            packages += ['postgresql-16', 'postgresql-client-16']
        if not shutil.which('nginx'):
            packages += ['nginx']
        if packages:
            with deny_service_autostart():
                self.command(['apt-get', 'update', '-qq'], timeout=600)
                # postgresql-common documents create_main_cluster=false:
                # https://manpages.debian.org/testing/postgresql-common/pg_createcluster.1.en.html
                # Install common first, then suppress the server package's
                # default /var/lib cluster; preserve the original config bytes.
                if 'postgresql-16' in packages:
                    self.command(['apt-get', 'install', '-y', '-qq', '--no-install-recommends', 'postgresql-common'], timeout=600)
                    config = Path('/etc/postgresql-common/createcluster.conf')
                    original = config.read_bytes()
                    modified = original + b'\ncreate_main_cluster = false\n'
                    inode = config.stat().st_ino
                    config.write_bytes(modified)
                    try:
                        self.command(['apt-get', 'install', '-y', '-qq', '--no-install-recommends',
                                      *packages, 'ca-certificates', 'xz-utils'], timeout=900)
                    finally:
                        if config.is_symlink() or config.stat().st_ino != inode or config.read_bytes() != modified:
                            raise RuntimeError('CLUSTER_CONFIG_CHANGED_CONCURRENTLY')
                        config.write_bytes(original)
                else:
                    self.command(['apt-get', 'install', '-y', '-qq', '--no-install-recommends',
                                  *packages, 'ca-certificates', 'xz-utils'], timeout=900)
        if not shutil.which('runuser') or not shutil.which('nginx'):
            raise RuntimeError('NATIVE_PREREQUISITE_MISSING')
        if ' 16.' not in self.capture([str(self.pg_bin / 'postgres'), '--version']):
            raise RuntimeError('POSTGRES_MAJOR_MISMATCH')
        current = shutil.which('node')
        if current is None or self.capture([current, '--version']) != 'v24.16.0':
            architecture = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine())
            if architecture is None:
                raise RuntimeError('UNSUPPORTED_NODE_ARCHITECTURE')
            name = 'node-v24.16.0-linux-' + architecture + '.tar.xz'
            origin = 'https://nodejs.org/dist/v24.16.0/'
            sums = urllib.request.urlopen(origin + 'SHASUMS256.txt', timeout=30).read().decode()
            expected = next(row.split()[0] for row in sums.splitlines() if row.split()[-1] == name)
            if not re.fullmatch('[a-f0-9]{64}', expected):
                raise RuntimeError('NODE_DIGEST_INVALID')
            archive = self.private / name
            urllib.request.urlretrieve(origin + name, archive)
            if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
                raise RuntimeError('NODE_ARCHIVE_DIGEST_MISMATCH')
            with tarfile.open(archive) as tar:
                tar.extractall(self.private, filter='data')
            self.env['PATH'] = str(self.private / name.removesuffix('.tar.xz') / 'bin') + ':' + self.env['PATH']
        if self.capture(['node', '--version']) != 'v24.16.0':
            raise RuntimeError('NODE_VERSION_MISMATCH')

    def sql(self, query, database='postgres'):
        return self.capture([*self.pg_prefix, str(self.pg_bin / 'psql'), '-X', '-At', '-h', str(self.private),
                             '-p', str(self.pg_port), '-U', 'postgres', '-d', database,
                             '-v', 'ON_ERROR_STOP=1'], input=query, cwd=self.private)

    def guard_cluster(self):
        actual = self.sql('SHOW data_directory;')
        if Path(actual).resolve() != self.private / 'pgdata':
            raise RuntimeError('WRONG_POSTGRES_CLUSTER')

    def cluster(self):
        account = pwd.getpwnam('postgres')
        os.chown(self.private, account.pw_uid, account.pw_gid)
        self.pg_prefix = ['runuser', '-u', 'postgres', '--']
        data = self.private / 'pgdata'
        if data.exists():
            raise RuntimeError('PGDATA_ALREADY_EXISTS')
        self.command([*self.pg_prefix, str(self.pg_bin / 'initdb'), '-D', str(data), '-U', 'postgres',
                      '--auth-local=trust', '--auth-host=scram-sha-256', '--no-instructions'], timeout=90, cwd=self.private)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); self.pg_port = sock.getsockname()[1]
        self.pg_attempted = True
        self.command([*self.pg_prefix, str(self.pg_bin / 'pg_ctl'), '-D', str(data), '-l', str(self.private / 'postgres.log'),
                      '-o', '-h 127.0.0.1 -p ' + str(self.pg_port) + ' -k ' + str(self.private), '-w', 'start'], timeout=90, cwd=self.private)
        self.guard_cluster()
        hex_run = self.run.replace('-', '')
        schema, marker = 'activity_' + hex_run, 'clinic-activity:' + self.run
        roles = {name: 'activity_' + hex_run + '_' + name for name in ('operator', 'core', 'clinic', 'reader')}
        passwords = {name: secrets.token_hex(24) for name in roles}
        for name, role in roles.items():
            self.guard_cluster()
            self.sql('CREATE ROLE "' + role + '" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD \'' + passwords[name] + '\';')
        urls = {}
        for component in ('core', 'clinic'):
            self.guard_cluster()
            database = 'activity_' + hex_run + '_' + component
            self.sql('CREATE DATABASE "' + database + '" OWNER "' + roles['operator'] + '";')
            self.sql('REVOKE ALL ON DATABASE "' + database + '" FROM PUBLIC; COMMENT ON DATABASE "' + database + '" IS \'' + marker + '\';')
            self.sql('CREATE SCHEMA "' + schema + '" AUTHORIZATION "' + roles['operator'] + '"; COMMENT ON SCHEMA "' + schema + '" IS \'' + marker + '\';', database)
            urls[component] = {}
            for access, name in [('operator', 'operator'), ('api', component), *([('reader', 'reader')] if component == 'clinic' else [])]:
                self.sql('GRANT CONNECT ON DATABASE "' + database + '" TO "' + roles[name] + '";')
                self.sql('GRANT USAGE ON SCHEMA "' + schema + '" TO "' + roles[name] + '";', database)
                self.sql('ALTER ROLE "' + roles[name] + '" IN DATABASE "' + database + '" SET search_path TO "' + schema + '";')
                if access != 'operator':
                    self.sql('ALTER ROLE "' + roles[name] + '" IN DATABASE "' + database + '" SET default_transaction_read_only=on;')
                limit = '1' if access == 'reader' else '2'
                urls[component][access] = ('postgresql://' + roles[name] + ':' + passwords[name] + '@127.0.0.1:' + str(self.pg_port)
                                           + '/' + database + '?schema=' + schema + '&connection_limit=' + limit + '&pool_timeout=1')
        self.context = {'kind': 'clinic-activity-d1-native-v1', 'run': self.run, 'directory': str(self.private),
                        'pgData': str(data), 'pgPort': self.pg_port, 'schema': schema, 'marker': marker,
                        'fixtureRows': 10000, 'seed': 20261020, 'businessDate': '2030-10-20',
                        'benchmark': False, 'authorizedTrialSetup': True, 'sourceArchiveSha256': self.bundle_sha, 'urls': urls}
        write_json(self.private / 'context.json', self.context, exclusive=True)

    def build_and_migrate(self):
        env = {**self.env, 'DATABASE_URL': self.context['urls']['core']['operator']}
        self.command(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], env=env, timeout=900)
        cli = ['node', 'node_modules/prisma/build/index.js']
        for schema in ('backend/prisma/schema.prisma', 'backend/prisma/phase2/schema.prisma', 'services/clinic/prisma/schema.prisma'):
            self.command([*cli, 'generate', '--schema', schema], env=env, timeout=300)
        self.command(['npm', 'run', 'activity:build'], env=env, timeout=600)
        self.command(['npm', 'run', 'build', '-w', 'frontend'], env=env, timeout=600)
        with deny_service_autostart():
            self.command(['node', 'node_modules/playwright/cli.js', 'install', '--with-deps', 'chromium'], timeout=900)
        self.verify_source()
        self.action('identity')
        for component, schema in [('core', 'backend/prisma/schema.prisma'), ('clinic', 'services/clinic/prisma/schema.prisma')]:
            self.guard_cluster(); self.action('identity')
            self.command([*cli, 'migrate', 'deploy', '--schema', schema],
                         env={**self.env, 'DATABASE_URL': self.context['urls'][component]['operator']}, timeout=300)
        self.action('identity')
        for component in ('core', 'clinic'):
            self.guard_cluster()
            database = 'activity_' + self.run.replace('-', '') + '_' + component
            roles = ['activity_' + self.run.replace('-', '') + '_' + component]
            if component == 'clinic':
                roles += ['activity_' + self.run.replace('-', '') + '_reader']
            for role in roles:
                self.sql('GRANT SELECT ON ALL TABLES IN SCHEMA "' + self.context['schema'] + '" TO "' + role + '";', database)

    def action(self, name):
        self.verify_source()
        self.command(['node', 'tools/phase2/cqrs/activity/trial.mjs', '--context', str(self.private / 'context.json'), '--action', name], timeout=180)

    def parity(self):
        c = self.context
        context = {'run': self.run, 'database': 'activity_' + self.run.replace('-', '') + '_clinic',
                   'role': 'activity_' + self.run.replace('-', '') + '_reader', 'schema': c['schema'], 'marker': c['marker'],
                   'fixtureRows': 10000, 'seed': 20261020, 'businessDate': '2030-10-20'}
        path = self.private / 'parity-context.json'; write_json(path, context, exclusive=True)
        self.command(['node', 'tools/phase2/cqrs/activity/postgres.integration.mjs', '--context', str(path)],
                     env={**self.env, 'ACTIVITY_TRIAL_DATABASE_URL': c['urls']['clinic']['reader']}, timeout=90)
        report = self.root / 'test-results/phase2/cqrs/activity' / ('pg-' + self.run) / 'report.json'
        value = json.loads(report.read_text())
        if value.get('status') != 'PASS_IN_SCOPE' or len(value.get('cases', [])) != 18:
            raise RuntimeError('PARITY_NOT_COMPLETE')
        write_json(self.private / 'reports/parity.json', value)

    def profile(self):
        self.guard_cluster()
        files = []
        for directory in ('backend/dist', 'services/clinic/dist', 'packages/runtime/dist', 'packages/contracts/dist', 'packages/messaging/dist', 'node_modules/.prisma/client', 'frontend/dist'):
            for path in sorted((self.root / directory).rglob('*')):
                if path.is_file() and not path.is_symlink():
                    files.append({'path': path.relative_to(self.root).as_posix(), 'bytes': path.stat().st_size,
                                  'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        write_json(self.private / 'reports/profile.json', {
            'kind': 'D1_FUNCTIONAL_TRIAL_NOT_PERFORMANCE_ENVIRONMENT', 'run': self.run,
            'sourceArchiveSha256': self.bundle_sha, 'verifiedSourceTreeSha256': self.verify_source(), 'node': self.capture(['node', '--version']),
            'npm': self.capture(['npm', '--version']), 'postgresServerVersion': self.sql('SHOW server_version;'),
            'prismaVersion': json.loads((self.root / 'node_modules/prisma/package.json').read_text())['version'],
            'playwrightVersion': json.loads((self.root / 'node_modules/playwright/package.json').read_text())['version'],
            'nginxVersion': self.capture(['nginx', '-v'], stderr=subprocess.STDOUT),
            'processComposition': 'one PostgreSQL cluster; Node hosts real Core/Clinic/static frontend; Nginx and Chromium per source/cached mode',
            'poolLimits': {'operatorPerClient': 2, 'coreApi': 2, 'clinicApi': 2, 'parityReader': 1},
            'runtimeBackgroundWorkers': 'NOT_STARTED', 'listMode': 'authoritative', 'resourceEnforcement': 'UNVERIFIED',
            'd0': 'PARTIAL_ENVIRONMENT', 'performance': 'NOT_RUN', 'linuxBuildFiles': files})

    def cleanup(self):
        if self.pg_attempted and (self.private / 'pgdata/postmaster.pid').is_file():
            validate_run_paths(self.root, self.private, self.output, self.run)
            self.guard_cluster()
            self.command([*self.pg_prefix, str(self.pg_bin / 'pg_ctl'), '-D', str(self.private / 'pgdata'), '-m', 'fast', '-w', 'stop'], timeout=45, cwd=self.private)


def export_reports(private, output, summary, bundle_sha):
    # Positive allowlist only. No raw logs, fixture rows, URLs, keys or context.
    output = Path(output)
    write_json(output / 'summary.json', summary)
    for name in PUBLIC_FILES:
        source = Path(private) / 'reports' / name
        if name != 'summary.json' and source.is_file() and not source.is_symlink():
            if source.stat().st_size > 2_000_000:
                continue
            value = json.loads(source.read_text(encoding='utf-8'))
            write_json(output / name, value)
    entries = [{'path': name, 'sha256': hashlib.sha256((output / name).read_bytes()).hexdigest(),
                'bytes': (output / name).stat().st_size} for name in PUBLIC_FILES if (output / name).is_file()]
    write_json(output / 'result-manifest.json', {'sourceArchiveSha256': bundle_sha, 'files': entries, 'performance': 'NOT_RUN'})
    target = output.with_suffix('.zip')
    with zipfile.ZipFile(target, 'x', zipfile.ZIP_DEFLATED) as archive:
        for entry in entries:
            archive.write(output / entry['path'], entry['path'])
        archive.write(output / 'result-manifest.json', 'result-manifest.json')
    return str(target)


def run_trial(root, private, output, run, bundle_sha):
    summary = {'kind': 'CLINIC_ACTIVITY_D1_FUNCTIONAL_NOT_BENCHMARK', 'harnessRevision': 3, 'run': run, 'status': 'FAIL',
               'performance': 'NOT_RUN', 'd0': 'PARTIAL_ENVIRONMENT', 'd1': 'PARTIAL_UNTIL_ACTUAL_RESULTS',
               'resourceEnforcement': 'UNVERIFIED', 'fullDeploymentValidated': False}
    trial = FunctionalTrial(root, private, output, run, bundle_sha)
    stages = {'kind': 'D1_FUNCTIONAL_STAGE_RECEIPTS_NOT_BENCHMARK', 'run': run, 'performance': 'NOT_RUN', 'stages': []}
    try:
        for name, work in [('prerequisites', trial.prerequisites), ('new-private-cluster', trial.cluster),
                           ('linux-build-and-existing-migrations', trial.build_and_migrate), ('seed-10k-and-reconcile', lambda: trial.action('seed')),
                           ('read-only-pg-parity', trial.parity), ('read-only-explain-no-analyze', lambda: trial.action('plans')),
                           ('direct-nginx-and-browser-functional', lambda: trial.action('http')),
                           ('actual-trial-profile', trial.profile)]:
            trial.progress(name)
            receipt = {'stage': name, 'startedAtUtc': datetime.now(timezone.utc).isoformat(), 'status': 'STARTING'}
            stages['stages'].append(receipt)
            try:
                work(); receipt['status'] = 'PASS'
            except Exception:
                receipt['status'] = 'FAIL'; raise
            finally:
                receipt['finishedAtUtc'] = datetime.now(timezone.utc).isoformat()
        summary.update(status='PASS_IN_FUNCTIONAL_SCOPE', d1='PG_PLANS_WARM_CACHE_AND_GATEWAY_BROWSER_PASS_REVIEW_REPORTS')
    except Exception as error:
        summary.update(failedStage=trial.stage, errorType=type(error).__name__)
    finally:
        try:
            trial.cleanup(); summary['ownedProcessesShutdown'] = 'PASS'
        except Exception as error:
            summary.update(status='FAIL', ownedProcessesShutdown='FAIL', cleanupErrorType=type(error).__name__)
        (Path(private) / 'reports').mkdir(exist_ok=True)
        write_json(Path(private) / 'reports/stages.json', stages)
        summary['download'] = export_reports(private, output, summary, bundle_sha)
    return summary
