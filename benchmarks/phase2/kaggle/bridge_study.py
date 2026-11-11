"""bridge-m-h-kaggle-v1: the pre-split monolith M against the current product H.

Answers "does the module split carry load better than the monolith" with one short
Kaggle session. One workload (bridge_locust.py: PCN tasks and pacing, bookings
valid in both versions), 100 closed-loop users, 30 s warmup after full population
and a 300 s window per member. Members run one at a time on fresh data in the
order M,H,H,M: the Kaggle host slows down 10-25% per member within a session
(cqrs-final-matched-kaggle-v1), and with ABBA a multiplicative drift that is
log-linear in the member position (the same factor per position) cancels exactly in
the geometric mean of the two H/M pairs; any other drift shape only cancels to first
order. A two-user smoke of each version gates the measured members.

Both versions run their own defaults except H's per-IP and rescue limiter
thresholds, raised because all generator traffic shares one loopback IP; the
limiter itself still runs (Redis round trip on every request). Per-actor limits
stay at H's defaults. M has no limiter outside /api/auth, which PCN never calls.

Decision rule, fixed before any run: for each operation the order-balanced H/M
p95 ratio r reads "H nhanh hơn" if r <= 0.9, "tương đương" if 0.9 < r < 1.1 and
"H chậm hơn" if r >= 1.1; the same bands apply to server CPU per successful
request. Throughput is reported, not graded (closed loop: think time bounds it).
A member that fails validity makes the comparison INVALID; nothing is retried.

bridge-m-h-vm-v1 (VmStudy, `--platform vm`) is the same study on a plain Ubuntu VM, with
the same load, fixture, bands and CPU-per-request method, and four configurations:
M (48d01c3), H0 (e0e8937, the Kaggle v1 anchor), H1 (the commit under test) and H2 (H1 with
two Core instances behind an nginx upstream). Order M,H0,H1,H2,H2,H1,H0,M: each ratio
(H0/M, H1/H0, H2/H1) is the geometric mean of the forward and the reverse adjacent pair, so
a multiplicative, log-linear host drift (same factor per position) cancels exactly; other
shapes only to first order. The Locust generator and the controller are pinned to the lowest
CPU and every server process to the remaining CPUs, minus the SMT sibling of the generator
CPU. Clinic and Notification reach Core through an nginx upstream in every H configuration.
A "from second 120" analysis is added as exploratory only.

bridge-m-h-vm-v2 (VmStudy2, `--platform vm --study v2`, K9) asks where Core and Clinic stop scaling and what a second instance, a
bigger Prisma pool or a second Notification worker buys. Three source trees (M, H1 = 2841d1b with the phase2 worker layout, H3 = the
tree of today with the workers layout), ten configurations (VM2_CONFIGS) and these parts, each in a palindrome order in which every
configuration runs twice, so that every ratio is the geometric mean of a forward and a reverse pair (pair_indices):
  Part 1   100 users, the settings of v1 (FULL): M,H1,H3,H3c,H3c,H3,H1,M.
  burst    100 users, N notifications into the Clinic outbox 120 s into the window: H3b,H3bnw2,H3bnw2,H3b.
  Part 2   200, 400 and 800 users (spawn rate users/10; 600 instead of 800 when the generator of the first member at 800 uses more than 0.70
           core), M,H3,H3x2,H3x2,H3,M; the highest step also runs the Clinic block, M,H3,H3cl2,H3x2,H3x2cl2,H3x2cl2,H3x2,H3cl2,H3,M.
  pool     H3,H3p8,H3p8,H3, once, at the first readable step where H3 is saturated and its Prisma pool is full (decided during the run).
An error rate above 1% no longer stops anything in Part 2 and the pool block: it is one of the three signs of saturation (throughput that
grows by less than 1.5x when the users double, a read p95 above 750 ms, errors above 1%). A member that FAILED stops the study; a member
that is merely invalid (generator above 0.80 core, topology that is not the one asked for, a burst that did not drain) is carried to the
analysis, which writes "không đọc được" where it cannot read. M, H1 and H3 are never compared at different loads: each ratio is between
members of one block.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

STUDY = 'bridge-m-h-kaggle-v1'
ORDER = ('M', 'H', 'H', 'M')
VM_STUDY = 'bridge-m-h-vm-v1'
VM_ORDER = ('M', 'H0', 'H1', 'H2', 'H2', 'H1', 'H0', 'M')
VM_SMOKE_ORDER = ('M', 'H0', 'H1', 'H2')
# (name, baseline, compared): each is read as compared/baseline.
VM_COMPARISONS = (('H0/M', 'M', 'H0'), ('H1/H0', 'H0', 'H1'), ('H2/H1', 'H1', 'H2'))
# Source tree and Core instances per configuration; H2 runs H1's tree with a second Core.
VM_CONFIGS = {'M': {'tree': 'M'}, 'H0': {'tree': 'H0', 'core': 1}, 'H1': {'tree': 'H1', 'core': 1}, 'H2': {'tree': 'H1', 'core': 2}}
LATE_FROM = 120
VM_HARNESS_CHANGES = (
    'stack.mjs: /api/notifications goes straight to the Notification service (deploy/phase2/nginx.split.conf.example); the Kaggle v1 '
    'harness sent it through Core. Applies to H0, H1 and H2.',
    'stack.mjs: in every H configuration (H0, H1, H2) Clinic and Notification call Core through an nginx listener in front of '
    '`upstream core_internal` (HTTP/1.1, keepalive 16, keepalive_timeout 4s below Core\'s 5s, X-Request-ID kept, proxy_next_upstream off), '
    'so H0, H1 and H2 differ only in the product code and in the number of Core instances. This hop is new compared with Kaggle v1, '
    'where Clinic called Core directly; the gateway to Core path has no keepalive, as in v1.',
    'stack.mjs: H2 runs two Core instances behind that upstream, each with its own SERVICE_INSTANCE_ID, HASH_CONCURRENCY=1 (two slots in all, '
    'as with one instance; the plan of the 28/10 handoff, tools/phase2/resilience.test.mjs uses 2) and its own Prisma pool of '
    'connection_limit=4, so Core holds 8 database connections instead of 4. HASH_PENDING_LIMIT stays 16 per instance (32 queued in all).',
    'The harness files of every H tree are the same bytes (taken from the harness commit), so H0 runs e0e8937 product code with today\'s harness.',
    'Pinning: the generator and the controller (sampler) run on the lowest CPU; every server process is started under taskset on the other '
    'CPUs, leaving the SMT sibling of the generator CPU idle when there is one (pinning.smt_siblings_left_idle, thread_siblings_list).')
FULL = {'users': 100, 'seconds': 300, 'warmup': 30, 'spawn_rate': 10}
SMOKE = {'users': 2, 'seconds': 15, 'warmup': 2, 'spawn_rate': 10}
LOCUSTFILE = 'benchmarks/phase2/kaggle/bridge_locust.py'
H_LIMITS = {name: '1000000' for name in ('API_READ_IP_LIMIT', 'API_WRITE_IP_LIMIT', 'RESCUE_REPORT_IP_LIMIT',
                                         'RESCUE_REPORT_TOKEN_LIMIT', 'RESCUE_REPORT_TOKEN_DAILY_LIMIT')}
BANDS = (0.9, 1.1)
APT = ('postgresql', 'postgresql-client', 'libpq-dev', 'rabbitmq-server', 'redis-server', 'nginx', 'ca-certificates', 'xz-utils')
PIP = ('locust==2.44.4', 'psutil==7.0.0')
NODE = 'v24.16.0'
NOT_SERVER = ('generator', 'controller', 'stack-supervisor')
EXPORT = ('manifest.json', 'pcn-report.json', 'load-final.json', 'http-summary.json', 'reconciliation.json',
          'generator.json', 'resources.jsonl', 'requests.jsonl', 'http.csv',
          'burst.json', 'burst.jsonl')   # v2 burst members (the pg_stat_activity summary and the pool evidence are in manifest.json)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def percentile(values, q):
    """Nearest rank, as pcn_contract.percentile."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(q / 100 * len(ordered)) - 1)]


# ---- evaluation (pure; tested offline) ---------------------------------------
def operation_stats(rows):
    operations = {}
    for row in rows:
        operations.setdefault(row['name'], []).append(row)
    return {name: {'requests': len(items), 'failures': sum(r['failed'] for r in items),
                   'p50_ms': percentile([r['response_time_ms'] for r in items], 50),
                   'p95_ms': percentile([r['response_time_ms'] for r in items], 95),
                   'mean_response_bytes': sum(r['response_bytes'] or 0 for r in items) / len(items)}
            for name, items in sorted(operations.items())}


def member_metrics(directory, settings, require_cpu=True, late_from=None, v2=None):
    """require_cpu=False for the smoke: its 15 s window has no steady part after trimming.
    late_from: also summarise requests started at or after that second of the window (exploratory, VM study).
    v2: None for v1; for the VM v2 study a dict {'config', 'errors_invalidate', 'burst', 'pg_sampler', 'burst_at'} (see v2_extension): the metrics then also carry the read p95, the CPU of every
    process and of the generator, the 429 and 503 counts, the pool evidence and the burst, and the member is also invalid when its manifest is not the configuration asked for."""
    directory = Path(directory)
    report = json.loads((directory / 'pcn-report.json').read_text(encoding='utf-8'))
    manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('status') != 'COMPLETE':
        failed = {'valid': False, 'reasons': ['member ' + manifest.get('status', 'missing') + ' at ' + str(manifest.get('failed_stage'))]}
        if v2 is not None:
            failed['failed'] = True  # a member that did not complete stops the v2 study
        return failed
    load = json.loads((directory / 'load-final.json').read_text())
    reconciliation = json.loads((directory / 'reconciliation.json').read_text())
    rows = [json.loads(line) for line in (directory / 'requests.jsonl').read_text().splitlines() if line]
    ops = operation_stats(rows)
    latencies = [r['response_time_ms'] for r in rows]
    # Server CPU over the steady part: drop ramp + warmup (+5 s) and the 15 s drain.
    samples = [json.loads(line) for line in (directory / 'resources.jsonl').read_text().splitlines() if line]
    by_time = {}
    for s in samples:
        by_time.setdefault(s['monotonic_s'], []).append(s)
    times = sorted(by_time)
    cores, rss, late_cores = [], [], []
    series, generator = {}, []  # v2: CPU of every server process and of the generator over the same steady seconds
    if times:
        ramped = times[0] + settings['users'] / settings['spawn_rate'] + settings['warmup']
        for t in (t for t in times if ramped + 5 <= t <= times[-1] - 15):
            server = [s for s in by_time[t] if s['component'] not in NOT_SERVER and 'error' not in s]
            if server and all(s['cpu_percent_one_core'] is not None for s in server):
                cores.append(sum(s['cpu_percent_one_core'] for s in server) / 100)
                rss.append(sum(s['rss_bytes_sum'] for s in server))
                if late_from is not None and t >= ramped + late_from:
                    late_cores.append(cores[-1])
                if v2 is not None:
                    for s in server:
                        series.setdefault(s['component'], []).append(s['cpu_percent_one_core'] / 100)
                    for s in by_time[t]:
                        if s['component'] == 'generator' and 'error' not in s and s['cpu_percent_one_core'] is not None:
                            generator.append(s['cpu_percent_one_core'] / 100)
    success_rps = report.get('success_rps')
    reasons = []
    if not load.get('completed'):
        reasons.append('window not completed')
    if load.get('observed_user_min') != settings['users']:
        reasons.append('population below target')
    if not report.get('raw_counts_match'):
        reasons.append('raw counts mismatch')
    if (load.get('error_rate') or 0) > 0.01 and (v2 is None or v2.get('errors_invalidate', True)):
        reasons.append('error rate above 1%')
    for key in ('missing_success_ids', 'duplicate_active_slots', 'duplicate_response_ids'):
        if reconciliation.get(key):
            reasons.append('reconciliation ' + key)
    if reconciliation.get('unexpected_child_exit'):
        reasons.append('unexpected process exit')
    if manifest.get('process_sample_errors'):
        reasons.append('process sample errors')
    if manifest.get('pinning') and not manifest['pinning'].get('verified'):
        reasons.append('pinning not applied')
    if require_cpu and not cores:
        reasons.append('no steady CPU samples')
    extension = v2_extension(directory, settings, manifest, rows, series, generator, require_cpu, v2, reasons) if v2 is not None else {}
    mean_cores = sum(cores) / len(cores) if cores else None
    late = None
    if late_from is not None and settings['seconds'] > late_from:
        tail = [r for r in rows if r['started_seconds'] >= late_from]
        late_success_rps = (len(tail) - sum(r['failed'] for r in tail)) / (settings['seconds'] - late_from)
        late_mean = sum(late_cores) / len(late_cores) if late_cores else None
        late = {'from_seconds': late_from, 'requests': len(tail), 'p50_ms': percentile([r['response_time_ms'] for r in tail], 50),
                'p95_ms': percentile([r['response_time_ms'] for r in tail], 95), 'operations': operation_stats(tail),
                'success_rps': late_success_rps, 'server_cores': late_mean,
                'cpu_ms_per_success': late_mean * 1000 / late_success_rps if late_mean and late_success_rps else None}
    metrics = {'valid': not reasons, 'reasons': reasons, 'operations': ops, 'requests': len(rows),
               'failures': sum(r['failed'] for r in rows), 'error_rate': load.get('error_rate'),
               'p50_ms': percentile(latencies, 50), 'p95_ms': percentile(latencies, 95), 'success_rps': success_rps,
               'server_cores': mean_cores, 'server_rss_mb': sum(rss) / len(rss) / 2**20 if rss else None,
               'cpu_ms_per_success': mean_cores * 1000 / success_rps if mean_cores and success_rps else None,
               'writes_without_success_response': reconciliation.get('writes_without_success_response'),
               'pcn_load_status': report.get('load_status')}
    if late_from is not None:
        metrics['late'] = late
    metrics.update(extension)
    return metrics


# ---- member evidence of the v2 study (pure given the files of a member; tested offline) ------------------------------------------------
GENERATOR_MAX = 0.80        # a member whose Locust generator needs more than this many cores measures the generator, not the product
GENERATOR_SHIFT = 0.70      # K10: a first member at the highest step above this moves the step from 800 to 600 users
RATE_429_MAX = 0.01         # a step with more than 1% of 429 responses measured the limiter: not readable
NODE_HOT = 0.85             # a Node API process at or above this many cores is saturated (K4)
POOL_FULL_SHARE = 0.5       # K4: every Prisma connection of an API process busy in at least half of the samples
IMBALANCE = 0.20            # the busier of two instances uses more than 20% more CPU than the other: the balancing is not even
BEFORE_START, AFTER_LENGTH = 30, 60   # read p95 is cut around the burst at second `at`: [30, at) before it and (at, at+60] after it ([30,120) and (120,180] for a burst at 120)
COMPONENT_GROUPS = (('core', re.compile(r'core(-\d+)?')), ('clinic', re.compile(r'clinic-\d+')),
                    ('notification_worker', re.compile(r'notification-worker(-\d+)?')))
API_PROCESS = re.compile(r'core(-\d+)?|clinic-\d+|notification|api')   # the Node processes that answer requests (api: the monolith)
API_DATABASE_APP = re.compile(r'p8-(core(-\d+)?|clinic-\d+|notification)')   # application_name of their connections


def mean_of(values):
    """Arithmetic mean; None when there is nothing to average or a value is missing."""
    values = list(values)
    return sum(values) / len(values) if values and all(v is not None for v in values) else None


def component_group(name):
    """core, core-0, core-1 -> core; clinic-0, clinic-1 -> clinic; notification-worker(-N) -> notification_worker; anything else (postgres, nginx, core-outbox ...) is its own group."""
    for group, pattern in COMPONENT_GROUPS:
        if pattern.fullmatch(name):
            return group
    return name


def component_groups(components):
    """Cores per group from cores per process."""
    groups = {}
    for name, cores in components.items():
        groups[component_group(name)] = groups.get(component_group(name), 0.0) + cores
    return groups


def segment_p95(rows, name_prefix, low, high, closed_high=False):
    """Nearest-rank p95 of the response times of requests whose name starts with name_prefix and that started in [low, high) of the window ((low, high] with closed_high); {'n', 'p95_ms'}."""
    values = [r['response_time_ms'] for r in rows if r['name'].startswith(name_prefix)
              and (low < r['started_seconds'] <= high if closed_high else low <= r['started_seconds'] < high)]
    return {'n': len(values), 'p95_ms': percentile(values, 95)}


def pool_evidence(manifest):
    """What the member's manifest says about the Prisma pool: the share of samples with every connection busy per API process (pg_stat_activity, K4), the P2024 count (a lower
    bound: the services log none) and the 503 count (the signal that does not depend on logs)."""
    activity = manifest.get('pg_activity') or {}
    available = activity.get('status') == 'COMPLETE'
    shares = {name: entry['at_pool_limit_share'] for name, entry in (activity.get('applications') or {}).items()
              if API_DATABASE_APP.fullmatch(name) and 'at_pool_limit_share' in entry} if available else {}
    timeouts = manifest.get('pool_timeouts') or {}
    return {'available': available, 'status': activity.get('status'), 'at_pool_limit_share': shares,
            'p2024_log_lines': timeouts.get('p2024_log_lines'), 'http_503': timeouts.get('http_503')}


def expectation_reasons(manifest, config):
    """Why the manifest of a member is not the configuration asked for (K9: topology, instances, layout, pool, workers), from what run_pcn recorded and ready.json.gateway."""
    if config == 'M':
        return [] if manifest.get('configuration') == 'M' else [f"manifest configuration is {manifest.get('configuration')!r}, expected 'M'"]
    want, gateway, reasons = VM2_CONFIGS[config], manifest.get('gateway') or {}, []
    seen = (('core replicas', manifest.get('core_replicas'), want['core']), ('clinic replicas', manifest.get('clinic_replicas'), want['clinic']),
            ('notification workers', manifest.get('notification_workers'), want['nw']), ('gateway topology', manifest.get('gateway_topology'), want['topology']),
            ('gateway.topology', gateway.get('topology'), want['topology']), ('gateway.coreLayout', gateway.get('coreLayout'), want['layout']),
            ('gateway.dbPoolLimit', gateway.get('dbPoolLimit'), want['pool']), ('gateway core instances', len(gateway.get('coreInstances') or []), want['core']),
            ('gateway clinic upstream servers', (gateway.get('clinicUpstream') or {}).get('servers'), want['clinic']))
    if not gateway:
        reasons.append('manifest has no gateway block')
    reasons.extend(f'{field} is {got!r}, expected {expected!r}' for field, got, expected in seen if got != expected)
    return reasons


def v2_extension(directory, settings, manifest, rows, series, generator, require_cpu, v2, reasons):
    """The metrics the v2 study adds to member_metrics; appends to `reasons` what makes the member invalid."""
    config, at = v2['config'], v2.get('burst_at', 120)
    reads = [r['response_time_ms'] for r in rows if r['name'].startswith('GET ')]
    components = {name: sum(values) / len(values) for name, values in sorted(series.items())}
    generator_cores = sum(generator) / len(generator) if generator else None
    if require_cpu:
        if generator_cores is None:
            reasons.append('no generator CPU samples')
        elif generator_cores > GENERATOR_MAX:
            reasons.append(f'generator above {GENERATOR_MAX:.2f} core ({generator_cores:.2f})')
    http_path = Path(directory) / 'http-summary.json'
    http = json.loads(http_path.read_text(encoding='utf-8')) if http_path.is_file() else None
    if http is None:
        reasons.append('http-summary.json missing')
    else:
        http = {**http, 'rate_429': http['http_429'] / http['requests'] if http['requests'] else 0.0,
                'rate_503': http['http_503'] / http['requests'] if http['requests'] else 0.0}
    reasons.extend(expectation_reasons(manifest, config))
    if v2.get('pg_sampler') and not manifest.get('pg_sampler'):
        reasons.append('the pg_stat_activity sampler was asked for and the manifest does not record it')
    burst = None
    if v2.get('burst'):
        burst_path = Path(directory) / 'burst.json'
        burst = json.loads(burst_path.read_text(encoding='utf-8')) if burst_path.is_file() else None
        if burst is None:
            reasons.append('burst.json missing')
        elif not burst.get('valid'):
            reasons.append('burst: ' + ('; '.join(burst.get('reasons') or []) or str(burst.get('status'))))
    elif (Path(directory) / 'burst.json').is_file():
        reasons.append('burst.json present although no burst was asked for')
    return {'config': config, 'read_requests': len(reads), 'read_p95_ms': percentile(reads, 95),
            'read_p95_segments': {'before': segment_p95(rows, 'GET ', BEFORE_START, at), 'after': segment_p95(rows, 'GET ', at, at + AFTER_LENGTH, closed_high=True)},
            'generator_cores': generator_cores, 'components': components, 'groups': component_groups(components), 'http': http,
            'pool': pool_evidence(manifest), 'outbox': manifest.get('outbox'), 'gateway': manifest.get('gateway'), 'burst': burst}


def band(ratio, subject='H'):
    if ratio is None:
        return None
    return f'{subject} nhanh hơn' if ratio <= BANDS[0] else f'{subject} chậm hơn' if ratio >= BANDS[1] else 'tương đương'


def balanced(pairs, value):
    """Geometric mean of H/M over the ABBA pairs; None if any side is missing."""
    ratios = []
    for m, h in pairs:
        a, b = value(m), value(h)
        if not a or b is None or b <= 0:
            return None, []
        ratios.append(b / a)
    return math.exp(sum(math.log(r) for r in ratios) / len(ratios)), ratios


def compare(members):
    """members: metrics in run order, configurations ORDER."""
    if len(members) != len(ORDER):
        return {'decision': 'NOT_RUN'}
    invalid = [f'{i}:{c}: ' + ', '.join(m['reasons']) for i, (c, m) in enumerate(zip(ORDER, members)) if not m['valid']]
    if invalid:
        return {'decision': 'INVALID', 'invalid': invalid}
    pairs = [(members[0], members[1]), (members[3], members[2])]
    operations = {}
    for name in sorted(members[0]['operations']):
        if not all(name in m['operations'] for m in members):
            return {'decision': 'INVALID', 'invalid': ['operation missing: ' + name]}
        p95, p95_pairs = balanced(pairs, lambda m: m['operations'][name]['p95_ms'])
        p50, _ = balanced(pairs, lambda m: m['operations'][name]['p50_ms'])
        size, _ = balanced(pairs, lambda m: m['operations'][name]['mean_response_bytes'])
        operations[name] = {'p95_ratio': p95, 'p95_pair_ratios': p95_pairs, 'p50_ratio': p50,
                            'response_bytes_ratio': size, 'reading': band(p95),
                            'p95_ms': {'M': [m['operations'][name]['p95_ms'] for m in (members[0], members[3])],
                                       'H': [m['operations'][name]['p95_ms'] for m in (members[1], members[2])]}}
    overall = {key: balanced(pairs, lambda m, k=key: m[k])[0]
               for key in ('p50_ms', 'p95_ms', 'success_rps', 'server_cores', 'cpu_ms_per_success', 'server_rss_mb')}
    return {'decision': 'COMPARED', 'order': list(ORDER), 'bands': list(BANDS), 'operations': operations,
            'overall_ratios_H_over_M': overall, 'overall_p95_reading': band(overall['p95_ms']),
            'cpu_per_success_reading': band(overall['cpu_ms_per_success']),
            'note': 'Order-balanced geometric mean of the pairs (M1,H2) and (M4,H3). One session, two pairs: '
                    'a descriptive comparison, not a capacity or equal-budget acceptance.'}


# ---- VM study (pure parts; tested offline) -------------------------------------
def vm_member_plan(configuration):
    """(source tree, Core instances) of a VM-study configuration."""
    plan = VM_CONFIGS[configuration]
    return plan['tree'], plan.get('core', 1)


def parse_cpu_list(text):
    """'0,4-5' -> {0, 4, 5} (the kernel's cpulist format, e.g. topology/thread_siblings_list)."""
    cpus = set()
    for part in text.strip().split(','):
        if part:
            low, _, high = part.partition('-')
            cpus.update(range(int(low), int(high or low) + 1))
    return cpus


def plan_pinning(cpus, siblings=None):
    """Locust generator and controller on the lowest CPU; every server process on the others, except the SMT sibling(s) of the
    generator CPU (siblings: the kernel's thread_siblings_list text of that CPU), which stay idle so no server shares its core."""
    cpus = sorted(cpus)
    generator = cpus[:1]
    twins = sorted((parse_cpu_list(siblings) if siblings else set()) & (set(cpus) - set(generator)))
    server = [c for c in cpus[1:] if c not in twins]
    if len(cpus) < 2:
        raise RuntimeError(f'VM_NEEDS_2_CPUS: found {len(cpus)} usable CPU(s), the generator and the servers need one each')
    if not server:
        raise RuntimeError(f'VM_NO_SERVER_CPU_AFTER_SMT_EXCLUSION: CPU {generator[0]} is the generator and its SMT sibling(s) {twins} '
                           f'(thread_siblings_list {siblings.strip()!r}) are left idle, which leaves no CPU of {cpus} for the servers')
    return {'generator': generator, 'server': server, 'smt_siblings_left_idle': twins,
            'thread_siblings_list': siblings.strip() if siblings else None}


def pair_indices(order, base, other):
    """(base, other) positions of a balanced order: the k-th occurrence of base with the k-th occurrence of other.

    Balanced means a palindrome in which every configuration appears exactly twice (M,H0,H1,H2,H2,H1,H0,M; M,H3,H3x2,H3x2,H3,M; the ten members of the highest step of the VM v2 study).
    The two pairs are then mirror images about the middle of the order: base at a and other at b, and base at n-1-a and other at n-1-b (n members). A drift that multiplies each
    position by the same factor per position cancels exactly in the geometric mean of the two ratios, whether the members of a pair are adjacent or two places apart. Any other order is refused."""
    order = tuple(order)
    if order != order[::-1] or any(order.count(c) != 2 for c in order) or base == other or base not in order or other not in order:
        raise ValueError('BRIDGE_ORDER_NOT_BALANCED')
    first = [i for i, c in enumerate(order) if c == base]
    second = [i for i, c in enumerate(order) if c == other]
    return list(zip(first, second))


def compare_vm(members):
    """members: metrics in run order, VM_ORDER. H0/M, H1/H0 and H2/H1, each the geometric mean of its forward and reverse pair."""
    if len(members) != len(VM_ORDER):
        return {'decision': 'NOT_RUN'}
    invalid = [f'{i}:{c}: ' + ', '.join(m['reasons']) for i, (c, m) in enumerate(zip(VM_ORDER, members)) if not m['valid']]
    if invalid:
        return {'decision': 'INVALID', 'invalid': invalid}
    names = sorted(members[0]['operations'])
    for name in names:
        if not all(name in m['operations'] for m in members):
            return {'decision': 'INVALID', 'invalid': ['operation missing: ' + name]}
    comparisons = {}
    for label, base, other in VM_COMPARISONS:
        positions = pair_indices(VM_ORDER, base, other)
        pairs = [(members[a], members[b]) for a, b in positions]
        operations = {}
        for name in names:
            p95, p95_pairs = balanced(pairs, lambda m: m['operations'][name]['p95_ms'])
            operations[name] = {'p95_ratio': p95, 'p95_pair_ratios': p95_pairs,
                                'p50_ratio': balanced(pairs, lambda m: m['operations'][name]['p50_ms'])[0],
                                'response_bytes_ratio': balanced(pairs, lambda m: m['operations'][name]['mean_response_bytes'])[0],
                                'reading': band(p95, other),
                                'p95_ms': {'base': [a['operations'][name]['p95_ms'] for a, _ in pairs],
                                           'other': [b['operations'][name]['p95_ms'] for _, b in pairs]}}
        overall = {key: balanced(pairs, lambda m, k=key: m[k])[0]
                   for key in ('p50_ms', 'p95_ms', 'success_rps', 'server_cores', 'cpu_ms_per_success', 'server_rss_mb')}
        entry = {'base': base, 'other': other, 'positions': [list(p) for p in positions], 'operations': operations,
                 'overall_ratios': overall, 'overall_p95_reading': band(overall['p95_ms'], other),
                 'cpu_per_success_reading': band(overall['cpu_ms_per_success'], other)}
        if all(m.get('late') for m in members):
            entry['exploratory_late'] = {
                'label': 'EXPLORATORY, not a gate: requests started from second %d of the window, CPU over the same part' % LATE_FROM,
                'from_seconds': LATE_FROM,
                'overall_ratios': {key: balanced(pairs, lambda m, k=key: m['late'][k])[0]
                                   for key in ('p50_ms', 'p95_ms', 'success_rps', 'server_cores', 'cpu_ms_per_success')},
                'p95_ratios': {name: balanced(pairs, lambda m: (m['late']['operations'].get(name) or {}).get('p95_ms'))[0] for name in names}}
        comparisons[label] = entry
    return {'decision': 'COMPARED', 'order': list(VM_ORDER), 'bands': list(BANDS), 'comparisons': comparisons,
            'note': 'Each ratio is the order-balanced geometric mean of the forward and the reverse adjacent pair (compared/baseline); '
                    'a multiplicative drift with the same factor per position cancels exactly, other drift shapes only to first order. '
                    'One VM session, two pairs per ratio: a descriptive comparison, not a capacity or equal-budget acceptance. '
                    'H0/M is the figure to set beside Kaggle v1 (4.96); the VM and Kaggle numbers are never divided by each other.'}


# ---- Kaggle session ------------------------------------------------------------
class Study:
    study_name, order, smoke_order = STUDY, ORDER, ('M', 'H')

    def __init__(self, m_root, h_root, private, output, run, *, mode, progress=print):
        if mode not in ('smoke', 'full', 'local'):
            raise ValueError('BRIDGE_MODE')
        self.m_root, self.h_root = Path(m_root), Path(h_root)
        self.private, self.output, self.run, self.mode, self.progress = Path(private), Path(output), run, mode, progress
        self.kaggle = platform.system() == 'Linux' and Path('/kaggle/working').is_dir()
        self.stages = []

    def command(self, args, cwd=None, timeout=1800, env=None):
        with (self.private / 'commands.log').open('a') as log:
            result = subprocess.run(args, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, timeout=timeout, env=env)
        if result.returncode:
            raise RuntimeError('BRIDGE_SETUP_COMMAND_FAILED: ' + ' '.join(args[:3]))

    def capture(self, args):
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            return 'unavailable'
        return ((result.stdout or '') + (result.stderr or '')).strip().split('\n')[0] if result.returncode == 0 else 'unavailable'

    def prerequisites(self):
        if platform.system() != 'Linux' or os.geteuid() != 0:
            raise RuntimeError('LINUX_ROOT_REQUIRED')
        policy_rc = Path('/usr/sbin/policy-rc.d'); created = not policy_rc.exists()
        if created:
            policy_rc.write_text('#!/bin/sh\nexit 101\n'); policy_rc.chmod(0o755)
        try:
            self.command(['apt-get', 'update', '-qq'])
            self.command(['apt-get', 'install', '-y', '-qq', '--no-install-recommends', *APT],
                         env={**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'})
        finally:
            if created and policy_rc.read_text() == '#!/bin/sh\nexit 101\n':
                policy_rc.unlink()
        if self.capture(['node', '--version']) != NODE:
            arch = {'x86_64': 'x64', 'aarch64': 'arm64'}[platform.machine()]
            name, origin = f'node-{NODE}-linux-{arch}.tar.xz', f'https://nodejs.org/dist/{NODE}/'
            sums = urllib.request.urlopen(origin + 'SHASUMS256.txt', timeout=30).read().decode()
            expected = next(row.split()[0] for row in sums.splitlines() if row.split()[-1] == name)
            archive = self.private / name
            urllib.request.urlretrieve(origin + name, archive)
            if digest(archive.read_bytes()) != expected:
                raise RuntimeError('NODE_ARCHIVE_DIGEST_MISMATCH')
            self.command(['tar', '-xJf', str(archive), '-C', str(self.private)])
            os.environ['PATH'] = str(self.private / name.removesuffix('.tar.xz') / 'bin') + ':' + os.environ['PATH']
        if self.capture(['node', '--version']) != NODE:
            raise RuntimeError('NODE_VERSION_MISMATCH')
        self.command([sys.executable, '-m', 'pip', 'install', '-q', '--no-cache-dir', *PIP])

    def build(self):
        self.command(['npm', 'ci', '--no-audit', '--no-fund'], cwd=self.m_root)
        self.command(['npm', 'run', 'build', '-w', 'backend'], cwd=self.m_root)
        self.command(['npm', 'ci', '--no-audit', '--no-fund'], cwd=self.h_root)
        self.command(['npm', 'run', 'phase2:build'], cwd=self.h_root)

    def versions(self):
        pg_bin = self.capture(['pg_config', '--bindir'])
        dpkg = lambda p: self.capture(['dpkg-query', '-W', '-f=${Version}', p])
        cpu = next((line.split(':', 1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines()
                    if line.startswith('model name')), platform.processor())
        cgroup = {n: (Path('/sys/fs/cgroup') / n).read_text().strip() for n in ('cpu.max', 'memory.max') if (Path('/sys/fs/cgroup') / n).is_file()}
        return {'node': self.capture(['node', '--version']), 'npm': self.capture(['npm', '--version']),
                'postgres': self.capture([pg_bin + '/postgres', '--version']), 'redis': self.capture(['redis-server', '--version']),
                'nginx': self.capture(['nginx', '-v']), 'rabbitmq': dpkg('rabbitmq-server'), 'python': platform.python_version(),
                'kernel': platform.release(), 'cpuModel': cpu, 'logicalCpus': os.cpu_count(), 'affinity': sorted(os.sched_getaffinity(0)),
                'memTotal': next((l for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemTotal')), None), **cgroup}

    def member(self, index, configuration, settings, label):
        from bridge_monolith import run_monolith
        from pcn_runner import run_pcn
        directory = self.private / 'members' / f'{label}-{index}-{configuration}'
        directory.parent.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        say = lambda text: self.progress(f'[{label} {index} {configuration}] {text}')
        if configuration == 'M':
            run_monolith(self.m_root, self.h_root, directory, settings=settings, locustfile=LOCUSTFILE,
                         progress=say, kaggle=self.kaggle and label == 'full')
        else:
            run_pcn(self.h_root, directory, mode='full' if self.kaggle and label == 'full' else 'smoke',
                    settings=settings, locustfile=LOCUSTFILE, service_env=H_LIMITS, progress=say)
        self.stages.append({'stage': f'{label}-{index}-{configuration}', 'seconds': round(time.monotonic() - started, 1)})
        return directory

    def compare(self, members):
        return compare(members)

    def metrics(self, directory, settings, require_cpu=True):
        return member_metrics(directory, settings, require_cpu=require_cpu)

    def before_members(self):
        """Hook between the environment record and the first member (the VM study pins CPUs here)."""

    def annotate(self, result):
        """Hook for study-specific evidence in evaluation.json."""

    def smoke_members(self):
        """The metrics of the smoke members, in smoke_order (their directories stay under members/ for the export)."""
        return [self.metrics(self.member(i, c, SMOKE, 'smoke'), SMOKE, require_cpu=False) for i, c in enumerate(self.smoke_order)]

    def measure(self, result):
        """The measured members of the study and their comparison, into `result` (v1: the balanced order, each member checked before the next)."""
        settings = FULL if self.mode == 'full' else {**FULL, 'seconds': 60, 'warmup': 10}
        members = []
        for i, c in enumerate(self.order):
            members.append(self.metrics(self.member(i, c, settings, 'full'), settings))
            if not members[-1]['valid']:
                break  # an invalid member already makes the comparison INVALID; save the session time
        result['members'] = [{'configuration': c, **m} for c, m in zip(self.order, members)]
        result['comparison'] = self.compare(members) if len(members) == len(self.order) else {
            'decision': 'INVALID', 'invalid': [f'{len(members) - 1}:{self.order[len(members) - 1]}: ' + ', '.join(members[-1]['reasons'])]}
        result['settings'] = settings
        result['status'] = 'COMPLETE'

    def execute(self, install=True):
        reports = self.private / 'reports'
        reports.mkdir(parents=True, exist_ok=True)
        result = {'study': self.study_name, 'run': self.run, 'mode': self.mode, 'status': 'RUNNING'}
        try:
            if install:
                self.timed('prerequisites', self.prerequisites)
            self.timed('build', self.build)
            write_json(reports / 'environment.json', self.versions())
            self.before_members()
            smoke = self.smoke_members()
            result['smoke'] = [{'configuration': c, 'valid': m['valid'], 'reasons': m['reasons']} for c, m in zip(self.smoke_order, smoke)]
            if not all(m['valid'] for m in smoke):
                result.update(status='SMOKE_FAILED', comparison={'decision': 'NOT_RUN'})
            elif self.mode == 'smoke':
                result.update(status='SMOKE_PASSED', comparison={'decision': 'NOT_RUN'})
            else:
                self.measure(result)
        except Exception as error:
            result.update(status='FAILED', error_type=type(error).__name__, error=str(error)[:200])
        result['stages'] = self.stages
        self.annotate(result)
        write_json(reports / 'evaluation.json', result)
        result['download'] = str(self.export())
        return result

    def timed(self, name, action):
        started = time.monotonic()
        self.progress(f'{name}...')
        action()
        self.stages.append({'stage': name, 'seconds': round(time.monotonic() - started, 1)})

    def exported(self):
        """(source, archive name) of everything that leaves the machine: aggregate evidence, never logs or tokens."""
        for path in sorted((self.private / 'reports').glob('*.json')):
            yield path, 'reports/' + path.name
        for member in sorted((self.private / 'members').glob('*')) if (self.private / 'members').is_dir() else []:
            for name in EXPORT:
                if (member / name).is_file():
                    yield member / name, f'members/{member.name}/{name}'
        for path in sorted((self.h_root.parent).glob('bundle-manifest.json')):
            yield path, 'bundle-manifest.json'

    def export(self):
        target = self.output.with_suffix('.zip')
        with zipfile.ZipFile(target, 'x', zipfile.ZIP_DEFLATED) as archive:
            for source, name in self.exported():
                archive.write(source, name)
        return target


def run_study(m_root, h_root, private, output, run, *, mode, progress=print, install=True):
    return Study(m_root, h_root, private, output, run, mode=mode, progress=progress).execute(install=install)


# ---- plain Ubuntu VM (bridge-m-h-vm-v1) -----------------------------------------
class VmStudy(Study):
    """Same members and evidence as Study, outside Kaggle: three source trees (M, H0, H1), H2 = H1 with two Core instances,
    generator and controller pinned to their own CPU and servers to the others, results written as a directory (vm_run.sh packs it)."""
    study_name, order, smoke_order = VM_STUDY, VM_ORDER, VM_SMOKE_ORDER

    def __init__(self, root, private, output, run, *, mode, progress=print):
        root = Path(root)
        super().__init__(root / 'M', root / 'H1', private, output, run, mode=mode, progress=progress)
        self.trees = {name: root / name for name in ('M', 'H0', 'H1')}
        self.kaggle, self.pinning = False, None

    def build(self):
        for name in ('M', 'H0', 'H1'):
            self.command(['npm', 'ci', '--no-audit', '--no-fund'], cwd=self.trees[name])
            self.command(['npm', 'run', 'build', '-w', 'backend'] if name == 'M' else ['npm', 'run', 'phase2:build'], cwd=self.trees[name])

    def versions(self):
        release = next((l.split('=', 1)[1].strip('"') for l in Path('/etc/os-release').read_text().splitlines() if l.startswith('PRETTY_NAME=')), None)
        return {**super().versions(), 'study': VM_STUDY, 'os': release, 'taskset': self.capture(['taskset', '--version']),
                'virtualization': self.capture(['systemd-detect-virt']), 'loadavg': os.getloadavg()}

    def before_members(self):
        if not shutil.which('taskset'):
            raise RuntimeError('TASKSET_MISSING')
        cpus = sorted(os.sched_getaffinity(0))
        topology = Path(f'/sys/devices/system/cpu/cpu{cpus[0]}/topology/thread_siblings_list')
        self.pinning = plan_pinning(cpus, topology.read_text() if topology.is_file() else None)
        # The controller (setup calls, sampler) sits on the generator CPU; the servers are started under taskset on the server CPUs
        # (NativeStack, Monolith) and the generator under taskset on its own CPU (pcn_runner.taskset_prefix).
        os.sched_setaffinity(0, self.pinning['generator'])

    def metrics(self, directory, settings, require_cpu=True):
        return member_metrics(directory, settings, require_cpu=require_cpu, late_from=LATE_FROM)

    def compare(self, members):
        return compare_vm(members)

    def member(self, index, configuration, settings, label):
        from bridge_monolith import run_monolith
        from pcn_runner import run_pcn
        tree, core = vm_member_plan(configuration)
        directory = self.private / 'members' / f'{label}-{index}-{configuration}'
        directory.parent.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        say = lambda text: self.progress(f'[{label} {index} {configuration}] {text}')
        if configuration == 'M':
            run_monolith(self.trees['M'], self.trees['H1'], directory, settings=settings, locustfile=LOCUSTFILE,
                         progress=say, pinning=self.pinning)
        else:
            run_pcn(self.trees[tree], directory, mode='full' if label == 'full' else 'smoke', settings=settings, locustfile=LOCUSTFILE,
                    service_env=H_LIMITS, core_replicas=core, core_proxy=True, pinning=self.pinning, vm=True, progress=say)
        self.stages.append({'stage': f'{label}-{index}-{configuration}', 'seconds': round(time.monotonic() - started, 1)})
        return directory

    def annotate(self, result):
        bundle = self.h_root.parent / 'bundle-manifest.json'
        sources = json.loads(bundle.read_text(encoding='utf-8')) if bundle.is_file() else {}
        result['vm'] = {'configurations': VM_CONFIGS, 'order': list(VM_ORDER), 'pinning': self.pinning, 'harnessChanges': list(VM_HARNESS_CHANGES),
                        'sources': {key: sources.get(key) for key in ('mCommit', 'h0Commit', 'h1Commit', 'harnessFromWorktree', 'treeSha256')}}

    def export(self):
        self.output.mkdir(parents=True, exist_ok=True)
        for source, name in self.exported():
            target = self.output / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        return self.output


def run_vm_study(root, private, output, run, *, mode, progress=print, install=True):
    return VmStudy(root, private, output, run, mode=mode, progress=progress).execute(install=install)


# ---- bridge-m-h-vm-v2 (K9): configurations, plan, time estimate -------------------------------------------------------------------------
VM2_STUDY = 'bridge-m-h-vm-v2'
VM2_GROUPS = ('M', 'H1', 'H3')


def h_config(tree, **axes):
    """Axes of an H configuration: Core and Clinic API instances, Prisma pool (DB_POOL_LIMIT), gateway topology, Core worker layout of the tree (H1 phase2, H3 workers)
    and Notification workers on the one queue; `burst` marks the members that fire a notification burst."""
    return {'tree': tree, 'core': 1, 'clinic': 1, 'pool': 4, 'topology': 'direct', 'layout': 'phase2' if tree == 'H1' else 'workers', 'nw': 1, **axes}


# H1: the commit v1 measured (2841d1b) under the standard topology; H3: HEAD. Every H configuration reaches Core through the nginx upstream (core_proxy).
VM2_CONFIGS = {
    'M': {'tree': 'M'},
    'H1': h_config('H1'),
    'H3': h_config('H3'),
    'H3c': h_config('H3', topology='core-ingress'),   # gateway -> Core -> Clinic: an upper bound of the price at compose (K11)
    'H3x2': h_config('H3', core=2),
    'H3p8': h_config('H3', pool=8),
    'H3cl2': h_config('H3', clinic=2),
    'H3x2cl2': h_config('H3', core=2, clinic=2),
    'H3b': h_config('H3', burst=True),
    'H3bnw2': h_config('H3', burst=True, nw=2),
}
# Every order is a palindrome with each configuration twice (pair_indices).
PART1_ORDER = ('M', 'H1', 'H3', 'H3c', 'H3c', 'H3', 'H1', 'M')
BURST_ORDER = ('H3b', 'H3bnw2', 'H3bnw2', 'H3b')
TIER_ORDER = ('M', 'H3', 'H3x2', 'H3x2', 'H3', 'M')
TOP_ORDER = ('M', 'H3', 'H3cl2', 'H3x2', 'H3x2cl2', 'H3x2cl2', 'H3x2', 'H3cl2', 'H3', 'M')
POOL_ORDER = ('H3', 'H3p8', 'H3p8', 'H3')
VM2_SMOKE_ORDER = ('M', 'H1', 'H3', 'H3c', 'H3x2', 'H3p8', 'H3x2cl2', 'H3bnw2')
STEPS = (200, 400, 800)   # the users of Part 2; the highest one is TOP_FALLBACK when the generator is too busy at the first member (K10)
TOP_FALLBACK = 600
BURST_FULL, BURST_SMOKE, BURST_LOCAL = {'count': 6000, 'at_s': 120}, {'count': 200, 'at_s': 5}, {'count': 2000, 'at_s': 20}
LOCAL_WINDOW = {'seconds': 60, 'warmup': 10}
# What the study calls saturated (design section 5): throughput that grows by less than 1.5x when the users double, a read p95 above 750 ms (QS-10), errors above 1%.
SATURATION_GROWTH, SATURATION_READ_P95_MS, SATURATION_ERROR = 1.5, 750.0, 0.01
SATURATION_CONFIGS = ('M', 'H3', 'H3x2')   # H3x2 has no 100-user point (K6): its first step has no growth sign
RATIO_KEYS = ('success_rps', 'read_p95_ms', 'p95_ms', 'p50_ms', 'cpu_ms_per_success', 'server_cores', 'server_rss_mb')
# (label, baseline, compared): each ratio is compared/baseline.
PART1_COMPARISONS = (('H3/H1', 'H1', 'H3'), ('H3c/H3', 'H3', 'H3c'), ('H3/M', 'M', 'H3'), ('H1/M', 'M', 'H1'))
TIER_COMPARISONS = (('H3x2/H3', 'H3', 'H3x2'), ('H3/M', 'M', 'H3'))
SCALE_OUT_COMPARISONS = (('H3cl2/H3', 'H3', 'H3cl2'), ('H3x2/H3', 'H3', 'H3x2'), ('H3x2cl2/H3x2', 'H3x2', 'H3x2cl2'),
                         ('H3x2cl2/H3cl2', 'H3cl2', 'H3x2cl2'), ('H3x2cl2/H3', 'H3', 'H3x2cl2'), ('H3/M', 'M', 'H3'))
POOL_COMPARISONS = (('H3p8/H3', 'H3', 'H3p8'),)
BURST_COMPARISON = ('H3bnw2/H3b', 'H3b', 'H3bnw2')
# The estimate of the time the VM is on (calibrated on the design: about 3.5 h for the 26 measured members of the plan without the scale-out and burst blocks, +32 min for the
# four members added to the highest step, +30 for the burst block, +5 and +15 for the smoke and the dry run; the v1 handoff gives 20-30 min of setup).
SETUP_MIN, MEMBER_OVERHEAD_MIN, DRAIN_S, BURST_WAIT_MIN = 25.0, 2.0, 15, 0.5
VM2_HARNESS_CHANGES = (
    'stack.mjs has two gateway topologies, `direct` (appointments, medical-records and dashboard/clinic to Clinic, notifications to Notification, the rest to Core: the topology of '
    'deploy/phase2/nginx.split.conf.example) and `core-ingress` (every /api path to Core). H1 and H3 run `direct`, H3c runs `core-ingress`. Compared with v1 the difference is only '
    '/api/dashboard/clinic, which the PCN load never calls. nginx runs with worker_connections 4096 and worker_rlimit_nofile 8192 in both.',
    'The Core worker layout is a property of the tree: H1 (2841d1b) has backend/dist/src/phase2/{notificationWorker,billingWorker}.js, H3 has backend/dist/src/workers; stack.mjs builds '
    'exactly the layout the member names (context.coreLayout) and records it in ready.json.gateway.',
    'Every service gets the same DB_POOL_LIMIT (4, or 8 in H3p8) and names its database connections with application_name p8-<process> (m-api for the monolith); a psql \\watch 0.2 sampler of '
    'pg_stat_activity runs in Part 2 and in the pool block only, and costs the servers a little.',
    'The fixture takes up to 800 owners; Part 1 keeps the v1 settings (100 users, 300 s window, 30 s warmup, spawn rate 10) and Part 2 uses spawn rate users/10.',
    'Clinic runs one or two API instances behind `upstream clinic`; with Core proxied no upstream server is put aside (max_fails=0) and no location retries on another instance '
    '(proxy_next_upstream off), for Core and for Clinic alike, so a second instance changes capacity and not the error policy. clinic-worker, the Notification API, core-outbox and '
    'billing-worker stay at one.',
    'The Notification worker runs once or twice on the one queue (prefetch 1 each, inbox idempotent), and a notification burst of N notification.requested.v1 events is written into '
    'the Clinic outbox in one transaction at a set second of the window, sampled every second until the Notification inbox holds them all (burst.json).',
    'The harness files of the three trees (M, H1, H3) are the same bytes, taken from the harness commit, so H1 runs 2841d1b product code with today\'s harness.',
    'Pinning, as in v1: generator and controller on the lowest CPU, every server process under taskset on the other CPUs.')


def load_settings(users, window=None):
    """The settings of a step: the v1 window (FULL, or `window` over it) with `users` and the spawn rate users/10 (K7), which for 100 users is FULL itself."""
    return {**FULL, **(window or {}), 'users': users, 'spawn_rate': max(1, users // 10)}


def block_spec(kind, users, order, *, window=None, burst=None, pg_sampler=False, errors_invalidate=False, top=False):
    """One block of members run back to back: part1, burst, tier (Part 2), pool or probe (a dry-run member that is not paired). `errors_invalidate`: more than 1% of errors
    makes a member invalid (Part 1 and the burst block, where 100 users must not saturate); in Part 2 and the pool block it is a sign of saturation. `top`: the highest step,
    whose first member decides between 800 and TOP_FALLBACK users."""
    return {'name': f'{kind}-{users}' if kind != 'part1' and kind != 'burst' else kind, 'kind': kind, 'users': users, 'order': tuple(order),
            'settings': load_settings(users, window), 'burst': burst, 'pg_sampler': pg_sampler, 'errors_invalidate': errors_invalidate, 'top': top}


def top_block(users, window=None):
    return block_spec('tier', users, TOP_ORDER, window=window, pg_sampler=True, top=users == STEPS[-1])


def pool_block(users, window=None):
    return block_spec('pool', users, POOL_ORDER, window=window, pg_sampler=True)


CUTS = ('x2-200', 'burst-short')   # S9: what to cut when the VM time would pass 6 h, in this order (about -16 and -8 min)


def burst_moment(cuts=()):
    """The second of the window the full-run burst fires at: 120, or 60 with the burst-short cut."""
    return 60 if 'burst-short' in cuts else BURST_FULL['at_s']


def vm2_blocks(mode, cuts=()):
    """The blocks of a mode that are known before the run (the pool block is added during it). full: Part 1, the burst block, the steps of Part 2. local: a dry run of every kind of
    block at reduced size, 60 s windows (the figures are not results): the 200-user step, the highest step's new member H3x2cl2 alone, and one member of each burst configuration.
    cuts (S9, only for full): 'x2-200' drops the H3x2 pair of the 200-user step (M,H3,H3,M), 'burst-short' makes the burst block a 180 s window with the burst at second 60."""
    if cuts and (mode != 'full' or any(c not in CUTS for c in cuts)):
        raise ValueError(f'cuts {CUTS} only for the full mode, got {cuts!r} for {mode}')
    if mode == 'full':
        short = 'burst-short' in cuts
        return [block_spec('part1', 100, PART1_ORDER, errors_invalidate=True),
                block_spec('burst', 100, BURST_ORDER, window={'seconds': 180} if short else None, burst={'count': BURST_FULL['count'], 'at_s': burst_moment(cuts)}, errors_invalidate=True),
                block_spec('tier', STEPS[0], ('M', 'H3', 'H3', 'M') if 'x2-200' in cuts else TIER_ORDER, pg_sampler=True),
                *[block_spec('tier', users, TIER_ORDER, pg_sampler=True) for users in STEPS[1:-1]], top_block(STEPS[-1])]
    if mode == 'local':
        return [block_spec('tier', STEPS[0], TIER_ORDER, window=LOCAL_WINDOW, pg_sampler=True),
                block_spec('probe', STEPS[-1], ('H3x2cl2',), window=LOCAL_WINDOW, pg_sampler=True, top=True),
                block_spec('probe', 100, ('H3b', 'H3bnw2'), window=LOCAL_WINDOW, burst=BURST_LOCAL, errors_invalidate=True)]
    return []


def member_name(index, users, config):
    """full-<index>-<users>-<configuration>: the directory of a measured member under members/."""
    return f'full-{index}-{users}-{config}'


def member_minutes(settings, burst=False):
    """Minutes one member takes: stack start and teardown, ramp, warmup, window and the 15 s drain, and the wait for a burst to drain."""
    return MEMBER_OVERHEAD_MIN + (settings['users'] / settings['spawn_rate'] + settings['warmup'] + settings['seconds'] + DRAIN_S) / 60 + (BURST_WAIT_MIN if burst else 0)


def block_minutes(block):
    return sum(member_minutes(block['settings'], bool(block['burst']) and bool(VM2_CONFIGS[c].get('burst'))) for c in block['order'])


def estimate_minutes(mode, install=True, cuts=()):
    """Minutes of a run of `mode`: setup (apt, Node, three npm ci and builds), the smoke of eight members, the measured members, and, for a full run, the dry run before it (a local
    run without the setup it already did) and the pool block that runs only when H3 is saturated by its pool."""
    smoke = sum(member_minutes(SMOKE, bool(VM2_CONFIGS[c].get('burst'))) for c in VM2_SMOKE_ORDER)
    members = sum(block_minutes(block) for block in vm2_blocks(mode, cuts))
    setup = SETUP_MIN if install else 0.0
    estimate = {'mode': mode, 'cuts': list(cuts), 'setup': setup, 'smoke': smoke, 'members': members, 'run': setup + smoke + (members if mode != 'smoke' else 0.0),
                'pool_block': block_minutes(pool_block(STEPS[1]))}
    if mode == 'full':
        dry = sum(block_minutes(block) for block in vm2_blocks('local'))
        estimate.update(dry_run=smoke + dry, vm_on=estimate['run'] + smoke + dry)
    return estimate


VM_ON_LIMIT_MIN = 360   # S9: the VM time above which the cuts are advised


def estimate_text(mode, install=True, cuts=()):
    e = estimate_minutes(mode, install, cuts)
    hours = lambda minutes: f'{minutes / 60:.1f} h'
    text = f"estimated time of the {mode} run: {hours(e['run'])} (setup {e['setup']:.0f} min, smoke {e['smoke']:.0f} min" + (f", measured members {e['members']:.0f} min)" if mode != 'smoke' else ')')
    if mode == 'full':
        text += f"; with the local dry run before it ({e['dry_run']:.0f} min) the VM is on about {hours(e['vm_on'])}, and the pool block adds {e['pool_block']:.0f} min if it runs"
        if cuts:
            text += f"; cuts applied: {', '.join(cuts)}"
        elif e['vm_on'] > VM_ON_LIMIT_MIN:
            text += '; over 6 h: ' + '; '.join(f"{'with' if n else 'pass'} --cut {c}{' as well' if n else ''}: {hours(estimate_minutes(mode, install, CUTS[:n + 1])['vm_on'])}"
                                              for n, c in enumerate(CUTS))
    return text


# ---- analysis of the v2 study (pure; tested offline) -----------------------------------------------------------------------------------
def gain_reading(ratio):
    """A throughput ratio (higher is better): 'có lợi' from 1.1, 'hại' up to 0.9, 'không đổi' between."""
    if ratio is None:
        return 'không đọc được'
    return 'có lợi' if ratio >= BANDS[1] else 'hại' if ratio <= BANDS[0] else 'không đổi'


def geometric_mean(values):
    values = list(values)
    if not values or any(v is None or v <= 0 for v in values):
        return None
    return math.exp(sum(math.log(v) for v in values) / len(values))


def rate_429_ok(metrics_list):
    """A step is readable only when no member answered more than 1% of its requests with 429 (the limiter, not the product, shaped the throughput)."""
    return not any((m.get('http') or {}).get('rate_429', 0.0) > RATE_429_MAX for m in metrics_list)


def ratio_entry(members, order, base, other, *, readable=True, operations=False):
    """compared/baseline for the pairs of `order` (pair_indices), each metric the geometric mean of the forward and the reverse pair; unreadable when a member of a pair is invalid
    or `readable` is False. `members`: metrics in run order."""
    positions = pair_indices(order, base, other)
    entry = {'base': base, 'other': other, 'positions': [list(p) for p in positions]}
    pairs = [(members[a], members[b]) for a, b in positions]
    if not readable or not all(m['valid'] for pair in pairs for m in pair):
        return {**entry, 'readable': False, 'ratios': None, 'reading': 'không đọc được'}
    ratios, pair_ratios = {}, {}
    for key in RATIO_KEYS:
        ratios[key], pair_ratios[key] = balanced(pairs, lambda m, k=key: m.get(k))
    entry.update(readable=True, ratios=ratios, pair_ratios=pair_ratios, throughput_reading=gain_reading(ratios['success_rps']),
                 read_p95_reading=band(ratios['read_p95_ms'], other), p95_reading=band(ratios['p95_ms'], other),
                 cpu_per_success_reading=band(ratios['cpu_ms_per_success'], other))
    if operations:
        names = sorted(set.intersection(*(set(m['operations']) for pair in pairs for m in pair)))
        entry['operations'] = {}
        for name in names:
            p95, p95_pairs = balanced(pairs, lambda m, n=name: m['operations'][n]['p95_ms'])
            entry['operations'][name] = {'p95_ratio': p95, 'p95_pair_ratios': p95_pairs, 'reading': band(p95, other),
                                         'p95_ms': {'base': [a['operations'][name]['p95_ms'] for a, _ in pairs], 'other': [b['operations'][name]['p95_ms'] for _, b in pairs]}}
    return entry


def pool_point(items):
    """The pool evidence of the members of one configuration in one step: the share of samples with every connection of an API process busy (mean over the members), the P2024
    lines and the 503s (sums). `bound` is True when an API process had its whole pool busy in at least half of the samples or a P2024 was logged, False when the sampler read and
    neither held, None when there is no sampler reading and no P2024 (K4)."""
    pools = [m.get('pool') or {} for m in items]
    available = all(p.get('available') for p in pools)
    apps = {}
    for p in pools:
        for name, share in (p.get('at_pool_limit_share') or {}).items():
            apps.setdefault(name, []).append(share)
    shares = {name: sum(v) / len(v) for name, v in sorted(apps.items())}
    top = max(shares.items(), key=lambda kv: kv[1]) if shares else (None, None)
    p2024 = sum(p.get('p2024_log_lines') or 0 for p in pools)
    full = top[1] is not None and top[1] >= POOL_FULL_SHARE
    return {'available': available, 'at_pool_limit_share': shares, 'share_max': top[1], 'share_max_app': top[0], 'p2024_log_lines': p2024,
            'http_503': sum(p.get('http_503') or 0 for p in pools), 'bound': True if full or p2024 > 0 else False if available else None}


def config_point(items):
    """The figures of one configuration in one block, from its members' metrics (two members in a balanced order): means of throughput, p95 and CPU, the failure rate over all
    their requests, the busiest generator, CPU per process and per group, the Node API processes at or above 0.85 core, and the pool evidence."""
    components = {}
    for name in sorted({n for m in items for n in (m.get('components') or {})}):
        components[name] = mean_of([m['components'][name] for m in items if name in m['components']])
    requests = sum(m['requests'] for m in items)
    generators = [m['generator_cores'] for m in items if m.get('generator_cores') is not None]
    return {'members': len(items), 'valid': all(m['valid'] for m in items), 'success_rps': mean_of([m.get('success_rps') for m in items]),
            'read_p95_ms': mean_of([m.get('read_p95_ms') for m in items]), 'p95_ms': mean_of([m.get('p95_ms') for m in items]),
            'cpu_ms_per_success': mean_of([m.get('cpu_ms_per_success') for m in items]), 'server_cores': mean_of([m.get('server_cores') for m in items]),
            'error_rate': sum(m['failures'] for m in items) / requests if requests else None,
            'rate_429': max(((m.get('http') or {}).get('rate_429') or 0.0 for m in items), default=0.0), 'generator_cores': max(generators) if generators else None,
            'components': components, 'groups': component_groups(components),
            'hot': sorted(name for name, cores in components.items() if API_PROCESS.fullmatch(name) and cores is not None and cores >= NODE_HOT),
            'pool': pool_point(items), 'outbox': [m.get('outbox') for m in items]}


def bottleneck(point):
    """Pool or CPU (K4): pool when an API process had its whole Prisma pool busy in at least half of the samples (or a P2024 was logged), CPU when a Node API process used 0.85 core or more."""
    pool, cpu = point['pool']['bound'], bool(point['hot'])
    label = ('pool + CPU' if pool and cpu else 'pool' if pool else 'CPU' if cpu else 'không đọc được (không có mẫu pg_stat_activity)' if pool is None
             else 'không phải pool hay CPU của Node (Postgres, RabbitMQ hay cả máy)')
    return {'pool': pool, 'cpu': cpu, 'hot': point['hot'], 'label': label}


def balance_flags(point):
    """For Core and for Clinic with two instances: how much more CPU the busier uses than the other, and whether that is above 20% (an uneven balancing)."""
    flags = {}
    for group in ('core', 'clinic'):
        cores = [c for name, c in point['components'].items() if component_group(name) == group and API_PROCESS.fullmatch(name) and c is not None]
        if len(cores) >= 2 and min(cores) > 0:
            flags[group] = {'instances': len(cores), 'busy_over_idle': max(cores) / min(cores), 'uneven': max(cores) / min(cores) - 1 > IMBALANCE}
    return flags


def block_groups(records):
    """Records (not abandoned) grouped by block, in run order."""
    blocks = {}
    for record in records:
        if not record.get('abandoned'):
            blocks.setdefault(record['block'], []).append(record)
    return blocks


def collect_points(records):
    """({users: {configuration: config_point}}, {users: no member got more than 1% of 429}) from Part 1 and the steps of Part 2; a configuration needs both its members."""
    points, tier_ok = {}, {}
    for members in block_groups(records).values():
        if members[0]['kind'] not in ('part1', 'tier'):
            continue
        users = members[0]['users']
        tier_ok[users] = rate_429_ok([r['metrics'] for r in members])
        for config in dict.fromkeys(r['config'] for r in members):
            items = [r['metrics'] for r in members if r['config'] == config]
            if len(items) == 2 and not any(m.get('failed') for m in items):
                points.setdefault(users, {})[config] = config_point(items)
    return points, tier_ok


def required_growth(users, previous_users):
    """1.5x when the users double; for another ratio the same efficiency per doubling, 1.5 ** log2(ratio) (600 after 400 users: 1.27)."""
    return SATURATION_GROWTH ** math.log2(users / previous_users)


def saturation(points, tier_ok):
    """Per configuration (M, H3, H3x2) and step, the three signs of saturation and the first step that shows one. A step with an invalid member, or whose 429 rate is above 1%, is
    'không đọc được' and gives the next step no growth to compare with. H3x2 has no 100-user step, so its first step has no growth sign (K6)."""
    levels = sorted(points)
    report = {'rules': {'throughput_growth_per_doubling': SATURATION_GROWTH, 'read_p95_ms': SATURATION_READ_P95_MS, 'error_rate': SATURATION_ERROR}, 'configs': {}}
    for config in SATURATION_CONFIGS:
        series, first = [], None
        for i, users in enumerate(levels):
            point = points[users].get(config)
            if point is None:
                continue
            if not (point['valid'] and tier_ok.get(users, True)):
                series.append({'users': users, 'readable': False, 'saturated': None, 'reading': 'không đọc được'})
                continue
            before_users = levels[i - 1] if i else None
            before = points[before_users].get(config) if before_users else None
            if before is not None and not (before['valid'] and tier_ok.get(before_users, True)):
                before = None
            signs, growth, required = [], None, None
            if before is not None and before['success_rps']:
                growth, required = point['success_rps'] / before['success_rps'], required_growth(users, before_users)
                if growth < required:
                    signs.append('throughput')
            if point['read_p95_ms'] is not None and point['read_p95_ms'] > SATURATION_READ_P95_MS:
                signs.append('read_p95')
            if point['error_rate'] is not None and point['error_rate'] > SATURATION_ERROR:
                signs.append('errors')
            series.append({'users': users, 'readable': True, 'saturated': bool(signs), 'signs': signs, 'success_rps': point['success_rps'], 'previous_users': before_users if before else None,
                           'growth': growth, 'required_growth': required, 'read_p95_ms': point['read_p95_ms'], 'error_rate': point['error_rate'],
                           'bottleneck': bottleneck(point)})
            if signs and first is None:
                first = users
        report['configs'][config] = {'series': series, 'first_saturated_users': first}
    # Which of Core and Clinic is the first to use 0.85 core (condition (a) of ADR-P13), from the one-instance H3 at each readable step.
    first_hot = {}
    for users in levels:
        point = points[users].get('H3')
        if point and point['valid'] and tier_ok.get(users, True):
            for name in point['hot']:
                first_hot.setdefault(component_group(name), users)
    earliest = sorted(group for group, users in first_hot.items() if users == min(first_hot.values())) if first_hot else []
    report['first_hot'] = {'users_by_group': first_hot, 'first': earliest[0] if len(earliest) == 1 else 'cùng bậc: ' + ', '.join(earliest) if earliest else None}
    return report


def pool_trigger(records, users):
    """`users` when the H3 members of that step are readable, saturated and have their Prisma pool full (K3, K4): the step at which the pool block runs, once. None otherwise."""
    points, tier_ok = collect_points(records)
    series = saturation(points, tier_ok)['configs']['H3']['series']
    entry = next((e for e in series if e['users'] == users), None)
    return users if entry and entry.get('saturated') and entry['bottleneck']['pool'] else None


SCALE_OUT_READINGS = {
    'A': 'Core là nút cổ chai, nhân Clinic không giúp vì mỗi request Clinic vẫn hỏi Core authorize: nhân Core có lợi, nhân Clinic một mình thì không '
         '(ADR-P13 đạt điều kiện (a); ADR-P14 §3 sửa thành "có lợi khi nhân Core; nhân Clinic một mình không").',
    'B': 'Hai nút cổ chai lần lượt: nhân Core xong thì Clinic (hoặc ngược lại) mới là giới hạn; phải nhân cả hai.',
    'C': 'Clinic nóng trước: nhân Clinic có lợi, nên tách Clinic khỏi Core có lý do chứng minh được (một lượt đo).',
    'D': 'Mọi tỷ lệ ≈ 1 và CPU thấp: chưa bão hòa ở bậc này, không kết luận.',
    'E': 'Mọi tỷ lệ ≈ 1 nhưng server gần hết lõi hoặc Postgres nóng: giới hạn nằm ở máy hoặc ở cơ sở dữ liệu, không ở số instance.',
    'F': 'Có tỷ lệ ≤ 0,9: instance thêm tốn hơn lợi (tranh lõi và kết nối với phần còn lại).'}
POSTGRES_HOT_SHARE = 0.5   # Postgres at half of the server CPUs or more counts as hot for reading D against E
BUSY_SERVER_SHARE = 6 / 7   # the processes of the stack together at 6/7 of the server CPUs or more: the machine is the limit


def scale_out_conclusion(entries, points, server_cpus=7):
    """The sample conclusion A-F of the highest step, from the throughput ratios of the five comparisons (1.1 and 0.9 bands). Order of reading: F (a ratio at or under 0.9), C (Clinic
    alone helps), B (Clinic is the next bottleneck once Core is doubled: H3x2cl2/H3x2 helps), A (Core alone helps), B again when only the combination helps (H3x2cl2 over H3 or over
    H3cl2 while no single doubling does), then D or E (nothing moves; E when the stack is nearly out of server cores or Postgres is hot). None when a ratio cannot be read."""
    labels = ('H3cl2/H3', 'H3x2/H3', 'H3x2cl2/H3x2', 'H3x2cl2/H3cl2', 'H3x2cl2/H3')
    ratios = {label: ((entries.get(label) or {}).get('ratios') or {}).get('success_rps') for label in labels}
    if any(v is None for v in ratios.values()):
        return {'code': None, 'reading': 'không đọc được', 'ratios': ratios}
    low, high = BANDS
    helps = lambda label: ratios[label] >= high
    busy = [name for name, p in points.items() if (p['server_cores'] or 0) >= BUSY_SERVER_SHARE * server_cpus or (p['components'].get('postgres') or 0) >= POSTGRES_HOT_SHARE * server_cpus]
    if any(v <= low for v in ratios.values()):
        code = 'F'
    elif helps('H3cl2/H3'):
        code = 'C'
    elif helps('H3x2cl2/H3x2'):
        code = 'B'
    elif helps('H3x2/H3'):
        code = 'A'
    elif helps('H3x2cl2/H3') or helps('H3x2cl2/H3cl2'):
        code = 'B'
    else:
        code = 'E' if busy else 'D'
    return {'code': code, 'reading': SCALE_OUT_READINGS[code], 'ratios': ratios, 'hot_processes': {name: p['hot'] for name, p in points.items()},
            'machine_or_database_busy': busy}


POOL_READINGS = {'có lợi': 'pool 8 có lợi: pool 4 là giới hạn của H3 ở bậc này', 'không đổi': 'pool 8 không đổi: giới hạn nằm chỗ khác (CPU của Node, Postgres)',
                 'hại': 'pool 8 hại: thêm kết nối làm Postgres chậm hơn', 'không đọc được': 'không đọc được'}


def analyze_pool(members, order, ok):
    entry = ratio_entry(members, order, *POOL_COMPARISONS[0][1:], readable=ok)
    points = {c: config_point([m for m, cfg in zip(members, order) if cfg == c]) for c in dict.fromkeys(order)}
    return {'comparisons': {POOL_COMPARISONS[0][0]: entry}, 'reading': POOL_READINGS[entry.get('throughput_reading', 'không đọc được')],
            'pool_before': points['H3']['pool'], 'pool_after': points['H3p8']['pool']}


def drain_reading(ratio, relay_share):
    """The reading of drain(nw2)/drain(nw1): up to 0.6 two workers drain nearly twice as fast, up to 0.9 faster but not linearly (the next stage is the relay or Postgres), up to 1.1
    no faster (the relay if relay drain is about the drain, else the Postgres commit), above that slower."""
    if ratio is None:
        return 'không đọc được'
    if ratio <= 0.6:
        return '2 worker xả gần gấp đôi'
    if ratio < BANDS[0]:
        return '2 worker xả nhanh hơn nhưng không tuyến tính: nút kế là relay hoặc Postgres'
    if ratio <= BANDS[1]:
        return ('nút ở relay (relay drain ≈ drain)' if relay_share is not None and relay_share >= 0.9 else 'nút ở commit Postgres') + ': thêm worker không xả nhanh hơn'
    return '2 worker xả chậm hơn 1 worker: bất thường'


def disturbance_reading(i):
    if i is None:
        return 'không đọc được'
    if i >= BANDS[1]:
        return f'đột biến làm chậm tải nền {round((i - 1) * 100)}% (p95 đọc)'
    return 'đột biến không làm chậm tải nền' if i <= BANDS[0] else 'Notification hấp thụ đột biến: p95 đọc của tải nền không đổi'


def read_ratio(metrics):
    """p95 of the reads in (120, 180] over p95 of the reads in [30, 120) of the window: how much slower the reads got after the second 120 than in the steady part before it."""
    segments = metrics.get('read_p95_segments') or {}
    before, after = (segments.get('before') or {}).get('p95_ms'), (segments.get('after') or {}).get('p95_ms')
    return after / before if before and after else None


def analyze_burst(members, order, control):
    """The burst block. drain(nw2)/drain(nw1) is the main figure (geometric mean of the forward and the reverse pair), the efficiency of the doubling 1/(2 x ratio). The effect on the
    load I = read ratio of the member / geometric mean of the read ratios of the two H3 members of Part 1 (`control`, the same ratio without a burst), per configuration and nw2/nw1."""
    label, base, other = BURST_COMPARISON
    positions = pair_indices(order, base, other)
    pairs = [(members[a], members[b]) for a, b in positions]
    readable = all(m['valid'] for pair in pairs for m in pair)
    drain = lambda m: (m.get('burst') or {}).get('drain_s')
    ratio, pair_ratios = balanced(pairs, drain) if readable else (None, [])
    relay_shares = [b['relay_drain_s'] / b['drain_s'] for m in members if (b := m.get('burst') or {}).get('drain_s') and b.get('relay_drain_s') is not None]
    relay_share = sum(relay_shares) / len(relay_shares) if relay_shares else None
    control_ratio = geometric_mean([read_ratio(m) for m in control])
    configs, disturbance = {}, {}
    for config in (base, other):
        items = [m for m, c in zip(members, order) if c == config]
        bursts = [m.get('burst') or {} for m in items]
        background = [(b.get('background_latency_ms') or {}) for b in bursts]
        before, during = (mean_of([(g.get('before') or {}).get('p95_ms') for g in background]), mean_of([(g.get('during') or {}).get('p95_ms') for g in background]))
        disturbed = geometric_mean([read_ratio(m) / control_ratio if read_ratio(m) and control_ratio else None for m in items]) if readable else None
        disturbance[config] = disturbed
        configs[config] = {'drain_s': [b.get('drain_s') for b in bursts], 'relay_drain_s': [b.get('relay_drain_s') for b in bursts],
                           'latency_p95_ms': [(b.get('latency_ms') or {}).get('p95_ms') for b in bursts], 'read_ratio': [read_ratio(m) for m in items],
                           'I': disturbed, 'I_reading': disturbance_reading(disturbed), 'background_p95_ms': {'before': before, 'during': during},
                           'background_delay': during / before if before and during else None}
    i_ratio = disturbance[other] / disturbance[base] if disturbance[base] and disturbance[other] else None
    delay = configs[base]['background_delay'], configs[other]['background_delay']
    return {'readable': readable, 'configs': configs,
            'drain': {'comparison': label, 'ratio': ratio, 'pair_ratios': pair_ratios, 'efficiency': 1 / (2 * ratio) if ratio else None, 'relay_share_of_drain': relay_share,
                      'reading': drain_reading(ratio, relay_share)},
            'disturbance': {'control_read_ratio': control_ratio, 'I': disturbance, 'I_nw2_over_nw1': i_ratio, 'reading': disturbance_reading(disturbance[other]),
                            'control': 'the read ratio of the two H3 members of Part 1 (same segments, no burst)'},
            'background_notifications': {'delay_during_over_before': dict(zip((base, other), delay)),
                                         'reading': 'trễ thông báo nền tăng: thông báo thường xếp sau đợt dồn (đề xuất ưu tiên queue để sau)'
                                         if any(d is not None and d >= BANDS[1] for d in delay) else 'trễ thông báo nền không tăng đáng kể' if all(d is not None for d in delay) else 'không đọc được'}}


ANALYSIS_LIMITATIONS = (
    'Only the burst members sample the queue every second (burst-observe: an amqplib call and database reads on the server CPUs); the H3 members of Part 1, which are the control of '
    'the effect I, run without that load, so I carries a small upward bias that is not corrected.',
    "The pg_stat_activity sampler counts a connection as busy when its state is not 'idle': a pooled connection that is checked out but waiting between statements does not count, so "
    'the share of samples with the whole pool busy is a lower bound and the pool threshold of K4 (half of the samples) can under-report a pool that is the limit. P2024 is a lower '
    'bound as well: the services answer a pool timeout with a 503 and log nothing.',
    'H3c (gateway -> Core -> Clinic) is an upper bound of the price at compose, where Core calls Clinic directly.')


def analyze_v2(records, *, stopped=None, top=None, pool=None, server_cpus=7):
    """The analysis of a v2 run from its records (one per member run: block, kind, users, config, planned_order, metrics, abandoned). Blocks are read only when complete."""
    records = [r for r in records if not r.get('abandoned')]
    analysis = {'decision': 'NOT_RUN' if not records else 'INCOMPLETE' if stopped else 'COMPARED', 'bands': list(BANDS), 'blocks': {}, 'unreadable': [], 'scale_out': None,
                'pool': None, 'burst': None, 'stopped': stopped, 'top_tier': top, 'pool_block': pool, 'limitations': list(ANALYSIS_LIMITATIONS),
                'note': 'Each ratio is the geometric mean of the forward and the reverse pair of a palindrome order (compared/baseline): a multiplicative drift with the same factor per '
                        'position cancels exactly, other shapes only to first order. One VM session, two pairs per ratio: a descriptive comparison, not a capacity or equal-budget '
                        'acceptance. H3c/H3 is an upper bound of the price at compose (the hop gateway -> Core -> Clinic is not the one of the compose files).'}
    points, tier_ok = collect_points(records)
    part1 = [r['metrics'] for r in records if r['block'] == 'part1']
    for name, members in block_groups(records).items():
        kind, users = members[0]['kind'], members[0]['users']
        order, planned = tuple(r['config'] for r in members), tuple(members[0].get('planned_order') or ())
        metrics = [r['metrics'] for r in members]
        block = {'kind': kind, 'users': users, 'order': list(order), 'complete': order == planned, 'members': [r['name'] for r in members]}
        analysis['blocks'][name] = block
        if kind == 'probe':
            block['probe'] = 'a dry-run member, not paired'
            continue
        if not block['complete'] or any(m.get('failed') for m in metrics):
            analysis['unreadable'].append(f'{name}: the block did not run to its end')
            continue
        readable = tier_ok.get(users, True) if kind in ('part1', 'tier') else rate_429_ok(metrics)
        block['rate_429_ok'] = readable
        if not readable:
            analysis['unreadable'].append(f'{name}: more than 1% of the responses were 429')
        block['valid'] = all(m['valid'] for m in metrics)
        if kind == 'burst':
            analysis['burst'] = analyze_burst(metrics, order, [r['metrics'] for r in records if r['block'] == 'part1' and r['config'] == 'H3'])
            analysis['burst']['block'] = name
            if not analysis['burst']['readable']:
                analysis['unreadable'].append(f'{name}: a member is invalid, the drain is not readable')
            continue
        if kind == 'pool':
            analysis['pool'] = analyze_pool(metrics, order, readable)
            analysis['pool']['block'] = name
            continue
        comparisons = PART1_COMPARISONS if kind == 'part1' else SCALE_OUT_COMPARISONS if order == TOP_ORDER else TIER_COMPARISONS
        block['comparisons'] = {label: ratio_entry(metrics, order, base, other, readable=readable, operations=kind == 'part1') for label, base, other in comparisons
                                if base in order and other in order}  # the 200-user step without H3x2 (cut) has no H3x2/H3
        block['configs'] = {c: config_point([m for m, cfg in zip(metrics, order) if cfg == c]) for c in dict.fromkeys(order)}
        block['balance'] = {c: flags for c in block['configs'] if (flags := balance_flags(block['configs'][c]))}
        analysis['unreadable'] += [f'{name}: {label}' for label, entry in block['comparisons'].items() if not entry['readable'] and readable]
        if order == TOP_ORDER:
            analysis['scale_out'] = {'block': name, **scale_out_conclusion(block['comparisons'], block['configs'], server_cpus), 'balance': block['balance']}
    analysis['saturation'] = saturation(points, tier_ok) if points else None
    readable_ratios = [e for b in analysis['blocks'].values() for e in (b.get('comparisons') or {}).values() if e['readable']]
    if analysis['decision'] == 'COMPARED' and not readable_ratios and not (analysis['burst'] or {}).get('readable'):
        analysis['decision'] = 'INVALID'
    return analysis


# ---- plain Ubuntu VM, bridge-m-h-vm-v2 -----------------------------------------------------------------------------------------------
class VmStudy2(VmStudy):
    """The v2 study on the VM: three trees (M, H1, H3), ten configurations (VM2_CONFIGS) and the blocks of vm2_blocks, run in order, each member checked as it ends. A member that
    FAILED stops the study; an invalid one is carried to the analysis. Two decisions are taken during the run: the first member of the highest step moves that step to 600 users when
    its generator needs more than 0.70 core (K10; the member is kept, marked abandoned, and left out of the analysis), and the pool block runs once, right after the first readable
    step at which H3 is saturated with its Prisma pool full (K3, K4)."""
    study_name, order, smoke_order = VM2_STUDY, (), VM2_SMOKE_ORDER

    def __init__(self, root, private, output, run, *, mode, progress=print, cuts=()):
        root = Path(root)
        Study.__init__(self, root / 'M', root / 'H3', private, output, run, mode=mode, progress=progress)
        vm2_blocks(mode, cuts)  # refuses cuts that do not apply
        self.trees = {name: root / name for name in VM2_GROUPS}
        self.kaggle, self.pinning, self.cuts = False, None, tuple(cuts)
        self.records, self.stopped, self.top, self.pool, self.last_block = [], None, None, None, None

    def build(self):
        for name in VM2_GROUPS:
            self.command(['npm', 'ci', '--no-audit', '--no-fund'], cwd=self.trees[name])
            self.command(['npm', 'run', 'build', '-w', 'backend'] if name == 'M' else ['npm', 'run', 'phase2:build'], cwd=self.trees[name])

    def versions(self):
        return {**super().versions(), 'study': VM2_STUDY}

    def member(self, index, configuration, settings, label, *, burst=None, pg_sampler=False):
        """Runs one member in its own directory (smoke-<i>-<cfg>, or full-<i>-<users>-<cfg> for a measured one). `burst` is the spec of a burst configuration and only of those."""
        from bridge_monolith import run_monolith
        from pcn_runner import run_pcn
        plan = VM2_CONFIGS[configuration]
        if (burst is None) == bool(plan.get('burst')):
            raise ValueError(f'BRIDGE_BURST: {configuration} {"needs" if plan.get("burst") else "takes no"} a burst, got {burst!r}')
        name = member_name(index, settings['users'], configuration) if label == 'full' else f'{label}-{index}-{configuration}'
        directory = self.private / 'members' / name
        directory.parent.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        say = lambda text: self.progress(f'[{name}] {text}')
        if configuration == 'M':
            run_monolith(self.trees['M'], self.trees['H3'], directory, settings=settings, locustfile=LOCUSTFILE, progress=say, pinning=self.pinning, pg_sampler=pg_sampler)
        else:
            run_pcn(self.trees[plan['tree']], directory, mode='full' if label == 'full' else 'smoke', settings=settings, locustfile=LOCUSTFILE, service_env=H_LIMITS,
                    core_replicas=plan['core'], core_proxy=True, pinning=self.pinning, vm=True, core_layout=plan['layout'], db_pool_limit=plan['pool'], pg_sampler=pg_sampler,
                    replicas=plan['clinic'], notification_workers=plan['nw'], gateway_topology=plan['topology'], burst=burst, progress=say)
        self.stages.append({'stage': name, 'seconds': round(time.monotonic() - started, 1)})
        return directory

    def metrics(self, directory, settings, require_cpu=True, *, config, errors_invalidate=True, burst=False, pg_sampler=False):
        return member_metrics(directory, settings, require_cpu=require_cpu, v2={'config': config, 'errors_invalidate': errors_invalidate, 'burst': burst, 'pg_sampler': pg_sampler,
                                                                                'burst_at': burst_moment(self.cuts)})

    def smoke_members(self):
        """The eight smoke members (VM2_SMOKE_ORDER, 2 users, 15 s); H3bnw2 fires a burst of 200 at second 5."""
        results = []
        for i, c in enumerate(self.smoke_order):
            burst = BURST_SMOKE if VM2_CONFIGS[c].get('burst') else None
            results.append(self.metrics(self.member(i, c, SMOKE, 'smoke', burst=burst), SMOKE, require_cpu=False, config=c, burst=burst is not None))
        return results

    def run_member(self, block, config):
        """One measured member of a block; its record joins self.records (the index counts every member run, abandoned ones too)."""
        settings, index = block['settings'], len(self.records)
        burst = block['burst'] if VM2_CONFIGS[config].get('burst') else None
        directory = self.member(index, config, settings, 'full', burst=burst, pg_sampler=block['pg_sampler'])
        metrics = self.metrics(directory, settings, config=config, errors_invalidate=block['errors_invalidate'], burst=burst is not None, pg_sampler=block['pg_sampler'])
        record = {'index': index, 'name': member_name(index, settings['users'], config), 'block': block['name'], 'kind': block['kind'], 'users': settings['users'],
                  'config': config, 'planned_order': list(block['order']), 'metrics': metrics}
        self.records.append(record)
        return record

    def run_block(self, block):
        """Runs the members of a block in order; False when one FAILED (the study stops there). The first member of the highest step may move it to TOP_FALLBACK users."""
        self.last_block = block
        for position, config in enumerate(block['order']):
            record = self.run_member(block, config)
            if record['metrics'].get('failed'):
                self.stopped = {'member': record['name'], 'reasons': record['metrics']['reasons']}
                return False
            if position == 0 and block['top']:
                cores = record['metrics'].get('generator_cores')
                self.top.update(probe=record['name'], generator_cores=cores)
                if self.mode == 'full' and block['users'] == STEPS[-1] and cores is not None and cores > GENERATOR_SHIFT:
                    self.top.update(used=TOP_FALLBACK, shifted=True, reason=f'the generator of the first member at {block["users"]} users used {cores:.2f} core, above {GENERATOR_SHIFT:.2f} (K10)')
                    record['abandoned'] = True
                    self.progress(f'[{record["name"]}] generator {cores:.2f} core above {GENERATOR_SHIFT:.2f}: the highest step runs at {TOP_FALLBACK} users')
                    return self.run_block(top_block(TOP_FALLBACK))
        return True

    def measure(self, result):
        self.records, self.stopped = [], None
        self.top = {'planned': STEPS[-1], 'used': STEPS[-1], 'shifted': False, 'probe': None, 'generator_cores': None, 'reason': None}
        self.pool = {'ran': False, 'users': None}
        for block in vm2_blocks(self.mode, self.cuts):
            if not self.run_block(block):
                break
            if self.mode == 'full' and block['kind'] == 'tier' and not self.pool['ran']:
                users = pool_trigger(self.records, self.last_block['users'])
                if users:
                    self.pool.update(ran=True, users=users)
                    self.progress(f'H3 is saturated with its Prisma pool full at {users} users: the pool block H3,H3p8,H3p8,H3 runs now')
                    if not self.run_block(pool_block(users)):
                        break
        analysis = analyze_v2(self.records, stopped=self.stopped, top=self.top, pool=self.pool, server_cpus=len(self.pinning['server']) if self.pinning else 7)
        result['members'] = [{**{key: value for key, value in record.items() if key not in ('metrics', 'planned_order')}, **record['metrics']} for record in self.records]
        result['comparison'] = analysis
        result['settings'] = {'part1': load_settings(100, None if self.mode == 'full' else LOCAL_WINDOW), 'steps': list(STEPS), 'top_tier': self.top, 'pool_block': self.pool,
                              'burst': next((b['burst'] for b in vm2_blocks(self.mode, self.cuts) if b['burst']), None)}
        result['status'] = 'COMPLETE'

    def execute(self, install=True):
        self.progress(estimate_text(self.mode, install, self.cuts))
        return super().execute(install=install)

    def annotate(self, result):
        bundle = self.h_root.parent / 'bundle-manifest.json'
        sources = json.loads(bundle.read_text(encoding='utf-8')) if bundle.is_file() else {}
        result['vm'] = {'configurations': VM2_CONFIGS, 'orders': {'part1': PART1_ORDER, 'burst': BURST_ORDER, 'tier': TIER_ORDER, 'top': TOP_ORDER, 'pool': POOL_ORDER,
                                                                 'smoke': VM2_SMOKE_ORDER}, 'steps': list(STEPS), 'cuts': list(self.cuts), 'pinning': self.pinning,
                        'harnessChanges': list(VM2_HARNESS_CHANGES),
                        'sources': {key: sources.get(key) for key in ('mCommit', 'h1Commit', 'h3Commit', 'h3ProductCommit', 'harnessFromWorktree', 'treeSha256', 'sha256')}}


def run_vm_study2(root, private, output, run, *, mode, progress=print, install=True, cuts=()):
    return VmStudy2(root, private, output, run, mode=mode, progress=progress, cuts=cuts).execute(install=install)


def main(argv=None):
    import uuid
    parser = argparse.ArgumentParser(description='bridge-m-h-vm-v1 or v2 on a plain Ubuntu VM; vm_run.sh is the usual entry point.')
    parser.add_argument('--platform', choices=('vm',), required=True)
    parser.add_argument('--study', choices=('v1', 'v2'), default='v1', help='v1 = M,H0,H1,H2 (default, what vm_run.sh of the v1 bundle runs); v2 = M,H1,H3 and the scale-out blocks')
    parser.add_argument('--root', type=Path, required=True, help='extracted bundle: M/, H0/, H1/ (v1) or M/, H1/, H3/ (v2), bundle-manifest.json')
    parser.add_argument('--results', type=Path, required=True, help='directory for the evidence files (created)')
    parser.add_argument('--private', type=Path, help='work directory for logs and reports (default: <root>/work)')
    parser.add_argument('--mode', choices=('smoke', 'full', 'local'), default='full', help='full = smoke gate, then the measured members')
    parser.add_argument('--cut', action='append', choices=CUTS, default=[], help='v2 full only, S9: cut when the VM time would pass 6 h (x2-200 drops the H3x2 pair of the 200-user step, burst-short shortens the burst block)')
    parser.add_argument('--no-install', action='store_true', help='skip apt, Node and pip (already installed)')
    args = parser.parse_args(argv)
    if args.cut and args.study != 'v2':
        parser.error('--cut is for --study v2')
    private = args.private or args.root / 'work'
    private.mkdir(parents=True, exist_ok=True)
    progress = lambda text: print(text, flush=True)
    if args.study == 'v2':
        result = run_vm_study2(args.root, private, args.results, str(uuid.uuid4()), mode=args.mode, progress=progress, install=not args.no_install, cuts=tuple(args.cut))
    else:
        result = run_vm_study(args.root, private, args.results, str(uuid.uuid4()), mode=args.mode, progress=progress, install=not args.no_install)
    comparison = result.get('comparison', {})
    print(json.dumps({'status': result['status'], 'decision': comparison.get('decision'), 'smoke': result.get('smoke'),
                      'error_type': result.get('error_type'), 'error': result.get('error'), 'results': result['download']},
                     indent=2, ensure_ascii=False), flush=True)
    return 0 if result['status'] == 'SMOKE_PASSED' or comparison.get('decision') == 'COMPARED' else 1


if __name__ == '__main__':
    sys.exit(main())
