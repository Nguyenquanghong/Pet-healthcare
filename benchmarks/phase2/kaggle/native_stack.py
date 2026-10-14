"""Own a fresh native Linux stack. No Docker, external DB URL, or reused data path.

Secrets/data/logs live under /tmp, NOT Kaggle's automatically exported working dir.
The notebook exports only allowlisted aggregate artifacts.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import socket
import subprocess
import time
import uuid


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def wait_port(port, process, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise RuntimeError('Owned infrastructure exited before ready; private logs retained')
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=.3):
                return
        except OSError:
            time.sleep(.25)
    raise RuntimeError('Owned infrastructure readiness timeout')


class NativeStack:
    def __init__(self, repo, accounts=40, replicas=1):
        if platform.system() != 'Linux':
            raise RuntimeError('Native stack requires Linux (Kaggle CPU notebook)')
        if not isinstance(accounts, int) or not 2 <= accounts <= 40 or replicas not in (1, 2):
            raise ValueError('accounts 2..40; Clinic replicas 1 or 2')
        self.repo = Path(repo).resolve(strict=True)
        self.run = str(uuid.uuid4())
        self.private = Path('/tmp') / ('pet-phase2-kaggle-' + self.run)
        self.private.mkdir(mode=0o700)
        self.processes, self.logs = [], []
        self.pg_started = False
        self.accounts, self.replicas = accounts, replicas
        self.application = None

    def command(self, args, **kwargs):
        log = (self.private / 'setup.log').open('a')
        try:
            return subprocess.run(args, check=True, stdout=log, stderr=subprocess.STDOUT,
                                  timeout=180, **kwargs)
        except subprocess.CalledProcessError as error:
            # Command arguments can contain a synthetic credential; never print them.
            raise RuntimeError('Native setup command failed; inspect private setup.log') from None
        finally:
            log.close()

    def start_process(self, name, args, **kwargs):
        log = (self.private / (name + '.log')).open('w')
        self.logs.append(log)
        child = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT,
                                 start_new_session=True, **kwargs)
        self.processes.append((name, child))
        return child

    def start(self):
        import pwd
        for name in ('node', 'psql', 'pg_config', 'redis-server', 'rabbitmq-server', 'nginx'):
            if not shutil.which(name):
                raise RuntimeError('Missing native program: ' + name)
        self.pg_bin = Path(subprocess.check_output(['pg_config', '--bindir'], text=True).strip())
        self.pg_prefix = []
        if os.geteuid() == 0:
            user = pwd.getpwnam('postgres')
            os.chown(self.private, user.pw_uid, user.pw_gid)
            self.pg_prefix = ['runuser', '-u', 'postgres', '--']
        ports = set()
        while len(ports) < 5:
            ports.add(free_port())
        pg, redis, rabbit, dist, epmd = sorted(ports)
        self.pg_port = pg
        data = self.private / 'pgdata'
        self.command(self.pg_prefix + [str(self.pg_bin / 'initdb'), '-D', str(data), '-U', 'postgres',
                                      '--auth-local=trust', '--auth-host=scram-sha-256', '--no-instructions'])
        # Admin only uses the private Unix socket; TCP service roles use SCRAM.
        self.command(self.pg_prefix + [str(self.pg_bin / 'pg_ctl'), '-D', str(data), '-l', str(self.private / 'postgres.log'),
                     '-o', f'-h 127.0.0.1 -p {pg} -k {self.private}', '-w', 'start'])
        self.pg_started = True
        urls = {}
        for name in ('core', 'clinic', 'notification'):
            role, database, password = 'p8_' + name, 'p8_' + name, secrets.token_hex(24)
            sql = (f'CREATE ROLE {role} LOGIN PASSWORD \'{password}\';\n'
                   f'CREATE DATABASE {database} OWNER {role};\n'
                   f'REVOKE CONNECT ON DATABASE {database} FROM PUBLIC;\n')
            self.command(['psql', '-h', str(self.private), '-p', str(pg), '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], input=sql, text=True)
            # Keep public empty until Prisma's first migrate deploy (P3005).
            marker = f'CREATE SCHEMA p8_control; CREATE TABLE p8_control.marker (run text PRIMARY KEY); INSERT INTO p8_control.marker VALUES (\'{self.run}\'); GRANT USAGE ON SCHEMA p8_control TO {role}; GRANT SELECT ON p8_control.marker TO {role};'
            self.command(['psql', '-h', str(self.private), '-p', str(pg), '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'], input=marker, text=True)
            urls[name] = f'postgresql://{role}:{password}@127.0.0.1:{pg}/{database}?schema=public&connection_limit=4'
        self.command(['psql', '-h', str(self.private), '-p', str(pg), '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'],
                     input='REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC;', text=True)
        redis_config = self.private / 'redis.conf'
        redis_config.write_text(f'bind 127.0.0.1\nport {redis}\ndir {self.private}\nsave ""\nappendonly no\n')
        self.redis = self.start_process('redis', ['redis-server', str(redis_config)])
        wait_port(redis, self.redis)
        rabbit_password = secrets.token_hex(24)
        config = self.private / 'rabbitmq.conf'
        config.write_text(f'listeners.tcp.1 = 127.0.0.1:{rabbit}\ndefault_user = p8\ndefault_pass = {rabbit_password}\nloopback_users = none\n')
        config.chmod(0o600)
        self.rabbit_env = {**os.environ, 'RABBITMQ_NODENAME': 'p8_' + self.run.replace('-', '') + '@localhost',
            'RABBITMQ_CONFIG_FILE': str(config.with_suffix('')), 'RABBITMQ_MNESIA_BASE': str(self.private / 'mnesia'),
            'RABBITMQ_LOG_BASE': str(self.private / 'rabbit-logs'), 'RABBITMQ_PID_FILE': str(self.private / 'rabbit.pid'),
            'RABBITMQ_DIST_PORT': str(dist), 'ERL_EPMD_PORT': str(epmd), 'ERL_EPMD_ADDRESS': '127.0.0.1',
            'RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS': '+S 2:2 +A 4 -kernel inet_dist_use_interface {127,0,0,1} -setcookie ' + secrets.token_hex(32),
            'ERL_CRASH_DUMP': str(self.private / 'erl_crash.dump')}
        rabbit_binary = '/usr/lib/rabbitmq/bin/rabbitmq-server'
        self.rabbit = self.start_process('rabbitmq', [rabbit_binary if Path(rabbit_binary).exists() else 'rabbitmq-server'], env=self.rabbit_env)
        wait_port(rabbit, self.rabbit)
        context = {'kind': 'phase2-kaggle-native-v1', 'run': self.run, 'directory': str(self.private),
            'urls': urls, 'pgData': str(data), 'pgPort': pg, 'accounts': self.accounts, 'replicas': self.replicas,
            'broker': f'amqp://p8:{rabbit_password}@127.0.0.1:{rabbit}', 'redis': f'redis://127.0.0.1:{redis}'}
        path = self.private / 'context.json'
        path.write_text(json.dumps(context)); path.chmod(0o600)
        env = {key: value for key, value in os.environ.items() if key in ('PATH', 'HOME', 'LANG', 'TMPDIR', 'SystemRoot')}
        self.application = self.start_process('application', ['node', str(self.repo / 'benchmarks/phase2/kaggle/stack.mjs'), str(path)], cwd=self.repo, env=env, stdin=subprocess.PIPE, text=True)
        end = time.monotonic() + 240
        while time.monotonic() < end:
            if self.application.poll() is not None:
                raise RuntimeError('Three-service startup failed; private application.log retained')
            if (self.private / 'ready.json').exists():
                self.fixture = json.loads((self.private / 'ready.json').read_text())
                if self.fixture['run'] != self.run:
                    raise RuntimeError('Fixture run mismatch')
                return self
            time.sleep(.5)
        raise RuntimeError('Three-service startup timed out')

    def control(self, action, **extra):
        request = str(uuid.uuid4())
        self.application.stdin.write(json.dumps({'id': request, 'action': action, **extra}) + '\n')
        self.application.stdin.flush()
        path = self.private / (request + '.json')
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if self.application.poll() is not None:
                raise RuntimeError('Owned application exited')
            if path.exists():
                result = json.loads(path.read_text())
                if result.get('error'):
                    raise RuntimeError('Stack control failed: ' + result['error'])
                return result
            time.sleep(.1)
        raise RuntimeError('Stack control timeout')

    def close(self):
        import signal
        failures = []
        if self.application and self.application.poll() is None:
            try:
                self.application.stdin.write('{"action":"stop"}\n'); self.application.stdin.flush()
                self.application.stdin.close()
                self.application.wait(timeout=35)
            except Exception:
                failures.append('application graceful stop failed')
        # Every owned process group is drained even after one failure; never kill by name.
        for name, child in reversed(self.processes):
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM); child.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=10)
                    failures.append(name + ' forced stop')
                except ProcessLookupError:
                    pass
            if name == 'application' and child.returncode != 0:
                failures.append('application exit was nonzero')
        if self.pg_started:
            try:
                self.command(self.pg_prefix + [str(self.pg_bin / 'pg_ctl'), '-D', str(self.private / 'pgdata'), '-m', 'fast', '-w', 'stop'])
            except Exception:
                failures.append('postgres stop failed')
            self.pg_started = False
        if hasattr(self, 'rabbit_env') and shutil.which('epmd'):
            subprocess.run(['epmd', '-kill'], env=self.rabbit_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
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
