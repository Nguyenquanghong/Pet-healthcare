"""cqrs-list-matched-kaggle-v1 member runner: one configuration, one workload.

Runs with cwd = an extracted, built O or AB root, like the Q6 trial. The pinned
Q6/phase-1 helpers are reused unchanged by import (NativeStack/stack.mjs,
QueryClient + contract checks, open_loop, PCN locustfile). This overlay adds,
for the list study only:
  * a PID -> role ledger file read by the external collector (collector-cli.mjs);
  * CLOCK_MONOTONIC bounds of each measured window;
  * no stack observe/inspect actions inside measured windows (only a 1/s
    pg_stat_activity pool sampler over the private socket, same for O/A/B);
  * outcomes are recorded, not turned into an early stop on the first
    non-success response; list_evaluate.py grades them. Setup/preflight and
    reconciliation failures still fail the member.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from native_stack import NativeStack  # noqa: E402
from benchmark import Client, reconcile  # noqa: E402
from cqrs_probe import preflight as cqrs_preflight  # noqa: E402
from query_heavy import QueryClient, measure, preflight as owner_preflight, OPERATIONS  # noqa: E402

SETTINGS = {
    'query-heavy': {'full': {'warmup': 120, 'seconds': 800, 'rate': 12, 'concurrency': 16},
                    'smoke': {'warmup': 5, 'seconds': 60, 'rate': 12, 'concurrency': 16}},
    'pcn': {'full': {'users': 100, 'spawn_rate': 10, 'warmup': 30, 'seconds': 1800},
            'smoke': {'users': 10, 'spawn_rate': 10, 'warmup': 5, 'seconds': 60}},
}
API = {'core', 'clinic-0', 'notification'}
WORKER = {'core-outbox', 'notification-worker', 'billing-worker', 'clinic-read-worker'}
RELAY = {'clinic-worker'}


def stack_ledger(stack, *, generator, controller):
    """Role roots for the collector. Every stack process must map to a role."""
    ledger = {'api': [], 'worker': [], 'relay': [], 'postgres': [], 'broker': [], 'redis': [], 'gateway': [],
              'generator': list(generator), 'controller': list(controller)}
    for row in stack.fixture['processes']:
        role = 'api' if row['name'] in API else 'worker' if row['name'] in WORKER else 'relay' if row['name'] in RELAY else None
        if role is None:
            raise RuntimeError('LIST_UNMAPPED_STACK_PROCESS')
        ledger[role].append(int(row['pid']))
    for name, child in stack.processes:
        role = {'redis': 'redis', 'rabbitmq': 'broker', 'application': 'controller'}.get(name)
        if role is None:
            raise RuntimeError('LIST_UNMAPPED_NATIVE_PROCESS')
        ledger[role].append(child.pid)
    ledger['postgres'].append(int((stack.private / 'pgdata/postmaster.pid').read_text().splitlines()[0]))
    ledger['gateway'].append(int((stack.private / 'nginx.pid').read_text().strip()))
    roots = [pid for pids in ledger.values() for pid in pids]
    if any(not pids for pids in ledger.values()) or len(roots) != len(set(roots)):
        raise RuntimeError('LIST_LEDGER_INCOMPLETE_OR_OVERLAPPING')
    return ledger


def write_ledger(path, ledger):
    temporary = Path(str(path) + '.tmp')
    temporary.write_text(json.dumps(ledger))
    os.replace(temporary, path)


class PoolSampler:
    """pg_stat_activity per database role, 1/s, via the private Unix socket."""
    def __init__(self, stack):
        self.stack, self.stop, self.peaks, self.samples, self.errors = stack, threading.Event(), {}, 0, 0
        self.thread = threading.Thread(target=self.loop, daemon=True)

    def loop(self):
        query = "SELECT usename, count(*) FROM pg_stat_activity WHERE usename IS NOT NULL AND usename <> 'postgres' GROUP BY 1"
        while not self.stop.is_set():
            try:
                # Same admin path as NativeStack setup: local socket, trust auth for postgres only.
                out = subprocess.run(['psql', '-X', '-At', '-F', ' ', '-h', str(self.stack.private), '-p', str(self.stack.pg_port),
                                     '-U', 'postgres', '-d', 'postgres', '-c', query], capture_output=True, text=True, timeout=5, check=True).stdout
                for line in out.split('\n'):
                    if line.strip():
                        role, count = line.split()
                        self.peaks[role] = max(self.peaks.get(role, 0), int(count))
                self.samples += 1
            except Exception:
                self.errors += 1
            self.stop.wait(1)

    def __enter__(self):
        self.thread.start(); return self

    def __exit__(self, *unused):
        self.stop.set(); self.thread.join(timeout=10)


def run_query(output, configuration, mode, ledger_path, controller):
    s = SETTINGS['query-heavy'][mode]
    report = {'workload': 'query-heavy', 'configuration': configuration, 'mode': mode, 'settings': s, 'status': 'STARTING'}
    stage, rows = 'startup', []
    try:
        stack = NativeStack(Path.cwd(), accounts=100, replicas=1, dataset_profile='query-heavy', cqrs_configuration=configuration)
        with stack:
            report.update(run=stack.run, dataset=stack.fixture['dataset'], cqrs=stack.fixture.get('cqrs'))
            assert report['dataset']['appointments'] == 100000 and stack.fixture['dbCrossConnectDenied'] == 6
            stage = 'authentication'; client = QueryClient(stack)
            stage = 'read-path-preflight'; report['cqrsPreflight'] = cqrs_preflight(client, configuration, (report['cqrs'] or {}).get('generation'))
            stage = 'owner-scope-preflight'; report['ownerPreflight'] = owner_preflight(client)
            assert len(report['ownerPreflight']) == 3 and all(c['valid'] for c in report['ownerPreflight'])
            stage = 'fixture-snapshot'; before = stack.control('query-snapshot')
            assert not before['unexpectedExit'] and before['appointment']['count'] == 100000
            report['ledger'] = stack_ledger(stack, generator=[os.getpid()], controller=controller)
            write_ledger(ledger_path, report['ledger'])
            with PoolSampler(stack) as pool:
                for phase, seconds in (('warmup', s['warmup']), ('measured', s['seconds'])):
                    stage = phase
                    start = time.monotonic()
                    load = measure(client.read, rate=s['rate'], seconds=seconds, concurrency=s['concurrency'])
                    report[phase] = {'startMonotonicMs': start * 1000, 'endMonotonicMs': (start + seconds) * 1000,
                                     'drainSeconds': load['drain_seconds'], 'scheduled': load['scheduled'], 'seconds': seconds}
                    rows.extend({**row, 'phase': phase} for row in load['rows'])
            report['pool'] = {'peaks': pool.peaks, 'samples': pool.samples, 'errors': pool.errors}
            stage = 'reconciliation'; after = stack.control('query-snapshot')
            report['reconciliation'] = {'status': 'PASS' if before == after else 'FAIL', 'unexpectedExit': after['unexpectedExit']}
            assert before == after, 'Read workload changed fixture or child exited'
            stage = 'teardown'
        report['status'] = 'COMPLETE'
    except Exception as error:
        report.update(status='FAIL', failedStage=stage, errorType=type(error).__name__)
    finally:
        with (output / 'requests.jsonl').open('w', encoding='utf-8') as handle:
            for row in rows: handle.write(json.dumps(row) + '\n')
        (output / 'member-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    return report


def run_pcn(output, configuration, mode, ledger_path, controller):
    s = SETTINGS['pcn'][mode]
    report = {'workload': 'pcn', 'configuration': configuration, 'mode': mode, 'settings': s, 'status': 'STARTING'}
    stage, child = 'startup', None
    try:
        stack = NativeStack(Path.cwd(), accounts=s['users'], replicas=1, dataset_profile='pcn', cqrs_configuration=configuration)
        with stack:
            report.update(run=stack.run, dataset=stack.fixture['dataset'], cqrs=stack.fixture.get('cqrs'))
            stage = 'authentication'; client = Client(stack)
            stage = 'read-path-preflight'; report['cqrsPreflight'] = cqrs_preflight(client, configuration, (report['cqrs'] or {}).get('generation'))
            fixture = {'users': [{'token': a['token'], 'petId': a['pets'][0]['id'], 'qrToken': a['pets'][0]['qrToken']} for a in client.actors]}
            fixture_path = stack.private / 'pcn-fixture.json'
            fixture_path.write_text(json.dumps(fixture)); fixture_path.chmod(0o600)
            writes = stack.private / 'pcn-created.jsonl'
            stage = 'inspect-before'; before = stack.control('inspect')
            env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'LANG', 'TMPDIR')}
            env.update(BENCH_FIXTURE=str(fixture_path), PCN_USERS=str(s['users']), PCN_DURATION=str(s['seconds']), PCN_WARMUP=str(s['warmup']),
                       PCN_FINAL=str(output / 'load-final.json'), PCN_RAW=str(stack.private / 'pcn-legacy-raw.jsonl'),
                       PCN_HTTP=str(output / 'http.csv'), PCN_WRITES=str(writes), PCN_GENERATOR=str(output / 'generator.json'),
                       LIST_PCN_RAW=str(output / 'requests.jsonl'), LIST_PCN_PROBE=str(output / 'event-loop-probe.jsonl'),
                       LIST_PCN_WINDOW=str(output / 'window.json'), LIST_PCN_GENERATION=str((report['cqrs'] or {}).get('generation') or ''))
            stage = 'load'
            with PoolSampler(stack) as pool, (stack.private / 'pcn-load.log').open('w') as log:
                child = subprocess.Popen([sys.executable, '-m', 'locust', '-f', str(HERE / 'list_pcn_locust.py'), '--headless', '--only-summary',
                                          '--host', stack.fixture['baseUrl'], '--users', str(s['users']), '--spawn-rate', str(s['spawn_rate']),
                                          '--stop-timeout', '12'], cwd=Path.cwd(), env=env, stdout=log, stderr=subprocess.STDOUT)
                report['ledger'] = stack_ledger(stack, generator=[child.pid], controller=[*controller, os.getpid()])
                write_ledger(ledger_path, report['ledger'])
                deadline = time.monotonic() + s['seconds'] + s['warmup'] + s['users'] / s['spawn_rate'] + 120
                while child.poll() is None:
                    if time.monotonic() > deadline:
                        raise TimeoutError('LIST_PCN_DEADLINE')
                    time.sleep(1)
            report['pool'] = {'peaks': pool.peaks, 'samples': pool.samples, 'errors': pool.errors}
            report['locustExitCode'] = child.returncode
            stage = 'reconciliation'
            created = [json.loads(line)['id'] for line in writes.read_text().splitlines() if line.strip()]
            report['reconciliation'] = reconcile(before, stack.control('inspect'), created)
            report['window'] = json.loads((output / 'window.json').read_text())
            stage = 'teardown'
        report['status'] = 'COMPLETE'
    except Exception as error:
        report.update(status='FAIL', failedStage=stage, errorType=type(error).__name__)
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try: child.wait(timeout=15)
            except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=10)
        (output / 'member-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workload', choices=['query-heavy', 'pcn'], required=True)
    parser.add_argument('--configuration', choices=['O', 'A', 'B'], required=True)
    parser.add_argument('--mode', choices=['smoke', 'full'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--ledger', type=Path, required=True)
    parser.add_argument('--controller-pid', type=int, action='append', default=[])
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    runner = run_query if args.workload == 'query-heavy' else run_pcn
    report = runner(args.output, args.configuration, args.mode, args.ledger, args.controller_pid)
    print(json.dumps({'status': report['status'], 'failedStage': report.get('failedStage')}))
    return 0 if report['status'] == 'COMPLETE' else 1


if __name__ == '__main__':
    raise SystemExit(main())
