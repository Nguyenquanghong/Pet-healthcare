"""Pinned O HTTP query-heavy baseline. All writes are guarded native trial setup."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import platform
import threading
import time
from urllib.parse import quote

from benchmark import Client, POLICY, open_loop, summarize
from native_stack import NativeStack
from pcn_runner import resource_sample
from cqrs_probe import read_evidence, correct_path, preflight as cqrs_preflight
from cqrs_diagnostics import collect as collect_read_diagnostics

PROTOCOL = 'cqrs-q0-query-heavy-v2'
OPERATIONS = ('owner-list', 'admin-list', 'admin-search', 'admin-unbilled',
              'owner-calendar', 'admin-calendar', 'admin-filter', 'admin-page')
STATUSES = ('pending', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show')
CONFIG = {'warmup': 120, 'seconds': 800, 'rate': 12, 'concurrency': 16, 'runs': 3}


def validate_profile(settings):
    # Pinned O defaults: Clinic read 600/actor/min and 3000/IP/min.
    # One admin receives six of eight operations. Keep a full in-flight burst in reserve.
    admin_fraction = sum(op.startswith('admin-') for op in OPERATIONS) / len(OPERATIONS)
    if (settings['rate'] * 60 * admin_fraction + settings['concurrency'] > 600
            or settings['rate'] * 60 + settings['concurrency'] > 3000):
        raise ValueError('Offered workload exceeds pinned limiter budget; choose a new explicit protocol, never override quotas')


def limiter_headers(headers):
    """Only numeric public limiter fields; never export arbitrary headers."""
    lowered = {key.lower(): value for key, value in headers.items()}
    result = {}
    for name, header in [('limit', 'ratelimit-limit'), ('remaining', 'ratelimit-remaining'), ('retry_after_seconds', 'retry-after')]:
        value = lowered.get(header, '')
        result[name] = int(value) if isinstance(value, str) and value.isascii() and value.isdigit() and len(value) <= 9 else None
    return result


def fixture_indices(operation):
    indices = list(range(1000))
    if operation == 'admin-unbilled':
        indices = [i for i in indices if i % 7 == 4 and not (i % 17 == 0 and (i // 17) % 3 != 2)]
    if operation == 'admin-filter':
        indices = [i for i in indices if i < 48 and i % 10 in (6, 7, 8)]
    return indices


def valid_response(operation, body, actor):
    """Check fixture counts, calendar cells, owner scope/redaction, nonempty pages."""
    multiplier = 1 if operation.startswith('owner-') else 100
    if operation.endswith('calendar'):
        expected = {f'2028-02-{day:02d}': min(48, 1000 - (day - 1) * 48) * multiplier for day in range(1, 22)}
        return body == expected
    indices = fixture_indices(operation)
    counts = {status: sum(i % 7 == n for i in indices) * multiplier for n, status in enumerate(STATUSES)}
    counts = {k: v for k, v in counts.items() if v}
    # The original reader always includes this separate count. In unbilled mode
    # its HELD predicate replaces reservations:none while retaining status=completed.
    held_indices = [i for i in range(1000) if i % 7 == 4] if operation == 'admin-unbilled' else indices
    counts['billingHeld'] = sum(i % 51 == 0 for i in held_indices) * multiplier
    total = sum((i % 7 < 4 if operation == 'admin-filter' else True) for i in indices) * multiplier
    size = 100 if operation in ('admin-list', 'admin-search', 'admin-page') else 20
    page = 500 if operation == 'admin-page' else 1
    expected_items = min(size, max(0, total - (page - 1) * size))
    items, pagination, related = body.get('items'), body.get('pagination', {}), body.get('related', {})
    if (not isinstance(items, list) or len(items) != expected_items or body.get('counts') != counts
            or pagination != {'page': page, 'pageSize': size, 'total': total, 'totalPages': (total + size - 1) // size}):
        return False
    if operation == 'owner-list':
        if any(row.get('ownerId') != actor['id'] or 'internalNote' in row for row in items): return False
        if any(row.get('id') != actor['id'] for row in related.get('owners', [])): return False
        if any(row.get('ownerId') != actor['id'] for row in related.get('pets', [])): return False
    return all(isinstance(row.get('id'), str) for row in items)


def preflight(client):
    """Return allowlisted diagnostics only: no tokens, IDs, notes or HTTP bodies."""
    checks = []
    for n in (0, 1):
        actor = client.actors[n]
        status, body, _ = client.request('GET', '/api/appointments?ownerId=' + client.actors[1-n]['id'], token=actor['token'])
        try:
            valid = status == 200 and valid_response('owner-list', body, actor)
        except (TypeError, ValueError, AttributeError, KeyError):
            valid = False
        counts = body.get('counts', {}) if isinstance(body, dict) else {}
        pagination = body.get('pagination', {}) if isinstance(body, dict) else {}
        numeric = lambda value: value if type(value) in (int, float) else None
        checks.append({'check': 'owner-scope-' + str(n), 'status': status, 'valid': valid,
            'counts': {key: numeric(counts.get(key)) if isinstance(counts, dict) else None for key in (*STATUSES, 'billingHeld')},
            'pagination': {key: numeric(pagination.get(key)) if isinstance(pagination, dict) else None for key in ('page','pageSize','total','totalPages')}})
        if not valid: return checks
    status, _, _ = client.request('GET', '/api/appointments')
    checks.append({'check': 'anonymous-denied', 'status': status, 'valid': status == 401})
    return checks


class QueryClient(Client):
    def __init__(self, stack):
        super().__init__(stack)
        self.cqrs = stack.fixture.get('cqrs')
        admin = self.fixture['admin']
        status, body, _ = self.request('POST', '/api/auth/admin/login',
                                     {'username': admin['username'], 'password': self.fixture['password']})
        if status != 200 or body.get('user', {}).get('id') != admin['id']:
            raise RuntimeError('Synthetic admin login failed')
        self.admin_token = body['token']
        self.paths = ('/api/appointments', '/api/appointments?pageSize=100',
                      '/api/appointments?q=' + quote('Mèo') + '&pageSize=100', '/api/appointments?mode=unbilled',
                      '/api/appointments/calendar?month=2028-02', '/api/appointments/calendar?month=2028-02',
                      '/api/appointments?category=spa&statusGroup=pending&date=2028-02-01',
                      '/api/appointments?page=500&pageSize=100')

    def read(self, index):
        op = index % len(OPERATIONS)
        operation = OPERATIONS[op]
        actor = self.actors[(index // len(OPERATIONS)) % len(self.actors)]
        row = {'operation': operation, 'status': 0, 'sent': True, 'outcome': 'transport_error', 'instance': ''}
        try:
            status, body, headers = self.request('GET', self.paths[op], token=actor['token'] if operation.startswith('owner-') else self.admin_token)
            row['status'] = status
            row['instance'] = headers.get('X-Service-Instance', '')
            row['rate_limit'] = limiter_headers(headers)
            cqrs = getattr(self, 'cqrs', None)
            if cqrs:
                row.update(read_evidence(headers, cqrs.get('generation')))
            try:
                valid = status == 200 and valid_response(operation, body, actor)
                if cqrs:
                    valid = valid and correct_path(cqrs['configuration'], row, unbilled=operation == 'admin-unbilled')
            except (TypeError, ValueError, AttributeError, KeyError):
                valid = False
            row['outcome'] = ('success' if valid else 'contract_error') if status == 200 else 'overload' if status in (429, 503) else 'http_error'
        except (OSError, TimeoutError, http.client.HTTPException):
            pass
        return row


def measure(call, *, rate, seconds, concurrency):
    load = open_loop(call, rate=rate, seconds=seconds, concurrency=concurrency)
    # The shared scheduler labels drops generically; attribute every arrival to its planned operation.
    for row in load['rows']:
        row['operation'] = OPERATIONS[row['sequence'] % len(OPERATIONS)]
    load['summary'] = summarize(load['rows'], seconds)
    for item in load['summary']:
        rows = [r for r in load['rows'] if r['operation'] == item['operation']]
        item['unexpected_error_ratio'] = sum(r['outcome'] in ('transport_error', 'contract_error', 'overload', 'http_error') for r in rows) / len(rows)
    return load


def collect_post_load_plans(stack, output):
    # Called only after generator drain and sampler join, never before warmup
    # or between a successful warmup and its measured window.
    try:
        result = stack.control('cqrs-query-plans')
        # v2 preserves all bounded aggregate statements; v1 remains readable
        # for historical/single-statement collectors. Neither changes the gate.
        assert type(result['version']) is int and result['version'] in (1, 2)
        assert result['status'] in ('COLLECTED', 'PARTIAL')
        assert result['scope'] == 'post-load-read-only' and result['capacityAccepted'] is False
        data = (json.dumps(result, indent=2) + '\n').encode()
        (Path(output) / 'query-plans.json').write_bytes(data)
        return {'status':result['status'], 'sha256':hashlib.sha256(data).hexdigest(),
                'scope':'post-load-read-only', 'capacity_accepted':False}
    except Exception:
        # Control errors can contain private setup information. Do not export
        # the exception, and do not change the independently computed gate.
        return {'status':'UNAVAILABLE', 'scope':'post-load-read-only', 'capacity_accepted':False}


def healthy(load, *, full):
    if not load.get('generator_valid') or len(load.get('summary', [])) != len(OPERATIONS): return False
    if any(row['outcome'] != 'success' for row in load['rows']): return False
    if full and (load['seconds'] < 300 or any(s['success'] < 1000 or s['threshold_result'] != 'PASS_IN_SCOPE' for s in load['summary'])): return False
    # The readiness gate is deliberately stricter than NFR acceptance: no overload/drops/retries.
    return True


def run_trial(repo, output, *, mode, progress=print, cqrs_configuration=None):
    if mode not in ('smoke', 'full'): raise ValueError('Unknown query-heavy mode')
    if cqrs_configuration not in (None, 'O', 'A', 'B'): raise ValueError('Unknown CQRS configuration')
    repo, output = Path(repo).resolve(), Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    settings = CONFIG if mode == 'full' else {**CONFIG, 'warmup': 5, 'seconds': 70}
    validate_profile(settings)
    report = {'protocol': PROTOCOL if cqrs_configuration is None else 'cqrs-q6-query-heavy-v1', 'mode': mode, 'configuration': cqrs_configuration or 'O', 'settings': settings,
              'status': 'STARTING', 'capacity_accepted': False, 'process_sample_errors': 0,
              'limits': ['Shared Kaggle CPU/RAM; no equal-budget comparison or projection measurement',
                         'HTTP includes real Core/JWT/directory/limiters; login/PBKDF2 in setup',
                         'Sampled DB waits include worker/observer connections; pure Prisma pool wait unavailable',
                         'CPU per PID/create-time; RSS sum can double-count shared pages; short-lived processes may be missed',
                         'Zero-error readiness gate is stricter than NFR; NFR thresholds also reported without changes']}
    for key in ('cpu.max', 'memory.max'):
        path = Path('/sys/fs/cgroup') / key
        if path.is_file(): report[key] = path.read_text().strip()
    report.update(platform=platform.platform(), cpu_count=os.cpu_count())
    report['rate_selection'] = {'previous_protocol': 'cqrs-q0-query-heavy-v1', 'previous_offered_rps': 24,
        'observed_failure': '960 HTTP429 during 120s warmup; one admin offered 1080 reads/min against default600',
        'admin_reads_per_minute': settings['rate'] * 60 * 6 / 8, 'actor_limit_per_minute': 600,
        'ip_limit_per_minute': 3000, 'quotas_changed': False,
        'note': 'Explicit v2 calibration after retained v1 failure; no adaptive rate changes, retry or reclassification of v1'}
    resources, observations, collection_errors, all_rows = [], [], [], []
    stage = 'startup'
    stack = None
    try:
        options = {} if cqrs_configuration is None else {'cqrs_configuration': cqrs_configuration}
        stack = NativeStack(repo, accounts=100, replicas=1, dataset_profile='query-heavy', **options)
        with stack:
            report.update(run=stack.run, dataset=stack.fixture['dataset'], db_cross_connect_denied=stack.fixture['dbCrossConnectDenied'])
            assert report['dataset']['appointments'] == 100000 and report['db_cross_connect_denied'] == 6
            stage = 'authentication'
            client = QueryClient(stack)
            if cqrs_configuration is not None:
                stage = 'cqrs-read-path-preflight'
                report['cqrs'] = stack.fixture['cqrs']
                report['cqrs_preflight'] = cqrs_preflight(client, cqrs_configuration, report['cqrs']['generation'])
                report['limits'][0] = 'Q6 diagnostic: shared host, no enforced equal total quota; capacity not accepted'
            stage = 'owner-scope-preflight'
            report['preflight'] = preflight(client)
            assert len(report['preflight']) == 3 and all(check['valid'] for check in report['preflight'])
            stage = 'fixture-snapshot'
            before = stack.control('query-snapshot')
            assert not before['unexpectedExit'] and before['appointment']['count'] == 100000
            tracked = [(p['name'], p['pid'], False) for p in stack.fixture['processes']]
            tracked += [(name, child.pid, name == 'rabbitmq') for name, child in stack.processes if name != 'application']
            tracked += [('postgres', int((stack.private / 'pgdata/postmaster.pid').read_text().splitlines()[0]), True),
                        ('nginx', int((stack.private / 'nginx.pid').read_text()), True), ('generator', os.getpid(), False)]
            if cqrs_configuration is not None:
                tracked.append(('stack-supervisor', stack.application.pid, False))
            for phase, seconds in (('warmup', settings['warmup']), ('measured', settings['seconds'])):
                stage = phase
                stop, samplers = threading.Event(), {}
                started = time.monotonic()
                def collect():
                    try:
                        next_progress = started
                        previous_sample = None
                        while not stop.is_set():
                            now = time.monotonic()
                            for sample in resource_sample(tracked, samplers, now):
                                interval = now - previous_sample if previous_sample is not None else None
                                cpu = sample.get('cpu_percent_one_core')
                                resources.append({**sample, 'phase': phase, 'interval_seconds': interval,
                                                  'cpu_seconds_delta': cpu * interval / 100 if cpu is not None and interval is not None else None})
                            previous_sample = now
                            snapshot = stack.control('query-observe')
                            if cqrs_configuration is not None:
                                snapshot['cqrs'] = stack.control('cqrs-observe')
                            observations.append({'phase': phase, 'monotonic_s': now, **snapshot})
                            if now >= next_progress:
                                progress(f'Query-heavy {mode} {phase}: {int(now-started)}s/{seconds}s; no retries')
                                next_progress = now + 30
                            stop.wait(1)
                    except Exception as error:
                        collection_errors.append(type(error).__name__)
                thread = threading.Thread(target=collect)
                thread.start()
                try:
                    load = measure(client.read, rate=settings['rate'], seconds=seconds, concurrency=settings['concurrency'])
                finally:
                    stop.set(); thread.join(timeout=50)
                all_rows.extend({**row, 'phase': phase} for row in load['rows'])
                report[phase] = {key: value for key, value in load.items() if key != 'rows'}
                report[phase]['start_monotonic_s'] = started
                assert not thread.is_alive() and not collection_errors, 'Telemetry failed'
                load_healthy = healthy(load, full=mode == 'full' and phase == 'measured')
                if cqrs_configuration == 'B' and (not load_healthy or phase == 'measured'):
                    report['query_plans'] = collect_post_load_plans(stack, output)
                if not load_healthy:
                    raise RuntimeError('Load/contract/generator gate failed; no automatic retry or rate adjustment')
            stage = 'reconciliation'
            after = stack.control('query-snapshot')
            assert before == after, 'Read workload changed fixture or child exited'
            report['reconciliation'] = {'status': 'PASS', 'before': before, 'after': after}
            report['process_sample_errors'] = sum('error' in r for r in resources)
            assert resources and observations and not report['process_sample_errors']
            assert not any(o['unexpectedExit'] for o in observations)
            measured = [r for r in resources if r['phase'] == 'measured' and r.get('cpu_seconds_delta') is not None]
            successes = sum(r['phase'] == 'measured' and r['outcome'] == 'success' for r in all_rows)
            report['cpu_observed'] = []
            for name in sorted({r['component'] for r in measured}):
                group = [r for r in measured if r['component'] == name]
                cpu = sum(r['cpu_seconds_delta'] for r in group)
                coverage = sum(r['interval_seconds'] for r in group)
                report['cpu_observed'].append({'component': name, 'cpu_seconds': cpu, 'coverage_seconds': coverage,
                    'percent_one_core': cpu / coverage * 100, 'cpu_ms_per_success_observed': cpu * 1000 / successes,
                    'max_rss_bytes_sum': max(r['rss_bytes_sum'] for r in group)})
            report['cpu_note'] = 'Sampled intervals only: first/final partial intervals and short-lived processes excluded; inspect coverage, not full-window exact CPU.'
            stage = 'teardown'
        report['status'] = ('BASELINE_RUN_RECORDED' if cqrs_configuration is None else 'BENCHMARK_RUN_RECORDED') if mode == 'full' else 'SMOKE_PASS'
    except Exception as error:
        report.update(status='FAIL', failed_stage=stage, error_type=type(error).__name__)
        progress(f'Query-heavy stopped at {stage}: {type(error).__name__}; private logs stay in /tmp')
    finally:
        if cqrs_configuration in ('A','B') and stack is not None:
            report['read_diagnostics'] = collect_read_diagnostics(stack.private, 1, output)
        report['collection_errors'] = collection_errors
        for name, data in [('requests.jsonl', all_rows), ('resources.jsonl', resources), ('database.jsonl', observations)]:
            with (output / name).open('w', encoding='utf-8') as handle:
                for row in data: handle.write(json.dumps(row) + '\n')
        report['hashes'] = {name: hashlib.sha256((output / name).read_bytes()).hexdigest() for name in ('requests.jsonl', 'resources.jsonl', 'database.jsonl')}
        if (output / 'read-diagnostics.jsonl').is_file():
            report['hashes']['read-diagnostics.jsonl'] = hashlib.sha256((output / 'read-diagnostics.jsonl').read_bytes()).hexdigest()
        if (output / 'query-plans.json').is_file():
            report['hashes']['query-plans.json'] = hashlib.sha256((output / 'query-plans.json').read_bytes()).hexdigest()
        (output / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    return report


def run_workflow(repo, output, *, full=True, runner=run_trial, progress=print):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    report = {'protocol': PROTOCOL, 'configuration': 'O', 'status': 'STARTING', 'capacity_accepted': False, 'trials': []}
    try:
        for name in ['smoke', *(['run-1', 'run-2', 'run-3'] if full else [])]:
            mode = 'smoke' if name == 'smoke' else 'full'
            result = runner(repo, output / name, mode=mode, progress=progress)
            report['trials'].append({'name': name, 'status': result['status'], 'run': result.get('run')})
            if result['status'] != ('SMOKE_PASS' if mode == 'smoke' else 'BASELINE_RUN_RECORDED'):
                report['status'] = 'STOPPED'; break
        else:
            report['status'] = 'BASELINE_O_RECORDED' if full else 'SMOKE_ONLY'
    except Exception as error:
        report.update(status='STOPPED', error_type=type(error).__name__)
    (output / 'workflow.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    return report
