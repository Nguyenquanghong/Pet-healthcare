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
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
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
          'generator.json', 'resources.jsonl', 'requests.jsonl', 'http.csv')


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


def member_metrics(directory, settings, require_cpu=True, late_from=None):
    """require_cpu=False for the smoke: its 15 s window has no steady part after trimming.
    late_from: also summarise requests started at or after that second of the window (exploratory, VM study)."""
    directory = Path(directory)
    report = json.loads((directory / 'pcn-report.json').read_text(encoding='utf-8'))
    manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('status') != 'COMPLETE':
        return {'valid': False, 'reasons': ['member ' + manifest.get('status', 'missing') + ' at ' + str(manifest.get('failed_stage'))]}
    load = json.loads((directory / 'load-final.json').read_text())
    reconciliation = json.loads((directory / 'reconciliation.json').read_text())
    rows = [json.loads(line) for line in (directory / 'requests.jsonl').read_text().splitlines() if line]
    ops = operation_stats(rows)
    latencies = [r['response_time_ms'] for r in rows]
    # Server CPU over the steady part: drop ramp + warmup (+5 s) and the 15 s drain.
    samples = [json.loads(line) for line in (directory / 'resources.jsonl').read_text().splitlines() if line]
    times = sorted({s['monotonic_s'] for s in samples})
    cores, rss, late_cores = [], [], []
    if times:
        ramped = times[0] + settings['users'] / settings['spawn_rate'] + settings['warmup']
        for t in (t for t in times if ramped + 5 <= t <= times[-1] - 15):
            server = [s for s in samples if s['monotonic_s'] == t and s['component'] not in NOT_SERVER and 'error' not in s]
            if server and all(s['cpu_percent_one_core'] is not None for s in server):
                cores.append(sum(s['cpu_percent_one_core'] for s in server) / 100)
                rss.append(sum(s['rss_bytes_sum'] for s in server))
                if late_from is not None and t >= ramped + late_from:
                    late_cores.append(cores[-1])
    success_rps = report.get('success_rps')
    reasons = []
    if not load.get('completed'):
        reasons.append('window not completed')
    if load.get('observed_user_min') != settings['users']:
        reasons.append('population below target')
    if not report.get('raw_counts_match'):
        reasons.append('raw counts mismatch')
    if (load.get('error_rate') or 0) > 0.01:
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
    return metrics


def band(ratio, subject='H'):
    if ratio is None:
        return None
    return f'{subject} nhanh hơn' if ratio <= BANDS[0] else f'{subject} chậm hơn' if ratio >= BANDS[1] else 'tương đương'


def balanced(pairs, value):
    """Geometric mean of H/M over the ABBA pairs; None if any side is missing."""
    ratios = []
    for m, h in pairs:
        a, b = value(m), value(h)
        if not a or b is None:
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
    """Adjacent (base, other) positions of a balanced order: the k-th base with the k-th other."""
    first = [i for i, c in enumerate(order) if c == base]
    second = [i for i, c in enumerate(order) if c == other]
    if not first or len(first) != len(second) or any(abs(a - b) != 1 for a, b in zip(first, second)):
        raise ValueError('BRIDGE_ORDER_NOT_BALANCED')
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
            smoke = [self.metrics(self.member(i, c, SMOKE, 'smoke'), SMOKE, require_cpu=False) for i, c in enumerate(self.smoke_order)]
            result['smoke'] = [{'configuration': c, 'valid': m['valid'], 'reasons': m['reasons']} for c, m in zip(self.smoke_order, smoke)]
            if not all(m['valid'] for m in smoke):
                result.update(status='SMOKE_FAILED', comparison={'decision': 'NOT_RUN'})
            elif self.mode == 'smoke':
                result.update(status='SMOKE_PASSED', comparison={'decision': 'NOT_RUN'})
            else:
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


def main(argv=None):
    import uuid
    parser = argparse.ArgumentParser(description='bridge-m-h-vm-v1 on a plain Ubuntu VM; vm_run.sh is the usual entry point.')
    parser.add_argument('--platform', choices=('vm',), required=True)
    parser.add_argument('--root', type=Path, required=True, help='extracted bundle: M/, H0/, H1/, bundle-manifest.json')
    parser.add_argument('--results', type=Path, required=True, help='directory for the evidence files (created)')
    parser.add_argument('--private', type=Path, help='work directory for logs and reports (default: <root>/work)')
    parser.add_argument('--mode', choices=('smoke', 'full', 'local'), default='full', help='full = smoke gate, then the 8 members')
    parser.add_argument('--no-install', action='store_true', help='skip apt, Node and pip (already installed)')
    args = parser.parse_args(argv)
    private = args.private or args.root / 'work'
    private.mkdir(parents=True, exist_ok=True)
    result = run_vm_study(args.root, private, args.results, str(uuid.uuid4()), mode=args.mode,
                          progress=lambda text: print(text, flush=True), install=not args.no_install)
    comparison = result.get('comparison', {})
    print(json.dumps({'status': result['status'], 'decision': comparison.get('decision'), 'smoke': result.get('smoke'),
                      'error_type': result.get('error_type'), 'error': result.get('error'), 'results': result['download']},
                     indent=2, ensure_ascii=False), flush=True)
    return 0 if result['status'] == 'SMOKE_PASSED' or comparison.get('decision') == 'COMPARED' else 1


if __name__ == '__main__':
    sys.exit(main())
