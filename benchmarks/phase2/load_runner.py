"""Bounded closed-loop HTTP load; stdlib only. Writes only to a guarded UUID fixture.

No production URL flag, no dependency install, no Docker build/prune/reset.
The notebook uses the same functions as the CLI smoke.
"""
from __future__ import annotations

import concurrent.futures
import csv
import datetime as dt
from email.utils import parsedate_to_datetime
import hashlib
import http.client
import json
import math
import os
import platform
from pathlib import Path
import random
import re
import subprocess
import threading
import time
import uuid
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'test-results' / 'phase2'


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def summarize(rows, elapsed):
    groups = {}
    for row in rows:
        groups.setdefault(row['operation'], []).append(row)
    result = []
    for operation, samples in sorted(groups.items()):
        good = [x for x in samples if x['outcome'] == 'success']
        latencies = [x['latency_ms'] for x in samples]
        result.append({
            'operation': operation, 'attempts': len(samples), 'successes': len(good),
            'successful_rps': len(good) / elapsed if elapsed else 0,
            'p50_ms_all': percentile(latencies, .5), 'p95_ms_all': percentile(latencies, .95),
            'p99_ms_all': percentile(latencies, .99),
            'p95_ms_success': percentile([x['latency_ms'] for x in good], .95),
            'success_ratio': len(good) / len(samples),
            'rate_429': sum(x['status'] == 429 for x in samples) / len(samples),
            'rate_503': sum(x['status'] == 503 for x in samples) / len(samples),
            'unexpected_error_rate': sum(x['outcome'] not in ('success', 'rate_limited') for x in samples) / len(samples),
        })
    return result


def retry_after_seconds(headers, *, remaining, fallback=1, now=None):
    """Interpret Retry-After without letting a bad header crash/extend the run."""
    raw = next((value for key, value in headers.items() if key.lower() == 'retry-after'), None)
    wait = fallback
    if raw is not None:
        try:
            wait = float(raw)
        except (TypeError, ValueError):
            try:
                when = parsedate_to_datetime(raw)
                if when.tzinfo is None:
                    when = when.replace(tzinfo=dt.timezone.utc)
                now = now or dt.datetime.now(dt.timezone.utc)
                wait = max(0, (when - now).total_seconds())
            except (TypeError, ValueError, OverflowError):
                wait = fallback
    if not math.isfinite(wait) or wait < 0:
        wait = fallback
    return min(wait, max(0, remaining))


class LocalFixture:
    def __init__(self, accounts=1):
        if not isinstance(accounts, int) or not 1 <= accounts <= 40:
            raise ValueError('Fixture accounts must be 1-40')
        self.account_count = accounts
        self.run = str(uuid.uuid4())
        self.process = None
        self.log = None
        self.tokens = {}

    def start(self):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        self.log = (OUTPUT / f'load-{self.run}-server.log').open('w', encoding='utf-8')
        env = dict(os.environ, PHASE2_LOAD_RUN=self.run, PHASE2_LOAD_ACCOUNTS=str(self.account_count) if self.account_count > 1 else '')
        self.process = subprocess.Popen(
            ['node', '--import', 'tsx', 'benchmarks/phase2/start_fixture.mjs'],
            cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=self.log, stderr=subprocess.STDOUT,
            text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        manifest_path = OUTPUT / f'load-{self.run}.json'
        end = time.monotonic() + 150
        while time.monotonic() < end:
            if self.process.poll() is not None:
                raise RuntimeError(f'Fixture startup failed; inspect {self.log.name}')
            if manifest_path.exists():
                self.manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
                break
            time.sleep(.25)
        else:
            raise RuntimeError(f'Fixture startup timed out; inspect {self.log.name}')
        m = self.manifest
        if m['run'] != self.run or m['pid'] != self.process.pid or m['baseUrl'] != 'http://127.0.0.1:5189' or m['composeProject'] != 'pet-phase2-p1-test' or m.get('stoppedAt'):
            raise RuntimeError('Fixture identity mismatch')
        fixture_path = Path(m['fixtureFile']).resolve()
        if fixture_path != (OUTPUT / f'load-{self.run}-fixture.json').resolve():
            raise RuntimeError('Unexpected fixture file')
        self.fixture = json.loads(fixture_path.read_text(encoding='utf-8'))
        if self.fixture['run'] != m['fixtureRun']:
            raise RuntimeError('Another fixture replaced this run; do not run E2E concurrently')
        for role in ['owner', 'admin']:
            account = self.fixture[role]
            key = 'email' if role == 'owner' else 'username'
            status, data, _ = self.request('POST', f'/api/auth/{role}/login',
                {key: account[key], 'password': self.fixture['password']})
            if status != 200 or data.get('user', {}).get('id') != account['id']:
                raise RuntimeError(f'{role} fixture login failed (HTTP {status})')
            self.tokens[role] = data['token']
        self.actors = []
        for index, account in enumerate(self.fixture.get('loadAccounts', [])):
            role = 'load_' + str(index)
            status, data, _ = self.request('POST', '/api/auth/owner/login',
                {'email': account['email'], 'password': self.fixture['password']})
            if status != 200 or data.get('user', {}).get('id') != account['id']:
                raise RuntimeError(f'Load account login failed (HTTP {status})')
            self.tokens[role] = data['token']
            self.actors.append({**account, 'role': role})
        if not self.actors:
            self.actors = [{**self.fixture['owner'], 'pets': self.fixture['pets'], 'role': 'owner'}]
        return self

    def metrics(self):
        samples = []
        for service, origin in self.fixture['origins'].items():
            address = urlsplit(origin)
            if service not in ('core', 'clinic', 'notification') or address.scheme != 'http' or address.hostname != '127.0.0.1' or not address.port:
                raise RuntimeError('Unexpected metrics target')
            connection = http.client.HTTPConnection(address.hostname, address.port, timeout=5)
            try:
                connection.request('GET', '/metrics', headers={'X-Service-Token': self.fixture['metricsToken']})
                response = connection.getresponse()
                text = response.read().decode('utf-8')
                sample = {'service': service, 'http_status': response.status, 'observed_utc': dt.datetime.now(dt.timezone.utc).isoformat()}
                if response.status == 200:
                    for name, value in re.findall(r'^(pet_[a-z_]+)\{service="[a-z]+"\} ([0-9.eE+-]+)$', text, re.M):
                        sample[name] = float(value)
                samples.append(sample)
            except (OSError, TimeoutError, http.client.HTTPException):
                samples.append({'service': service, 'http_status': 0, 'observed_utc': dt.datetime.now(dt.timezone.utc).isoformat()})
            finally:
                connection.close()
        return samples

    def request(self, method, path, body=None, role=None, key=None, connection=None):
        if self.process is None or self.process.poll() is not None:
            raise RuntimeError('Owned fixture is not running')
        if not path.startswith('/api/') or path.startswith('//'):
            raise ValueError('Only local public API paths allowed')
        connection = connection or http.client.HTTPConnection('127.0.0.1', 5189, timeout=15)
        headers = {'Content-Type': 'application/json'}
        if role:
            headers['Authorization'] = 'Bearer ' + self.tokens[role]
        if key:
            headers['Idempotency-Key'] = key
        try:
            connection.request(method, path, body=None if body is None else json.dumps(body), headers=headers)
            response = connection.getresponse()
            raw = response.read()
            try:
                data = json.loads(raw) if raw else None
            except (ValueError, UnicodeError):
                data = None
            return response.status, data, dict(response.getheaders())
        finally:
            # No session pooling claims: each sample includes a fresh local connection.
            connection.close()

    def close(self):
        if self.process and self.process.poll() is None:
            try:
                self.process.stdin.write('stop\n')
                self.process.stdin.flush()
                self.process.wait(timeout=75)
            except (BrokenPipeError, subprocess.TimeoutExpired) as error:
                raise RuntimeError('Graceful shutdown failed; owned processes require inspection, not a global kill') from error
        if self.log:
            self.log.close()
        if self.process and self.process.returncode != 0:
            raise RuntimeError(f'Fixture exited {self.process.returncode}; inspect local log')

    def __enter__(self):
        try:
            return self.start()
        except BaseException:
            self.close()
            raise

    def __exit__(self, *unused):
        self.close()


READS = [
    ('core.pets', '/api/pets?page=1&pageSize=20'),
    ('clinic.appointments', '/api/appointments?page=1&pageSize=20'),
    ('clinic.medical', '/api/medical-records?page=1&pageSize=20'),
    ('core.hotel', '/api/hotel-bookings?page=1&pageSize=20'),
    ('core.invoices', '/api/invoices?page=1&pageSize=20'),
    ('notification.list', '/api/notifications?page=1&pageSize=20'),
]


def run_load(fixture, *, profile='read', users=2, seconds=15, max_requests=2000,
             think_seconds=.1, allow_writes=False, seed=20261013):
    if profile not in ('read', 'login_policy', 'clinic_write', 'mixed'):
        raise ValueError('Unknown workload')
    if not 1 <= users <= 100 or not 1 <= seconds <= 1800 or not 1 <= max_requests <= 10000 or not 0 <= think_seconds <= 10:
        raise ValueError('Load outside notebook bounds')
    if profile in ('clinic_write', 'mixed') and not allow_writes:
        raise ValueError('Set allow_writes=True explicitly for the guarded synthetic fixture')
    baseline_count = None
    actors = getattr(fixture, 'actors', None) or [{**fixture.fixture.get('owner', {}), 'pets': fixture.fixture['pets'], 'role': 'owner'}]
    if profile in ('clinic_write', 'mixed'):
        baseline_count = 0
        for actor in actors:
            status, data, _ = fixture.request('GET', '/api/appointments?pageSize=1', role=actor['role'])
            if status != 200 or not isinstance(data, dict):
                raise RuntimeError('Cannot establish pre-load fixture appointment count')
            baseline_count += data['pagination']['total']
    rows, counter, lock = [], [0], threading.Lock()
    telemetry, stop_telemetry = [], threading.Event()
    start = time.monotonic()
    deadline = start + seconds
    run_id = str(uuid.uuid4())
    created = []

    def worker(index):
        rng = random.Random(seed + index)
        actor = actors[index % len(actors)]
        while time.monotonic() < deadline:
            with lock:
                if counter[0] >= max_requests:
                    return
                sequence = counter[0]
                counter[0] += 1
            is_write = profile == 'clinic_write' or profile == 'mixed' and rng.random() < .2
            if profile == 'login_policy':
                operation, method, path, role = 'auth.login_policy', 'POST', '/api/auth/owner/login', None
                body = {'email': actor['email'], 'password': fixture.fixture['password']}
            elif is_write:
                operation, method, path, role = 'clinic.create', 'POST', '/api/appointments', actor['role']
                # Fresh UUID fixture pet plus unique slot across repetitions.
                offset = fixture.slot_counter + sequence
                pet_count = len(actor['pets'])
                day = dt.datetime.now(dt.timezone(dt.timedelta(hours=7))).date() + dt.timedelta(days=30 + offset // (pet_count * 20))
                body = {'petId': actor['pets'][offset % pet_count]['id'], 'type': 'spa_bath',
                        'serviceName': 'Synthetic load ' + run_id[:8], 'date': day.isoformat(),
                        'time': f'{8 + (offset // pet_count) % 10:02d}:{30 * ((offset // (pet_count * 10)) % 2):02d}'}
            else:
                operation, path = READS[sequence % len(READS)]
                method, role, body = 'GET', actor['role'], None
            before = time.monotonic()
            status, valid, outcome, resource_id = 0, False, 'transport_error', None
            try:
                status, data, headers = fixture.request(method, path, body, role, str(uuid.uuid4()) if is_write else None)
                if is_write:
                    resource_id = data.get('appointment', {}).get('id') if isinstance(data, dict) else None
                    valid = status == 201 and bool(resource_id)
                elif profile == 'login_policy':
                    valid = status == 200 and isinstance(data, dict) and data.get('user', {}).get('id') == actor['id'] and bool(data.get('token'))
                else:
                    valid = status == 200 and isinstance(data, dict) and isinstance(data.get('items'), list) and isinstance(data.get('pagination'), dict)
                    if valid and actor.get('id'):
                        valid = all(item.get('ownerId', actor['id']) == actor['id'] and not item.get('internalNote') for item in data['items'])
                    if valid and fixture.fixture.get('dataset') and operation != 'notification.list':
                        valid = len(data['items']) > 0
                outcome = 'success' if valid else 'rate_limited' if status == 429 else 'overload' if status == 503 else 'http_or_contract_error'
                if status in (429, 503):
                    # Honor Retry-After without extending the bounded measurement indefinitely.
                    wait = retry_after_seconds(headers, remaining=deadline - time.monotonic())
                else:
                    wait = think_seconds
            except (OSError, TimeoutError, http.client.HTTPException):
                wait = think_seconds
            row = {'operation': operation, 'status': status, 'outcome': outcome,
                   'latency_ms': (time.monotonic() - before) * 1000,
                   'started_s': before - start, 'worker': index}
            with lock:
                rows.append(row)
                if is_write and valid:
                    created.append(resource_id)
            time.sleep(min(wait, max(0, deadline - time.monotonic())))

    if not hasattr(fixture, 'slot_counter'):
        fixture.slot_counter = 0
    def collect_metrics():
        while not stop_telemetry.is_set():
            telemetry.extend(fixture.metrics())
            stop_telemetry.wait(2)
    collector = threading.Thread(target=collect_metrics, daemon=True)
    collector.start()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=users) as executor:
            list(executor.map(worker, range(users)))
    finally:
        elapsed = time.monotonic() - start
        stop_telemetry.set()
        collector.join(timeout=20)
        if collector.is_alive():
            raise RuntimeError('Metrics collector did not stop')
    fixture.slot_counter += counter[0]
    if len(rows) != counter[0]:
        raise RuntimeError('Started/completed request count mismatch')
    reconciliation = {'status': 'NOT_APPLICABLE'}
    if baseline_count is not None:
        found, slots, duplicates = set(), set(), 0
        observed_count, verified = 0, True
        for actor in actors:
            page, total_pages, actor_count = 1, 1, 0
            while page <= total_pages:
                status, data, _ = fixture.request('GET', f'/api/appointments?page={page}&pageSize=100', role=actor['role'])
                if status != 200 or not isinstance(data, dict):
                    reconciliation = {'status': 'UNVERIFIED', 'http_status': status}
                    verified = False
                    break
                actor_count = data['pagination']['total']
                total_pages = data['pagination']['totalPages']
                for item in data['items']:
                    found.add(item['id'])
                    slot = (item['petId'], item.get('date', item.get('appointmentDate')), item.get('time', item.get('appointmentTime')))
                    if item['status'] not in ('cancelled', 'no_show'):
                        duplicates += slot in slots
                        slots.add(slot)
                page += 1
            observed_count += actor_count
        if verified:
            missing = len(set(created) - found)
            count_matches = observed_count == baseline_count + len(set(created))
            duplicate_ids = len(created) - len(set(created))
            reconciliation = {'status': 'PASS_IN_SCOPE' if not missing and not duplicates and not duplicate_ids and count_matches else 'REVIEW_REQUIRED',
                              'before': baseline_count, 'after': observed_count, 'successful_creates': len(created),
                              'missing_success_ids': missing, 'duplicate_active_slots': duplicates,
                              'duplicate_response_ids': duplicate_ids,
                              'count_matches_successful_responses': count_matches,
                              'note': 'A timed-out write may commit; mismatch requires operation/DB investigation, not automatic retry.'}
    return {'run': run_id, 'profile': profile, 'users': users, 'requested_seconds': seconds,
            'elapsed_seconds': elapsed, 'max_requests': max_requests, 'request_cap_reached': len(rows) >= max_requests,
            'started_requests': counter[0], 'completed_requests': len(rows), 'think_seconds': think_seconds,
            'summary': summarize(rows, elapsed), 'rows': rows, 'created_ids': created, 'telemetry': telemetry,
            'duplicate_returned_ids': len(created) - len(set(created)), 'reconciliation': reconciliation}


def save_run(fixture, result, *, warmup_seconds=0, repeat=1, repeats=1):
    destination = OUTPUT / ('load-result-' + result['run'])
    destination.mkdir(exist_ok=False)
    rows = result['rows']
    with (destination / 'requests.csv').open('w', newline='', encoding='utf-8') as stream:
        writer = csv.DictWriter(stream, fieldnames=['operation', 'status', 'outcome', 'latency_ms', 'started_s', 'worker'])
        writer.writeheader()
        writer.writerows(rows)
    completed_duration = result['elapsed_seconds'] >= result['requested_seconds'] and not result['request_cap_reached']
    qualified_duration = warmup_seconds >= 120 and result['requested_seconds'] >= 300 and repeats >= 3 and completed_duration
    (destination / 'metrics.json').write_text(json.dumps(result['telemetry'], indent=2), encoding='utf-8')
    report = {key: value for key, value in result.items() if key not in ('rows', 'created_ids', 'telemetry')}
    report.update({'classification': 'MEASURED_SCOPE_ONLY' if qualified_duration else 'SCREENING',
                   'capacity_accepted': False, 'warmup_seconds': warmup_seconds, 'repeat': repeat, 'repeats_planned': repeats,
                   'fixture_run': fixture.manifest['fixtureRun'], 'topology': fixture.manifest['topology'],
                   'limits': fixture.manifest['limits'], 'generated_at_utc': dt.datetime.now(dt.timezone.utc).isoformat(),
                   'client_model': 'closed-loop threads, worker assigned to owner account, common IP, fresh TCP per request',
                   'dataset': fixture.manifest.get('dataset', {'accounts': 1}),
                   'limitations': ['no B0/B2/B3 comparison', 'no open-loop arrival-rate capacity', 'no billing terminal latency',
                                   'no notification end-to-end lag; API metrics exclude workers and DB host CPU', 'shared account limiter may dominate',
                                   'warmup and earlier profiles consume the same account/IP quotas; counters are never reset between profiles',
                                   'single-owner fixture lists can be empty; multi-owner fixture is synthetic, not a production-sized dataset']})
    try:
        report['git_head'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        report['tracked_diff_sha256'] = hashlib.sha256(subprocess.check_output(['git', 'diff', 'HEAD', '--binary'], cwd=ROOT)).hexdigest()
    except subprocess.CalledProcessError:
        report['git_head'] = None
    report['runner_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    report['benchmark_sources_sha256'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
        for p in Path(__file__).parent.iterdir() if p.suffix in ('.py', '.mjs', '.ipynb')}
    report['environment'] = {'os': platform.platform(), 'python': platform.python_version(),
        'logical_cpus': os.cpu_count(), 'memory_quota': 'not configured; shared local host',
        'node': subprocess.check_output(['node', '--version'], cwd=ROOT, text=True).strip(),
        'package_lock_sha256': hashlib.sha256((ROOT / 'package-lock.json').read_bytes()).hexdigest()}
    (destination / 'summary.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    return destination, report


if __name__ == '__main__':
    with LocalFixture() as fixture:
        result = run_load(fixture, seconds=10, users=2, max_requests=200)
        path, report = save_run(fixture, result)
        print(json.dumps({'artifact': str(path), 'classification': report['classification'],
                          'completed_requests': report['completed_requests'], 'summary': report['summary']}, indent=2))
