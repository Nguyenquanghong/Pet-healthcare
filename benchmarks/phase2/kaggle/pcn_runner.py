"""Phase-1 PCN01/02 workload on an isolated three-service phase-2 stack."""
from __future__ import annotations
import csv
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
from collections import Counter

from native_stack import NativeStack
from benchmark import Client, reconcile
from cqrs_probe import preflight as cqrs_preflight
from cqrs_diagnostics import collect as collect_read_diagnostics

LEGACY = Path(__file__).resolve().parents[2] / 'kaggle'
sys.path.insert(0, str(LEGACY))
from pcn_contract import report as legacy_report
from metrics import CpuSampler

PROTOCOL = 'phase2-pcn-load-comparison-v1'


def configuration(mode):
    if mode not in ('full', 'smoke'):
        raise ValueError('mode must be full or smoke')
    return {'users': 100, 'seconds': 1800, 'warmup': 30, 'spawn_rate': 10} if mode == 'full' else {
        'users': 2, 'seconds': 15, 'warmup': 2, 'spawn_rate': 10}


def http_summary(path):
    counts, failures = Counter(), 0
    with Path(path).open(encoding='utf-8', newline='') as handle:
        for row in csv.DictReader(handle):
            counts[str(int(row['status']))] += 1
            failures += row['failed'] == 'True'
    return {'requests': sum(counts.values()), 'failures': failures, 'statuses': dict(counts),
            'http_429': counts['429'], 'http_503': counts['503'], 'transport_errors': counts['0']}


def verdict(load, http, *, kaggle, runtime_ok):
    result = legacy_report(load=load, kaggle=kaggle)
    matches = http['requests'] == load.get('requests') and http['failures'] == load.get('failures')
    if not runtime_ok or not matches:
        for key in ('PCN01', 'PCN02'):
            result['requirements'][key]['status'] = 'FAIL'
    result['scope'] = 'PCN01/PCN02 load only; PCN03..PCN07 NOT_RUN'
    result['raw_counts_match'] = matches
    statuses = [result['requirements'][key]['status'] for key in ('PCN01', 'PCN02')]
    result['load_status'] = 'FAIL' if 'FAIL' in statuses else 'PASS_IN_SCOPE' if all(s == 'PASS_IN_SCOPE' for s in statuses) else 'PARTIAL'
    result['overall'] = 'FAIL' if result['load_status'] == 'FAIL' else 'PARTIAL'
    result['note'] = 'Load acceptance reuses phase-1 PCN thresholds. Other PCN checks were not run; no overall PCN/capacity acceptance.'
    result['capacity_accepted'] = False
    return result


def generator_ok(exit_code, load, user_errors):
    # Locust exits 1 for *any* failed HTTP request by default. PCN allows <=1%:
    # do not turn one expected nonzero exit into a stricter, different policy.
    return user_errors == 0 and (exit_code == 0 or exit_code == 1 and load.get('failures', 0) > 0)


def resource_sample(tracked, samplers, now):
    import psutil
    samples = []
    for name, pid, recursive in tracked:
        try:
            parent = psutil.Process(pid)
            members = [parent, *parent.children(recursive=True)] if recursive else [parent]
            cpu, rss = {}, 0
            for process in members:
                try:
                    times = process.cpu_times()
                    cpu[(process.pid, process.create_time())] = times.user + times.system
                    rss += process.memory_info().rss
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
            samples.append({'component': name, 'monotonic_s': now,
                            'cpu_percent_one_core': samplers.setdefault(name, CpuSampler()).sample(now, cpu),
                            'rss_bytes_sum': rss})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            samples.append({'component': name, 'monotonic_s': now, 'error': 'process_unavailable'})
    return samples


def stop_load(child):
    if child and child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait(timeout=10)


def run_pcn(repo, output, *, mode='full', replicas=1, progress=print, cqrs_configuration=None,
            settings=None, locustfile='benchmarks/phase2/kaggle/pcn_locust.py', service_env=None):
    # settings/locustfile/service_env: the M/H bridge study (bridge_study.py) runs a
    # shorter window, its own booking grid and raised per-IP limiter thresholds.
    if cqrs_configuration not in (None, 'O', 'A', 'B'): raise ValueError('Unknown CQRS configuration')
    settings = configuration(mode) if settings is None else dict(settings)
    repo, output = Path(repo).resolve(), Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    kaggle = platform.system() == 'Linux' and Path('/kaggle/working').is_dir()
    if mode == 'full' and not kaggle:
        raise RuntimeError('Full PCN acceptance requires a Kaggle session; use smoke for local validation')
    manifest = {'protocol': PROTOCOL, 'mode': mode, **settings, 'clinic_replicas': replicas,
                'configuration': cqrs_configuration or 'O',
                'kaggle': kaggle, 'python': sys.version, 'platform': platform.platform(),
                'cpu_count': os.cpu_count(), 'hashes': {}, 'status': 'STARTING',
                'differences_from_phase1': [
                    'Three DBs/services + RabbitMQ/Redis/Nginx; RS256 login in setup, not measured',
                    'Idempotency-Key on create; GET pets accepts array or paginated items',
                    'Same task weights, URLs, bodies, wait time, timeout and PCN acceptance',
                    'Same per-owner fixture counts; phase-2 pagination/response size may differ',
                    'Common loopback IP, existing limiters unchanged, no backoff or retries',
                    'Shared Kaggle host, no per-service quota: not equal-budget B0/B1 proof',
                    'No security/browser/restart/backup checks; PCN03..PCN07 NOT_RUN'],
                'resource_limitations': 'CPU per PID/create-time; short-lived processes between samples missed; RSS sum double-counts shared pages.'}
    for file in [LEGACY / 'pcn_contract.py', LEGACY / 'pcn_locustfile.py', LEGACY / 'metrics.py',
                 *[Path(__file__).with_name(name) for name in ('pcn_runner.py', 'pcn_locust.py', 'pcn_adapter.py', 'pcn_dataset.mjs', 'native_stack.py', 'stack.mjs', 'benchmark.py', 'acceptance.json')]]:
        manifest['hashes'][file.relative_to(repo).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
    for name in ('cpu.max', 'memory.max'):
        path = Path('/sys/fs/cgroup') / name
        if path.is_file(): manifest[name] = path.read_text().strip()
    summary = legacy_report()
    summary.update({'load_status': 'NOT_RUN', 'scope': 'PCN01/PCN02 load only', 'capacity_accepted': False})
    child = None
    stage = 'startup'
    stack = None
    try:
        progress(f"PCN {mode}: {settings['users']} users, {settings['seconds']}s measured, Clinic={replicas}")
        options = {} if cqrs_configuration is None else {'cqrs_configuration': cqrs_configuration}
        if service_env:
            options['service_env'] = service_env
            manifest['service_env'] = dict(service_env)
        stack = NativeStack(repo, accounts=settings['users'], replicas=replicas, dataset_profile='pcn', **options)
        with stack:
            manifest['run'] = stack.run
            manifest['dataset'] = stack.fixture['dataset']
            manifest['db_cross_connect_denied'] = stack.fixture['dbCrossConnectDenied']
            stage = 'authentication'
            client = Client(stack)
            if cqrs_configuration is not None:
                stage = 'cqrs-read-path-preflight'
                manifest['cqrs'] = stack.fixture['cqrs']
                manifest['cqrs_preflight'] = cqrs_preflight(client, cqrs_configuration, manifest['cqrs']['generation'])
            fixture = {'users': [{'token': actor['token'], 'petId': actor['pets'][0]['id'],
                                  'qrToken': actor['pets'][0]['qrToken']} for actor in client.actors]}
            fixture_path = stack.private / 'pcn-fixture.json'
            fixture_path.write_text(json.dumps(fixture)); fixture_path.chmod(0o600)
            writes_path = stack.private / 'pcn-created.jsonl'
            before = stack.control('inspect')
            # No private ambient env/DB settings are passed to the generator.
            env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'LANG', 'TMPDIR', 'SystemRoot')}
            env.update(BENCH_FIXTURE=str(fixture_path), PCN_USERS=str(settings['users']),
                       PCN_DURATION=str(settings['seconds']), PCN_WARMUP=str(settings['warmup']),
                       PCN_FINAL=str(output / 'load-final.json'), PCN_RAW=str(output / 'requests.jsonl'),
                       PCN_HTTP=str(output / 'http.csv'), PCN_WRITES=str(writes_path),
                       PCN_GENERATOR=str(output / 'generator.json'))
            stage = 'load'
            with (stack.private / 'pcn-load.log').open('w') as log:
                child = subprocess.Popen([sys.executable, '-m', 'locust', '-f',
                    str(repo / locustfile), '--headless', '--only-summary',
                    '--host', stack.fixture['baseUrl'], '--users', str(settings['users']),
                    '--spawn-rate', str(settings['spawn_rate']), '--stop-timeout', '12'],
                    cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT)
                tracked = [(p['name'], p['pid'], False) for p in stack.fixture['processes']]
                tracked += [(name, proc.pid, name == 'rabbitmq') for name, proc in stack.processes if name != 'application']
                tracked += [('postgres', int((stack.private / 'pgdata/postmaster.pid').read_text().splitlines()[0]), True),
                            ('nginx', int((stack.private / 'nginx.pid').read_text().strip()), True),
                            ('generator', child.pid, False)]
                if cqrs_configuration is not None:
                    tracked += [('stack-supervisor', stack.application.pid, False), ('controller', os.getpid(), False)]
                started, samplers, process_errors = time.monotonic(), {}, 0
                deadline = started + settings['seconds'] + settings['warmup'] + settings['users'] / 10 + 90
                next_progress = started
                try:
                    with (output / 'resources.jsonl').open('w', encoding='utf-8') as resource_file:
                        while child.poll() is None:
                            now = time.monotonic()
                            if now > deadline: raise TimeoutError('Bounded PCN load deadline exceeded')
                            samples = resource_sample(tracked, samplers, now)
                            if cqrs_configuration is not None:
                                with (output / 'cqrs.jsonl').open('a', encoding='utf-8') as handle:
                                    handle.write(json.dumps({'monotonic_s': now, **stack.control('cqrs-observe')}) + '\n')
                            process_errors += sum('error' in row and row['component'] != 'generator' for row in samples)
                            for row in samples: resource_file.write(json.dumps(row) + '\n')
                            resource_file.flush()
                            if now >= next_progress:
                                progress(f'PCN elapsed {int(now-started)}s (ramp/warmup included); continuing without retries')
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
            reconciliation = reconcile(before, stack.control('inspect'), created)
            (output / 'reconciliation.json').write_text(json.dumps(reconciliation, indent=2))
            (output / 'http-summary.json').write_text(json.dumps(http, indent=2))
            summary = verdict(load, http, kaggle=kaggle and mode == 'full',
                runtime_ok=generator_ok(child.returncode, load, generator['user_errors']) and process_errors == 0 and reconciliation['status'] == 'PASS_IN_SCOPE')
            summary['achieved_rps'] = load['requests'] / load['measured_seconds'] if load.get('measured_seconds') else None
            summary['success_rps'] = (load['requests']-load['failures']) / load['measured_seconds'] if load.get('measured_seconds') else None
            stage = 'teardown'
        manifest['status'] = 'COMPLETE'
    except Exception as error:
        # No traceback/message: setup exceptions may contain credentials/URLs.
        manifest.update(status='FAILED', failed_stage=stage, error_type=type(error).__name__)
        summary.update(overall='FAIL', load_status='FAIL', runtime_error=True)
        for key in ('PCN01', 'PCN02'):
            if summary['requirements'][key]['status'] != 'NOT_RUN':
                summary['requirements'][key]['status'] = 'FAIL'
        progress(f'PCN stopped at {stage}: {type(error).__name__}; private logs remain in /tmp')
    finally:
        stop_load(child)
        if cqrs_configuration in ('A','B') and stack is not None:
            manifest['read_diagnostics'] = collect_read_diagnostics(stack.private, replicas, output)
        (output / 'manifest.json').write_text(json.dumps(manifest, indent=2))
        (output / 'pcn-report.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding='utf-8')
    return summary
