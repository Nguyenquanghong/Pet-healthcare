"""Disposable D5 readiness trial on the Kaggle shared envelope.

Fresh environment profile, private PostgreSQL/RabbitMQ/Redis, non-superuser
roles per component, Linux build + migrations, then the Node readiness
controller (tools/phase2/cqrs/activity/kaggleD5.mjs): grants, 100k fixture, V2
rebuild, full process composition, PID/role ledger + CPU collector, generator
calibration and S/C/P smoke via Nginx. No acceptance timing (policy v9 is not
frozen). Imported only after the notebook verifies every source bundle member.
"""
import hashlib
import importlib.util
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
import time
import uuid
import zipfile
from datetime import datetime, timezone

_spec = importlib.util.spec_from_file_location('activity_native_base', Path(__file__).with_name('activity_native.py'))
base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(base)

PREFIX = 'clinic-activity-d5-'
PUBLIC_FILES = ('summary.json', 'stages.json', 'environment.json', 'readiness.json', 'smoke.json',
                'fresh-profile-and-pid-role-pool-ledger.json', 'plan-and-hashes.json',
                'request-raw.jsonl', 'resource-raw.jsonl')
COMPONENTS = ('core', 'clinic', 'notification')


def validate_d5_paths(root, private, output, run):
    if str(uuid.UUID(run, version=4)) != run or uuid.UUID(run).version != 4:
        raise ValueError('INVALID_RUN')
    if Path(private) != Path('/tmp') / (PREFIX + run):
        raise ValueError('INVALID_PRIVATE_PATH')
    if Path(output) != Path('/kaggle/working') / (PREFIX + run):
        raise ValueError('INVALID_OUTPUT_PATH')
    if Path(root) != Path(private) / 'source':
        raise ValueError('INVALID_SOURCE_PATH')
    for path in (private, root, output):
        if Path(path).is_symlink() or Path(path).resolve() != Path(path):
            raise ValueError('SYMLINK_RUN_PATH')


def _read(path):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def environment_profile(proc=Path('/proc'), cgroup=Path('/sys/fs/cgroup')):
    """Fresh per-session shared-envelope observation; never reused from old runs."""
    cpuinfo = _read(proc / 'cpuinfo') or ''
    model = next((line.split(':', 1)[1].strip() for line in cpuinfo.splitlines() if line.startswith('model name')), None)
    meminfo = _read(proc / 'meminfo') or ''
    total = next((int(line.split()[1]) * 1024 for line in meminfo.splitlines() if line.startswith('MemTotal:')), None)
    cpu_max = _read(cgroup / 'cpu.max')
    if cpu_max is None:
        quota, period = _read(cgroup / 'cpu/cpu.cfs_quota_us'), _read(cgroup / 'cpu/cpu.cfs_period_us')
        cpu_max = None if quota is None else quota + ' ' + (period or '?')
    memory_max = _read(cgroup / 'memory.max') or _read(cgroup / 'memory/memory.limit_in_bytes')
    affinity = sorted(os.sched_getaffinity(0)) if hasattr(os, 'sched_getaffinity') else None
    return {'kind': 'kaggle_shared_envelope_fresh_profile', 'capturedAtUtc': datetime.now(timezone.utc).isoformat(),
            'cpuModel': model, 'architecture': platform.machine(), 'logicalCpus': os.cpu_count(), 'affinity': affinity,
            'cpuMax': cpu_max, 'memoryMax': memory_max, 'memTotalBytes': total, 'kernel': platform.release(),
            'cgroupVersion': 2 if (cgroup / 'cgroup.controllers').exists() else 1,
            'loadAverage': _read(proc / 'loadavg'), 'python': platform.python_version(),
            'isolation': 'NONE_CLAIMED: stack, generator and controller share the kernel envelope'}


class D5Trial(base.FunctionalTrial):
    def __init__(self, root, private, output, run, bundle_sha):
        validate_d5_paths(root, private, output, run)
        if not re.fullmatch('[a-f0-9]{64}', bundle_sha):
            raise ValueError('INVALID_BUNDLE_HASH')
        self.root, self.private, self.output = Path(root), Path(private), Path(output)
        self.run, self.bundle_sha = run, bundle_sha
        self.stage, self.pg_attempted = 'preflight', False
        self.env, self.pg_prefix = base.clean_environment(), []
        self.pg_bin, self.pg_port, self.context = None, None, None
        self.services, self.logs, self.env_profile, self.source_tree = [], [], None, None
        (self.private / 'reports').mkdir(mode=0o700, exist_ok=True)

    def progress(self, stage):
        self.stage = stage
        print(json.dumps({'stage': stage, 'benchmark': False, 'd5': True}), flush=True)

    def profile_environment(self):
        self.env_profile = environment_profile()
        base.write_json(self.private / 'reports/environment.json', self.env_profile)

    def prerequisites(self):
        super().prerequisites()
        missing = [pkg for pkg, binary in (('rabbitmq-server', 'rabbitmq-server'), ('redis-server', 'redis-server')) if not shutil.which(binary)]
        if missing:
            with base.deny_service_autostart():
                self.command(['apt-get', 'install', '-y', '-qq', '--no-install-recommends', *missing], timeout=900)
        if not shutil.which('redis-server') or not (shutil.which('rabbitmq-server') or Path('/usr/lib/rabbitmq/bin/rabbitmq-server').exists()):
            raise RuntimeError('BROKER_PREREQUISITE_MISSING')

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
        schema, marker = 'activity_d5_' + hex_run, 'clinic-activity-d5:' + self.run
        names = ('operator', 'core', 'clinic', 'projector', 'notification')
        roles = {n: 'd5_' + hex_run[:16] + '_' + n for n in names}
        passwords = {n: secrets.token_hex(24) for n in names}
        for n, role in roles.items():
            self.guard_cluster()
            self.sql('CREATE ROLE "' + role + '" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD \'' + passwords[n] + '\';')
        access = {'core': (('operator', 'operator', 4), ('api', 'core', 4)),
                  'clinic': (('operator', 'operator', 4), ('api', 'clinic', 4), ('projector', 'projector', 2)),
                  'notification': (('operator', 'operator', 4), ('api', 'notification', 4))}
        urls = {}
        for component in COMPONENTS:
            database = 'd5_' + hex_run[:16] + '_' + component
            self.guard_cluster()
            self.sql('CREATE DATABASE "' + database + '" OWNER "' + roles['operator'] + '";')
            self.sql('REVOKE ALL ON DATABASE "' + database + '" FROM PUBLIC; COMMENT ON DATABASE "' + database + '" IS \'' + marker + '\';')
            self.sql('CREATE SCHEMA "' + schema + '" AUTHORIZATION "' + roles['operator'] + '"; COMMENT ON SCHEMA "' + schema + '" IS \'' + marker + '\';', database)
            urls[component] = {}
            for name, role_name, limit in access[component]:
                role = roles[role_name]
                self.sql('GRANT CONNECT ON DATABASE "' + database + '" TO "' + role + '";')
                self.sql('GRANT USAGE ON SCHEMA "' + schema + '" TO "' + role + '";', database)
                self.sql('ALTER ROLE "' + role + '" IN DATABASE "' + database + '" SET search_path TO "' + schema + '";')
                urls[component][name] = ('postgresql://' + role + ':' + passwords[role_name] + '@127.0.0.1:' + str(self.pg_port)
                                         + '/' + database + '?schema=' + schema + '&connection_limit=' + str(limit) + '&pool_timeout=5')
        self.context = {'kind': 'clinic-activity-d5-native-v1', 'run': self.run, 'directory': str(self.private),
                        'pgData': str(data), 'pgPort': self.pg_port, 'schema': schema, 'marker': marker,
                        'roles': roles, 'urls': urls, 'fixtureRows': 100000, 'seed': 20261020, 'businessDate': '2030-10-20',
                        'benchmark': False, 'sourceArchiveSha256': self.bundle_sha}

    def _start(self, name, args, env):
        log = (self.private / (name + '.log')).open('w')
        self.logs.append(log)
        child = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, env=env)
        self.services.append((name, child))
        return child

    def _wait_port(self, port, child, seconds=120):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if child.poll() is not None:
                raise RuntimeError('SERVICE_EXITED_DURING_STARTUP')
            with socket.socket() as sock:
                if sock.connect_ex(('127.0.0.1', port)) == 0:
                    return
            time.sleep(.5)
        raise RuntimeError('SERVICE_PORT_TIMEOUT')

    def brokers(self):
        ports = set()
        while len(ports) < 4:
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0)); ports.add(sock.getsockname()[1])
        redis, rabbit, dist, epmd = sorted(ports)
        config = self.private / 'redis.conf'
        config.write_text('bind 127.0.0.1\nport ' + str(redis) + '\ndir ' + str(self.private) + '\nsave ""\nappendonly no\n')
        redis_child = self._start('redis', ['redis-server', str(config)], self.env)
        self._wait_port(redis, redis_child)
        password = secrets.token_hex(24)
        rabbit_config = self.private / 'rabbitmq.conf'
        rabbit_config.write_text('listeners.tcp.1 = 127.0.0.1:' + str(rabbit) + '\ndefault_user = d5\ndefault_pass = ' + password + '\nloopback_users = none\n')
        rabbit_config.chmod(0o600)
        self.rabbit_env = {**self.env, 'RABBITMQ_NODENAME': 'd5_' + self.run.replace('-', '') + '@localhost',
                           'RABBITMQ_CONFIG_FILE': str(rabbit_config.with_suffix('')), 'RABBITMQ_MNESIA_BASE': str(self.private / 'mnesia'),
                           'RABBITMQ_LOG_BASE': str(self.private / 'rabbit-logs'), 'RABBITMQ_PID_FILE': str(self.private / 'rabbit.pid'),
                           'RABBITMQ_DIST_PORT': str(dist), 'ERL_EPMD_PORT': str(epmd), 'ERL_EPMD_ADDRESS': '127.0.0.1',
                           'RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS': '+S 2:2 +A 4 -kernel inet_dist_use_interface {127,0,0,1} -setcookie ' + secrets.token_hex(32),
                           'ERL_CRASH_DUMP': str(self.private / 'erl_crash.dump')}
        binary = '/usr/lib/rabbitmq/bin/rabbitmq-server'
        rabbit_child = self._start('rabbitmq', [binary if Path(binary).exists() else 'rabbitmq-server'], self.rabbit_env)
        self._wait_port(rabbit, rabbit_child, seconds=180)
        self.context.update(broker='amqp://d5:' + password + '@127.0.0.1:' + str(rabbit), redis='redis://127.0.0.1:' + str(redis),
                            pids={'broker': rabbit_child.pid, 'redis': redis_child.pid})

    def build_and_migrate(self):
        env = {**self.env, 'DATABASE_URL': self.context['urls']['core']['operator']}
        self.command(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], env=env, timeout=900)
        cli = ['node', 'node_modules/prisma/build/index.js']
        for schema in ('backend/prisma/schema.prisma', 'backend/prisma/phase2/schema.prisma',
                       'services/clinic/prisma/schema.prisma', 'services/notification/prisma/schema.prisma'):
            self.command([*cli, 'generate', '--schema', schema], env=env, timeout=300)
        self.command(['npm', 'run', 'phase2:build'], env=env, timeout=900)
        self.source_tree = self.verify_source()
        for component, schema in (('core', 'backend/prisma/schema.prisma'), ('clinic', 'services/clinic/prisma/schema.prisma'),
                                  ('notification', 'services/notification/prisma/schema.prisma')):
            self.guard_cluster()
            self.command([*cli, 'migrate', 'deploy', '--schema', schema],
                         env={**self.env, 'DATABASE_URL': self.context['urls'][component]['operator']}, timeout=300)

    def controller(self):
        self.verify_source()
        self.context.update(envProfile=self.env_profile, sourceTreeSha256=self.source_tree)
        path = self.private / 'context.json'
        base.write_json(path, self.context, exclusive=True)
        try:
            self.command(['node', 'tools/phase2/cqrs/activity/kaggleD5.mjs', str(path)], timeout=3600)
        finally:
            for name in ('readiness.json', 'smoke.json', 'fresh-profile-and-pid-role-pool-ledger.json', 'plan-and-hashes.json'):
                if (self.private / 'reports' / name).is_file():
                    os.chmod(self.private / 'reports' / name, 0o600)
        readiness = json.loads((self.private / 'reports/readiness.json').read_text())
        if readiness.get('status') != 'READY_FOR_POLICY_FREEZE_REVIEW':
            raise RuntimeError('READINESS_NOT_COMPLETE')

    def cleanup(self):
        failures = []
        for name, child in reversed(self.services):
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM); child.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=10); failures.append(name + ' forced')
                except ProcessLookupError:
                    pass
        if hasattr(self, 'rabbit_env') and shutil.which('epmd'):
            subprocess.run(['epmd', '-kill'], env=self.rabbit_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        for log in self.logs:
            log.close()
        # The D1 base cleanup validates D1 paths; stop only this run's cluster here.
        try:
            if self.pg_attempted and (self.private / 'pgdata/postmaster.pid').is_file():
                validate_d5_paths(self.root, self.private, self.output, self.run)
                self.guard_cluster()
                self.command([*self.pg_prefix, str(self.pg_bin / 'pg_ctl'), '-D', str(self.private / 'pgdata'), '-m', 'fast', '-w', 'stop'], timeout=45, cwd=self.private)
        except Exception:
            failures.append('postgres stop')
        return failures


def export_reports(private, output, summary, bundle_sha, limit=40_000_000):
    """Positive allowlist; no logs, URLs, context, credentials or fixture rows."""
    output = Path(output)
    base.write_json(output / 'summary.json', summary)
    for name in PUBLIC_FILES:
        source = Path(private) / 'reports' / name
        if name == 'summary.json' or not source.is_file() or source.is_symlink() or source.stat().st_size > limit:
            continue
        text = source.read_text(encoding='utf-8')
        if re.search(r'(postgresql|amqp|redis)://|BEGIN (RSA )?PRIVATE KEY|password', text):
            raise RuntimeError('SECRET_PATTERN_IN_REPORT_' + name)
        (output / name).write_text(text, encoding='utf-8'); os.chmod(output / name, 0o600)
    entries = [{'path': n, 'sha256': hashlib.sha256((output / n).read_bytes()).hexdigest(), 'bytes': (output / n).stat().st_size}
               for n in PUBLIC_FILES if (output / n).is_file()]
    base.write_json(output / 'result-manifest.json', {'sourceArchiveSha256': bundle_sha, 'files': entries, 'performance': 'NOT_RUN'})
    target = output.with_suffix('.zip')
    with zipfile.ZipFile(target, 'x', zipfile.ZIP_DEFLATED) as archive:
        for entry in entries:
            archive.write(output / entry['path'], entry['path'])
        archive.write(output / 'result-manifest.json', 'result-manifest.json')
    return str(target)


def run_trial(root, private, output, run, bundle_sha):
    summary = {'kind': 'CLINIC_ACTIVITY_D5_READINESS_NOT_BENCHMARK', 'harnessRevision': 1, 'run': run, 'status': 'FAIL',
               'performance': 'NOT_RUN', 'policy': 'v9 partial (fullyFrozen=false)', 'resourceClass': 'kaggle_shared_envelope'}
    trial = D5Trial(root, private, output, run, bundle_sha)
    stages = {'kind': 'D5_STAGE_RECEIPTS_NOT_BENCHMARK', 'run': run, 'stages': []}
    try:
        for name, work in (('fresh-environment-profile', trial.profile_environment), ('prerequisites', trial.prerequisites),
                           ('new-private-cluster', trial.cluster), ('private-broker-and-redis', trial.brokers),
                           ('linux-build-and-migrations', trial.build_and_migrate), ('readiness-controller', trial.controller)):
            trial.progress(name)
            receipt = {'stage': name, 'startedAtUtc': datetime.now(timezone.utc).isoformat(), 'status': 'STARTING'}
            stages['stages'].append(receipt)
            try:
                work(); receipt['status'] = 'PASS'
            except Exception:
                receipt['status'] = 'FAIL'; raise
            finally:
                receipt['finishedAtUtc'] = datetime.now(timezone.utc).isoformat()
                base.write_json(Path(private) / 'reports/stages.json', stages)
        summary.update(status='READY_FOR_POLICY_FREEZE_REVIEW')
    except Exception as error:
        summary.update(failedStage=trial.stage, errorType=type(error).__name__, error=str(error)[:200])
    finally:
        trial.progress('cleanup')
        failures = trial.cleanup()
        summary['cleanup'] = 'PASS' if not failures else failures
        base.write_json(Path(private) / 'reports/stages.json', stages)
    summary['download'] = export_reports(private, output, summary, bundle_sha)
    return summary
