"""bridge-m-h-kaggle-v1: the pre-split monolith M against the current product H.

Answers "does the module split carry load better than the monolith" with one short
Kaggle session. One workload (bridge_locust.py: PCN tasks and pacing, bookings
valid in both versions), 100 closed-loop users, 30 s warmup after full population
and a 300 s window per member. Members run one at a time on fresh data in the
order M,H,H,M: the Kaggle host slows down 10-25% per member within a session
(cqrs-final-matched-kaggle-v1), and with ABBA a linear drift cancels in the
geometric mean of the two H/M pairs. A two-user smoke of each version gates the
measured members.

Both versions run their own defaults except H's per-IP and rescue limiter
thresholds, raised because all generator traffic shares one loopback IP; the
limiter itself still runs (Redis round trip on every request). Per-actor limits
stay at H's defaults. M has no limiter outside /api/auth, which PCN never calls.

Decision rule, fixed before any run: for each operation the order-balanced H/M
p95 ratio r reads "H nhanh hơn" if r <= 0.9, "tương đương" if 0.9 < r < 1.1 and
"H chậm hơn" if r >= 1.1; the same bands apply to server CPU per successful
request. Throughput is reported, not graded (closed loop: think time bounds it).
A member that fails validity makes the comparison INVALID; nothing is retried.
"""
from __future__ import annotations
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

STUDY = 'bridge-m-h-kaggle-v1'
ORDER = ('M', 'H', 'H', 'M')
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
def member_metrics(directory, settings):
    directory = Path(directory)
    report = json.loads((directory / 'pcn-report.json').read_text(encoding='utf-8'))
    manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('status') != 'COMPLETE':
        return {'valid': False, 'reasons': ['member ' + manifest.get('status', 'missing') + ' at ' + str(manifest.get('failed_stage'))]}
    load = json.loads((directory / 'load-final.json').read_text())
    reconciliation = json.loads((directory / 'reconciliation.json').read_text())
    rows = [json.loads(line) for line in (directory / 'requests.jsonl').read_text().splitlines() if line]
    operations = {}
    for row in rows:
        operations.setdefault(row['name'], []).append(row)
    ops = {name: {'requests': len(items), 'failures': sum(r['failed'] for r in items),
                  'p50_ms': percentile([r['response_time_ms'] for r in items], 50),
                  'p95_ms': percentile([r['response_time_ms'] for r in items], 95),
                  'mean_response_bytes': sum(r['response_bytes'] or 0 for r in items) / len(items)}
           for name, items in sorted(operations.items())}
    latencies = [r['response_time_ms'] for r in rows]
    # Server CPU over the steady part: drop ramp + warmup (+5 s) and the 15 s drain.
    samples = [json.loads(line) for line in (directory / 'resources.jsonl').read_text().splitlines() if line]
    times = sorted({s['monotonic_s'] for s in samples})
    cores, rss = [], []
    if times:
        first = times[0] + settings['users'] / settings['spawn_rate'] + settings['warmup'] + 5
        for t in (t for t in times if first <= t <= times[-1] - 15):
            server = [s for s in samples if s['monotonic_s'] == t and s['component'] not in NOT_SERVER and 'error' not in s]
            if server and all(s['cpu_percent_one_core'] is not None for s in server):
                cores.append(sum(s['cpu_percent_one_core'] for s in server) / 100)
                rss.append(sum(s['rss_bytes_sum'] for s in server))
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
    if not cores:
        reasons.append('no steady CPU samples')
    mean_cores = sum(cores) / len(cores) if cores else None
    return {'valid': not reasons, 'reasons': reasons, 'operations': ops, 'requests': len(rows),
            'failures': sum(r['failed'] for r in rows), 'error_rate': load.get('error_rate'),
            'p50_ms': percentile(latencies, 50), 'p95_ms': percentile(latencies, 95), 'success_rps': success_rps,
            'server_cores': mean_cores, 'server_rss_mb': sum(rss) / len(rss) / 2**20 if rss else None,
            'cpu_ms_per_success': mean_cores * 1000 / success_rps if mean_cores and success_rps else None,
            'writes_without_success_response': reconciliation.get('writes_without_success_response'),
            'pcn_load_status': report.get('load_status')}


def band(ratio):
    if ratio is None:
        return None
    return 'H nhanh hơn' if ratio <= BANDS[0] else 'H chậm hơn' if ratio >= BANDS[1] else 'tương đương'


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


# ---- Kaggle session ------------------------------------------------------------
class Study:
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

    def execute(self, install=True):
        reports = self.private / 'reports'
        reports.mkdir(parents=True, exist_ok=True)
        result = {'study': STUDY, 'run': self.run, 'mode': self.mode, 'status': 'RUNNING'}
        try:
            if install:
                self.timed('prerequisites', self.prerequisites)
            self.timed('build', self.build)
            write_json(reports / 'environment.json', self.versions())
            smoke = [member_metrics(self.member(i, c, SMOKE, 'smoke'), SMOKE) for i, c in enumerate(('M', 'H'))]
            result['smoke'] = [{'configuration': c, 'valid': m['valid'], 'reasons': m['reasons']} for c, m in zip(('M', 'H'), smoke)]
            if not all(m['valid'] for m in smoke):
                result.update(status='SMOKE_FAILED', comparison={'decision': 'NOT_RUN'})
            elif self.mode == 'smoke':
                result.update(status='SMOKE_PASSED', comparison={'decision': 'NOT_RUN'})
            else:
                settings = FULL if self.mode == 'full' else {**FULL, 'seconds': 60, 'warmup': 10}
                members = [member_metrics(self.member(i, c, settings, 'full'), settings) for i, c in enumerate(ORDER)]
                result['members'] = [{'configuration': c, **m} for c, m in zip(ORDER, members)]
                result['comparison'] = compare(members)
                result['settings'] = settings
                result['status'] = 'COMPLETE'
        except Exception as error:
            result.update(status='FAILED', error_type=type(error).__name__, error=str(error)[:200])
        result['stages'] = self.stages
        write_json(reports / 'evaluation.json', result)
        result['download'] = str(self.export())
        return result

    def timed(self, name, action):
        started = time.monotonic()
        self.progress(f'{name}...')
        action()
        self.stages.append({'stage': name, 'seconds': round(time.monotonic() - started, 1)})

    def export(self):
        target = self.output.with_suffix('.zip')
        with zipfile.ZipFile(target, 'x', zipfile.ZIP_DEFLATED) as archive:
            for path in sorted((self.private / 'reports').glob('*.json')):
                archive.write(path, 'reports/' + path.name)
            for member in sorted((self.private / 'members').glob('*')) if (self.private / 'members').is_dir() else []:
                for name in EXPORT:
                    if (member / name).is_file():
                        archive.write(member / name, f'members/{member.name}/{name}')
            for path in sorted((self.h_root.parent).glob('bundle-manifest.json')):
                archive.write(path, 'bundle-manifest.json')
        return target


def run_study(m_root, h_root, private, output, run, *, mode, progress=print, install=True):
    return Study(m_root, h_root, private, output, run, mode=mode, progress=progress).execute(install=install)
