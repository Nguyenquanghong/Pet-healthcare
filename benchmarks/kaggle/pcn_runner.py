"""Run PCN checks against a NEW temporary PostgreSQL cluster, never an existing DB."""
import argparse
import csv
import hashlib
import json
import os
import platform
import pwd
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import psutil
from metrics import CpuSampler
from pcn_contract import PROTOCOL, report
from ports import require_free_port
from runner import command, output, process_usage, stop_process, wait_health


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--skip-browser", action="store_true")
    parser.add_argument("--local-smoke", action="store_true", help="Linux validation only; cannot pass PCN01/02")
    parser.add_argument("--smoke-seconds", type=int, default=15)
    args = parser.parse_args()
    repo = args.repo.resolve(strict=True)
    destination = args.output.resolve()
    if not (repo / "backend/prisma/schema.prisma").is_file():
        raise RuntimeError("Expected a Pet Healthcare Node/Prisma checkout")
    if not args.local_smoke and (not Path('/kaggle/working').is_dir()
                                or not destination.is_relative_to(Path('/kaggle/working'))):
        raise RuntimeError("Full evidence runs require Kaggle and an output under /kaggle/working")
    if args.local_smoke and not 1 <= args.smoke_seconds <= 30:
        raise RuntimeError("Smoke duration must be between 1 and 30 seconds")
    dirty = bool(output(['git', 'status', '--porcelain'], cwd=repo))
    if dirty and not args.local_smoke:
        raise RuntimeError("Commit the reviewed source before selecting its SHA for Kaggle")
    users, duration, warmup = (2, args.smoke_seconds, 2) if args.local_smoke else (100, 1800, 30)
    pg_bin = Path(os.environ.get('BENCH_PG_BIN') or output(['pg_config', '--bindir']))
    for binary in ('initdb', 'pg_ctl', 'postgres', 'createdb', 'pg_dump', 'pg_restore'):
        if not (pg_bin / binary).is_file():
            raise RuntimeError(f"Missing PostgreSQL server/client binary: {binary}")
    require_free_port(55432)
    require_free_port(5001)
    if not args.skip_browser:
        require_free_port(5179)
    destination.mkdir(parents=True, exist_ok=False)
    manifest = {
        'protocol': PROTOCOL, 'started_at_utc': datetime.now(timezone.utc).isoformat(),
        'commit': output(['git', 'rev-parse', 'HEAD'], cwd=repo), 'dirty_worktree': dirty,
        'environment': 'LOCAL_SMOKE' if args.local_smoke else 'KAGGLE_CPU',
        'platform': platform.platform(), 'logical_cpus': psutil.cpu_count(),
        'cpu_model': next((line.split(':', 1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines()
                           if line.startswith('model name')), platform.processor()),
        'cpu_affinity': psutil.Process().cpu_affinity(), 'ram_bytes': psutil.virtual_memory().total,
        'node_version': output(['node', '--version']), 'python_version': platform.python_version(),
        'postgres_version': output([str(pg_bin / 'postgres'), '--version']),
        'locust_version': output([sys.executable, '-m', 'locust', '--version']),
        'users': users, 'measured_seconds': duration, 'warmup_after_full_population_seconds': warmup,
        'sampling': 'One sample/second; CPU 100% means one core; first CPU sample unknown.',
        'shares_cpu': 'API, DB, Locust and later browser checks share the same host. Browser checks run after load.',
        'scope': 'API lists, filter medical records by pet, create appointments/rescue reports; synthetic data only.',
        'harness_sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                           for p in (repo / 'benchmarks/kaggle').iterdir()
                           if p.is_file() and (p.name.startswith('pcn_') or p.name in
                               {'runner.py', 'ports.py', 'metrics.py', 'prepare_fixture.mjs', 'fixtureData.mjs'})},
        'status': 'RUNNING',
    }
    write_json(destination / 'manifest.json', manifest)
    load_result = security = browser = restart = backup = None
    api = load = frontend = None
    logs = []
    pg_started = False
    # Private fixtures, JWTs, the snapshot and dumps never enter the export directory.
    with tempfile.TemporaryDirectory(prefix='pet-pcn-') as temp_name:
        private = Path(temp_name)
        data_dir = private / 'pgdata'
        data_dir.mkdir()
        pg_log = private / 'postgres.log'
        prefix = []
        if os.geteuid() == 0:
            pg_user = pwd.getpwnam('postgres')
            for path in (private, data_dir):
                os.chown(path, pg_user.pw_uid, pg_user.pw_gid)
            prefix = ['runuser', '-u', 'postgres', '--']
        env = os.environ.copy()
        env.update(DATABASE_URL='postgresql://postgres@127.0.0.1:55432/pet_pcn_test?schema=public',
                   JWT_SECRET=secrets.token_urlsafe(40), PORT='5001', VNPAY_ENABLED='false', BANK_TRANSFER_DEMO='true',
                   CORS_ORIGIN='http://127.0.0.1:5179', BENCH_FIXTURE=str(private / 'fixture.json'),
                   BENCH_PASSWORD=secrets.token_urlsafe(24), BENCH_USERS=str(users), BENCH_SEED='pcn',
                   PCN_SNAPSHOT=str(private / 'snapshot.json'), PCN_API='http://127.0.0.1:5001/api')

        def logged(args, name, environment=env):
            with open(destination / name, 'a', encoding='utf-8') as log:
                command(args, cwd=repo, env=environment, stdout=log)

        def launch_api():
            log = open(destination / 'api.log', 'a', encoding='utf-8')
            logs.append(log)
            process = subprocess.Popen(['node', 'backend/dist/src/index.js'], cwd=repo, env=env,
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            wait_health(5001, process)
            return process

        def check(mode, name, environment=env):
            check_env = {**environment, 'PCN_CHECK_OUTPUT': str(destination / name)}
            logged(['node', 'benchmarks/kaggle/pcn_checks.mjs', mode], 'checks.log', check_env)
            return json.loads((destination / name).read_text(encoding='utf-8'))

        def pg_start():
            logged(prefix + [str(pg_bin / 'pg_ctl'), '-D', str(data_dir), '-l', str(pg_log), '-o',
                            f'-c listen_addresses=127.0.0.1 -p 55432 -k {private}', 'start'], 'database.log')

        try:
            logged(prefix + [str(pg_bin / 'initdb'), '-D', str(data_dir), '-U', 'postgres', '-A', 'trust', '--no-instructions'], 'database.log')
            pg_start()
            pg_started = True
            logged([str(pg_bin / 'createdb'), '-h', '127.0.0.1', '-p', '55432', '-U', 'postgres', 'pet_pcn_test'], 'database.log')
            logged(['npm', 'ci'], 'setup.log')
            logged(['npm', 'run', 'build', '-w', 'backend'], 'setup.log')
            logged(['npm', 'run', 'db:deploy', '-w', 'backend'], 'setup.log')
            logged(['node', 'benchmarks/kaggle/prepare_fixture.mjs'], 'setup.log')
            check('seed', 'fixture-summary.json')
            api = launch_api()
            security = check('security', 'security.json')

            load_env = {**env, 'PCN_USERS': str(users), 'PCN_DURATION': str(duration), 'PCN_WARMUP': str(warmup),
                        'PCN_FINAL': str(destination / 'load-final.json'), 'PCN_RAW': str(destination / 'requests.jsonl')}
            load_log = open(destination / 'load.log', 'w', encoding='utf-8')
            logs.append(load_log)
            load = subprocess.Popen([sys.executable, '-m', 'locust', '-f', 'benchmarks/kaggle/pcn_locustfile.py',
                                     '--headless', '--only-summary', '--host', 'http://127.0.0.1:5001',
                                     '--users', str(users), '--spawn-rate', '10', '--stop-timeout', '12'],
                                    cwd=repo, env=load_env, stdout=load_log, stderr=subprocess.STDOUT, start_new_session=True)
            deadline = time.monotonic() + duration + warmup + users / 10 + 90
            pg_pid = int((data_dir / 'postmaster.pid').read_text().splitlines()[0])
            samplers = [CpuSampler(), CpuSampler(), CpuSampler()]
            with open(destination / 'resources.jsonl', 'w', encoding='utf-8') as resources:
                while load.poll() is None:
                    if time.monotonic() > deadline:
                        raise RuntimeError('Load runner exceeded its bounded execution time')
                    resources.write(json.dumps({'utc': datetime.now(timezone.utc).isoformat(),
                                               'api': process_usage(api.pid, samplers[0]),
                                               'postgres': process_usage(pg_pid, samplers[1]),
                                               'generator': process_usage(load.pid, samplers[2])}) + '\n')
                    resources.flush()
                    time.sleep(1)
            manifest['locust_exit_code'] = load.wait()
            load_result = json.loads((destination / 'load-final.json').read_text(encoding='utf-8'))

            check('create-records', 'records-created.json')
            stop_process(api)
            api = None
            logged(prefix + [str(pg_bin / 'pg_ctl'), '-D', str(data_dir), '-m', 'fast', 'stop'], 'database.log')
            pg_started = False
            pg_start()
            pg_started = True
            api = launch_api()
            restart = check('verify-records', 'restart.json')
            restart['restarted_components'] = ['API', 'PostgreSQL']
            write_json(destination / 'restart.json', restart)

            dumps = private / 'backups'
            dumps.mkdir()
            for index in range(8):
                logged([str(pg_bin / 'pg_dump'), '-h', '127.0.0.1', '-p', '55432', '-U', 'postgres',
                        '-Fc', '-f', str(dumps / f'backup-{index:02d}.dump'), 'pet_pcn_test'], 'backup.log')
            oldest = sorted(dumps.glob('backup-*.dump'))[:-7]
            for path in oldest:
                path.unlink()  # Only files created in this run's private temporary directory.
            retained = sorted(dumps.glob('backup-*.dump'))
            started = time.monotonic()
            logged([str(pg_bin / 'createdb'), '-h', '127.0.0.1', '-p', '55432', '-U', 'postgres', 'pet_pcn_restore_test'], 'backup.log')
            logged([str(pg_bin / 'pg_restore'), '-h', '127.0.0.1', '-p', '55432', '-U', 'postgres', '--exit-on-error',
                    '-d', 'pet_pcn_restore_test', str(retained[-1])], 'backup.log')
            restored = check('verify-records', 'restored-records.json',
                             {**env, 'DATABASE_URL': 'postgresql://postgres@127.0.0.1:55432/pet_pcn_restore_test?schema=public'})
            backup = {'restore_passed': restored['passed'], 'restore_seconds': time.monotonic() - started,
                      'retained_backups': len(retained), 'created_backups': 8,
                      'daily_schedule_observed': False, 'retention_test': 'Eight real dumps in one session; retain the newest seven, not seven days of operation.'}
            write_json(destination / 'backup.json', backup)

            if not args.skip_browser:
                try:
                    # Install only inside this Kaggle/Linux test environment, never on the user's desktop.
                    logged(['node', 'node_modules/@playwright/test/cli.js', 'install', '--with-deps', 'chrome', 'msedge'], 'browser-setup.log')
                    frontend_env = {**env, 'VITE_API_BASE_URL': 'http://127.0.0.1:5001/api'}
                    logged(['npm', 'run', 'build', '-w', 'frontend'], 'browser-setup.log', frontend_env)
                    front_log = open(destination / 'frontend.log', 'w', encoding='utf-8')
                    logs.append(front_log)
                    frontend = subprocess.Popen(['npm', 'run', 'preview', '-w', 'frontend', '--', '--host', '127.0.0.1',
                                                 '--port', '5179', '--strictPort'], cwd=repo, env=frontend_env,
                                                stdout=front_log, stderr=subprocess.STDOUT, start_new_session=True)
                    import urllib.request
                    until = time.monotonic() + 60
                    while True:
                        try:
                            with urllib.request.urlopen('http://127.0.0.1:5179', timeout=2): break
                        except Exception:
                            if time.monotonic() > until or frontend.poll() is not None:
                                raise RuntimeError('Frontend did not become ready')
                            time.sleep(1)
                    browser_env = {**frontend_env, 'PCN_BROWSER_OUTPUT': str(destination / 'browser.json'),
                                   'PCN_BROWSER_ARTIFACTS': str(destination / 'screenshots')}
                    logged(['node', 'benchmarks/kaggle/pcn_browser.mjs'], 'browser.log', browser_env)
                    browser = json.loads((destination / 'browser.json').read_text(encoding='utf-8'))
                except Exception as error:
                    browser = {'PCN04': {'status': 'NOT_RUN'}, 'PCN05': {'status': 'NOT_RUN'},
                               'setup_error_type': type(error).__name__, 'details': 'See browser-setup.log and browser.log; installation failures are not a PASS.'}
                    write_json(destination / 'browser.json', browser)
            manifest['status'] = 'COMPLETED'
        except BaseException as error:
            manifest['status'] = 'INTERRUPTED' if isinstance(error, KeyboardInterrupt) else 'FAILED'
            manifest['error_type'] = type(error).__name__
            raise
        finally:
            cleanup_errors = []
            for process in (load, frontend, api):
                try:
                    stop_process(process)
                except Exception as error:
                    cleanup_errors.append(type(error).__name__)
            for log in logs:
                log.close()
            if pg_started:
                try:
                    logged(prefix + [str(pg_bin / 'pg_ctl'), '-D', str(data_dir), '-m', 'fast', 'stop'], 'database.log')
                except Exception as error:
                    cleanup_errors.append(type(error).__name__)
            if pg_log.exists():
                shutil.copyfile(pg_log, destination / 'postgres.log')
            summary = report(load_result, security, browser, restart, backup, kaggle=not args.local_smoke)
            if cleanup_errors:
                manifest['cleanup_errors'] = cleanup_errors
                manifest['status'] = 'FAILED'
            if manifest['status'] != 'COMPLETED':
                summary['overall'] = manifest['status']
            summary['environment'] = manifest['environment']
            write_json(destination / 'pcn-report.json', summary)
            with open(destination / 'pcn-report.csv', 'w', encoding='utf-8-sig', newline='') as stream:
                writer = csv.writer(stream)
                writer.writerow(['PCN', 'Trạng thái', 'Phạm vi', 'Bằng chứng'])
                for key, row in summary['requirements'].items():
                    writer.writerow([key, row['status'], row.get('scope', ''), row.get('evidence', '')])
            manifest['ended_at_utc'] = datetime.now(timezone.utc).isoformat()
            write_json(destination / 'manifest.json', manifest)
    print(f'PCN evidence saved in {destination}; overall={summary["overall"]}')
    return 2 if summary['overall'] == 'FAIL' else 0


if __name__ == '__main__':
    raise SystemExit(main())
