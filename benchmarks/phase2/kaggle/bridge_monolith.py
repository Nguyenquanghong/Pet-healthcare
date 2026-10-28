"""One M member of the bridge study: the pre-split monolith (48d01c3) under the
bridge PCN workload, with the same evidence files as pcn_runner.run_pcn.

Fresh PostgreSQL cluster per member under /tmp, migrate deploy, then the phase-1
fixture (prepare_fixture.mjs from M itself, pcn_checks.mjs seed from the harness:
one pet and one row per read resource per owner, as pcn_dataset.mjs does for H).
The monolith runs with its own defaults (Prisma pool, auth limiter); the generator
is the same locustfile as H. The M tree must already be built (npm ci + build).
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import platform
import secrets
import subprocess
import sys
import time
import urllib.request
import uuid

from benchmark import reconcile
from native_stack import free_port
from pcn_runner import PINNING_METHOD, generator_ok, http_summary, observed_affinity, resource_sample, server_taskset_prefix, stop_load, taskset_prefix, verdict

PROTOCOL = 'bridge-m-h-pcn-v1'


class Monolith:
    def __init__(self, root, users, server_cpus=None):
        self.root, self.users = Path(root).resolve(strict=True), users
        # Bridge VM study: database and API run on the server CPUs, the controller on the generator CPU.
        self.server_prefix = server_taskset_prefix(server_cpus)
        self.run = str(uuid.uuid4())
        self.private = Path('/tmp') / ('bridge-m-' + self.run)
        self.private.mkdir(mode=0o700)
        self.api = None
        self.pg_started = False
        self.logs = []

    def command(self, args, env=None, timeout=300, **kwargs):
        with (self.private / 'setup.log').open('a') as log:
            result = subprocess.run([*self.server_prefix, *args], stdout=log, stderr=subprocess.STDOUT, timeout=timeout, env=env, **kwargs)
        if result.returncode:
            raise RuntimeError('Monolith setup command failed; inspect private setup.log')

    def psql(self, sql):
        return subprocess.run(['psql', '-h', str(self.private), '-p', str(self.port), '-U', 'postgres', '-d', 'pet_bridge_test',
                               '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], check=True, capture_output=True, text=True, timeout=60).stdout

    def start(self):
        import pwd
        self.pg_bin = Path(subprocess.check_output(['pg_config', '--bindir'], text=True).strip())
        prefix = []
        if os.geteuid() == 0:
            user = pwd.getpwnam('postgres')
            os.chown(self.private, user.pw_uid, user.pw_gid)
            prefix = ['runuser', '-u', 'postgres', '--']
        self.prefix, self.port, api_port = prefix, free_port(), free_port()
        data = self.private / 'pgdata'
        # Loopback-only throwaway cluster; trust auth like the phase-1 PCN runner.
        self.command(prefix + [str(self.pg_bin / 'initdb'), '-D', str(data), '-U', 'postgres', '-A', 'trust', '--no-instructions'])
        self.command(prefix + [str(self.pg_bin / 'pg_ctl'), '-D', str(data), '-l', str(self.private / 'postgres.log'),
                               '-o', f'-h 127.0.0.1 -p {self.port} -k {self.private}', '-w', 'start'])
        self.pg_started = True
        self.command(['createdb', '-h', str(self.private), '-p', str(self.port), '-U', 'postgres', 'pet_bridge_test'])
        clean = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'LANG', 'TMPDIR')}
        self.env = {**clean, 'DATABASE_URL': f'postgresql://postgres@127.0.0.1:{self.port}/pet_bridge_test?schema=public',
                    'JWT_SECRET': secrets.token_urlsafe(40), 'PORT': str(api_port), 'VNPAY_ENABLED': 'false',
                    'BANK_TRANSFER_DEMO': 'true', 'CORS_ORIGIN': 'http://127.0.0.1:5179'}
        self.command(['npm', 'run', 'db:deploy', '-w', 'backend'], env=self.env, cwd=self.root)
        fixture = self.private / 'fixture.json'
        seed = {**self.env, 'BENCH_FIXTURE': str(fixture), 'BENCH_PASSWORD': secrets.token_urlsafe(24),
                'BENCH_USERS': str(self.users), 'BENCH_SEED': 'pcn', 'PCN_CHECK_OUTPUT': str(self.private / 'seed.json')}
        self.command(['node', 'benchmarks/kaggle/prepare_fixture.mjs'], env=seed, cwd=self.root)
        self.command(['node', 'benchmarks/kaggle/pcn_checks.mjs', 'seed'], env=seed, cwd=self.root)
        users = json.loads(fixture.read_text())['users']
        self.fixture_path = self.private / 'pcn-fixture.json'
        self.fixture_path.write_text(json.dumps({'users': [{k: u[k] for k in ('token', 'petId', 'qrToken')} for u in users]}))
        self.fixture_path.chmod(0o600)
        log = (self.private / 'api.log').open('w')
        self.logs.append(log)
        self.api = subprocess.Popen([*self.server_prefix, 'node', 'backend/dist/src/index.js'], cwd=self.root, env=self.env,
                                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.base_url = f'http://127.0.0.1:{api_port}'
        deadline = time.monotonic() + 60
        while True:
            if self.api.poll() is not None:
                raise RuntimeError('Monolith API exited before ready; private api.log retained')
            try:
                with urllib.request.urlopen(self.base_url + '/api/health', timeout=2) as response:
                    if response.status == 200:
                        break
            except OSError:
                pass
            if time.monotonic() > deadline:
                raise RuntimeError('Monolith API readiness timeout')
            time.sleep(.5)
        return self

    def inspect(self):
        rows = self.psql("SELECT coalesce(json_agg(json_build_object('id', id, 'petId', pet_id, 'appointmentDate', appointment_date, "
                         "'appointmentTime', appointment_time, 'status', status)), '[]') FROM appointments")
        return {'appointments': json.loads(rows), 'unexpectedExit': self.api is not None and self.api.poll() is not None}

    def close(self):
        failures = []
        if self.api is not None and self.api.poll() is None:
            self.api.terminate()
            try:
                self.api.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.api.kill(); self.api.wait(timeout=10); failures.append('api forced stop')
        if self.pg_started:
            try:
                self.command(self.prefix + [str(self.pg_bin / 'pg_ctl'), '-D', str(self.private / 'pgdata'), '-m', 'fast', '-w', 'stop'])
            except Exception:
                failures.append('postgres stop failed')
            self.pg_started = False
        for log in self.logs:
            log.close()
        if failures:
            raise RuntimeError('; '.join(failures))

    def __enter__(self):
        try:
            return self.start()
        except BaseException:
            self.close()
            raise

    def __exit__(self, *unused):
        self.close()


def run_monolith(root, harness, output, *, settings, locustfile, progress=print, kaggle=False, pinning=None):
    """root: built M tree; harness: tree holding the locustfiles (the H tree). pinning: bridge VM study, see pcn_runner.taskset_prefix."""
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    manifest = {'protocol': PROTOCOL, **settings, 'configuration': 'M', 'kaggle': kaggle, 'python': sys.version,
                'platform': platform.platform(), 'cpu_count': os.cpu_count(), 'status': 'STARTING',
                'service_env': 'monolith defaults: Prisma pool, /api/auth limiter only'}
    if pinning:
        manifest['pinning'] = {**pinning, 'method': PINNING_METHOD}
    summary = {'load_status': 'NOT_RUN', 'capacity_accepted': False}
    child, stage, created = None, 'startup', []
    try:
        progress(f"M: {settings['users']} users, {settings['seconds']}s measured")
        with Monolith(root, settings['users'], pinning['server'] if pinning else None) as app:
            manifest['run'] = app.run
            before = app.inspect()
            writes_path = app.private / 'pcn-created.jsonl'
            env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'LANG', 'TMPDIR')}
            env.update(BENCH_FIXTURE=str(app.fixture_path), PCN_USERS=str(settings['users']),
                       PCN_DURATION=str(settings['seconds']), PCN_WARMUP=str(settings['warmup']),
                       PCN_FINAL=str(output / 'load-final.json'), PCN_RAW=str(output / 'requests.jsonl'),
                       PCN_HTTP=str(output / 'http.csv'), PCN_WRITES=str(writes_path),
                       PCN_GENERATOR=str(output / 'generator.json'))
            stage = 'load'
            with (app.private / 'pcn-load.log').open('w') as log:
                child = subprocess.Popen([*taskset_prefix(pinning), sys.executable, '-m', 'locust', '-f', str(Path(harness) / locustfile), '--headless',
                                          '--only-summary', '--host', app.base_url, '--users', str(settings['users']),
                                          '--spawn-rate', str(settings['spawn_rate']), '--stop-timeout', '12'],
                                         cwd=harness, env=env, stdout=log, stderr=subprocess.STDOUT)
                tracked = [('api', app.api.pid, False),
                           ('postgres', int((app.private / 'pgdata/postmaster.pid').read_text().splitlines()[0]), True),
                           ('generator', child.pid, False)]
                if pinning:
                    tracked.append(('controller', os.getpid(), False))
                started, samplers, process_errors = time.monotonic(), {}, 0
                deadline = started + settings['seconds'] + settings['warmup'] + settings['users'] / 10 + 90
                next_progress = started
                try:
                    with (output / 'resources.jsonl').open('w', encoding='utf-8') as resource_file:
                        while child.poll() is None:
                            now = time.monotonic()
                            if now > deadline:
                                raise TimeoutError('Bounded load deadline exceeded')
                            samples = resource_sample(tracked, samplers, now)
                            if pinning and 'verified' not in manifest['pinning'] and now - started >= 3:
                                manifest['pinning'].update(observed_affinity(tracked, pinning))
                            process_errors += sum('error' in row and row['component'] != 'generator' for row in samples)
                            for row in samples:
                                resource_file.write(json.dumps(row) + '\n')
                            resource_file.flush()
                            if now >= next_progress:
                                progress(f'M elapsed {int(now - started)}s (ramp/warmup included)')
                                next_progress = now + 30
                            time.sleep(1)
                finally:
                    stop_load(child)
            manifest['locust_exit_code'] = child.returncode
            manifest['process_sample_errors'] = process_errors
            stage = 'reconciliation'
            load = json.loads((output / 'load-final.json').read_text())
            http = http_summary(output / 'http.csv')
            generator = json.loads((output / 'generator.json').read_text())
            created = [json.loads(line)['id'] for line in writes_path.read_text().splitlines()]
            reconciliation = reconcile(before, app.inspect(), created)
            (output / 'reconciliation.json').write_text(json.dumps(reconciliation, indent=2))
            (output / 'http-summary.json').write_text(json.dumps(http, indent=2))
            summary = verdict(load, http, kaggle=kaggle,
                              runtime_ok=generator_ok(child.returncode, load, generator['user_errors']) and process_errors == 0
                              and reconciliation['status'] == 'PASS_IN_SCOPE')
            summary['achieved_rps'] = load['requests'] / load['measured_seconds'] if load.get('measured_seconds') else None
            summary['success_rps'] = (load['requests'] - load['failures']) / load['measured_seconds'] if load.get('measured_seconds') else None
            stage = 'teardown'
        manifest['status'] = 'COMPLETE'
    except Exception as error:
        manifest.update(status='FAILED', failed_stage=stage, error_type=type(error).__name__)
        summary.update(overall='FAIL', load_status='FAIL', runtime_error=True)
        progress(f'M stopped at {stage}: {type(error).__name__}; private logs remain in /tmp')
    finally:
        stop_load(child)
        (output / 'manifest.json').write_text(json.dumps(manifest, indent=2))
        (output / 'pcn-report.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding='utf-8')
    return summary
