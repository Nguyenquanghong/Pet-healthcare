"""Phase-1 PCN01/02 workload on an isolated three-service phase-2 stack."""
from __future__ import annotations
import csv
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
from collections import Counter

from native_stack import NativeStack, count_pool_timeouts, start_pg_sampler
from benchmark import Client, reconcile
from cqrs_probe import preflight as cqrs_preflight
from cqrs_diagnostics import collect as collect_read_diagnostics

LEGACY = Path(__file__).resolve().parents[2] / 'kaggle'
sys.path.insert(0, str(LEGACY))
from pcn_contract import percentile, report as legacy_report
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


def taskset_prefix(pinning):
    """Command prefix that puts the Locust generator on its own CPUs (bridge VM study)."""
    return ['taskset', '-c', ','.join(str(cpu) for cpu in pinning['generator'])] if pinning else []


def server_taskset_prefix(cpus):
    """Prefix of every server process a member starts (NativeStack, Monolith): the controller itself stays on the generator CPU."""
    return ['taskset', '-c', ','.join(str(cpu) for cpu in cpus)] if cpus else []


PINNING_METHOD = 'taskset -c for the generator and for every server process the controller starts; the controller sits on the generator CPU'


def observed_affinity(tracked, pinning):
    """Evidence that pinning took effect: generator and controller sit on the generator CPUs only, every server process inside the server CPUs."""
    import psutil
    seen, verified = {}, True
    for name, pid, _ in tracked:
        try:
            cpus = sorted(psutil.Process(pid).cpu_affinity())
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        seen[name] = cpus
        verified = verified and (set(cpus) == set(pinning['generator']) if name in ('generator', 'controller') else set(cpus) <= set(pinning['server']))
    return {'observed': seen, 'verified': verified and 'generator' in seen}


def steady_window(settings, started, ended):
    """Epoch seconds that bound the steady part of a member, as bridge_study.member_metrics trims its CPU samples: after ramp, warmup and 5 s, before the 15 s drain."""
    return started + settings['users'] / settings['spawn_rate'] + settings['warmup'] + 5, ended - 15


def outbox_pending(inspected):
    """Events still waiting in the Core and Clinic outboxes in a control 'inspect' answer: a backlog at the end of the load shows what the workers did not keep up with."""
    return {'core': inspected.get('pendingCore'), 'clinic': inspected.get('pendingClinic')}


# ---- the notification burst (bridge VM study, K9): the controller fires it, samples the queue, waits for the drain and does the arithmetic ----
BURST_MAX = 20000      # stack.mjs notification-burst: count from 1 to this
BURST_DRAIN_WAIT_S = 180   # how long after the load the controller waits for the Notification workers to apply the whole burst


def burst_spec(burst, settings, cqrs_configuration=None):
    """The burst a member is asked for: {'count': events, 'at_s': seconds after the measurement window opened}, inside the window, and never with a CQRS configuration."""
    if cqrs_configuration is not None:
        raise ValueError('a notification burst only for a member without a CQRS configuration')
    if (not isinstance(burst, dict) or set(burst) != {'count', 'at_s'} or type(burst['count']) is not int or not 1 <= burst['count'] <= BURST_MAX
            or type(burst['at_s']) not in (int, float) or not 0 <= burst['at_s'] < settings['seconds']):
        raise ValueError(f"burst is {{'count': 1..{BURST_MAX}, 'at_s': from 0 to the {settings['seconds']} s of the window}}, got {burst!r}")
    return {'count': burst['count'], 'at_s': burst['at_s']}


def burst_due(start, now, at_s, fired=False):
    """True when the burst has not been fired and its moment has come: `start` is the monotonic second the measurement window opened (None until it has) and `now`
    the controller's monotonic second; the generator and the controller share one machine, so one clock."""
    return not fired and start is not None and now >= start + at_s


def latency_stats(values):
    """Count, nearest-rank p50 and p95, and maximum of latencies in ms (None when there are none)."""
    values = list(values)
    return {'n': len(values), 'p50_ms': percentile(values, 0.5), 'p95_ms': percentile(values, 0.95), 'max_ms': max(values) if values else None}


def segment_stats(points, edges):
    """latency_stats of (moment, latency) points cut at two moments: before [.., burst), during [burst, drained) and after [drained, ..). `drained` is math.inf while
    the burst is not drained, so everything from the burst on is `during`."""
    burst, drained = edges
    if burst > drained:
        raise ValueError('the burst moment cannot come after the drained moment')
    segments = {'before': [], 'during': [], 'after': []}
    for moment, latency in points:
        segments['before' if moment < burst else 'during' if moment < drained else 'after'].append(latency)
    return {name: latency_stats(values) for name, values in segments.items()}


def burst_summary(report, observations, *, workers, start_monotonic, epoch_offset):
    """Everything burst.json says, from the raw answers of stack.mjs: `report` (burst-report), `observations` (burst-observe, one per second), `workers` (Notification workers
    in the member), `start_monotonic` (when the measurement window opened) and `epoch_offset` (epoch seconds minus monotonic seconds on this machine, which turns the epoch
    milliseconds of the databases into window seconds).

    Valid means: the queue showed one consumer per worker in every sample, the dead-letter queue stayed empty, the Notification inbox holds exactly the burst's events and
    no process exited. A burst that has not drained has no drain time (`drain_s` None, 'không đọc được'), however long the controller waited."""
    count, committed = report['count'], report['committedAtMs']
    inbox, relay = report['inbox'], report['relay']
    drained = inbox['applied'] == count and inbox['lastAtMs'] is not None
    relay_done = relay['published'] == count and relay['lastPublishedAtMs'] is not None
    queues = [o['queue'] for o in observations if o.get('queue')]
    dead = [o['dlq']['messageCount'] for o in observations if o.get('dlq')]
    consumers = sorted({q['consumerCount'] for q in queues})
    reasons = []
    if consumers != [workers]:
        reasons.append(f'the queue showed consumerCount {consumers or "never"}, not {workers} (one per Notification worker)')
    if any(dead):
        reasons.append(f'the dead-letter queue held up to {max(dead)} message(s)')
    if inbox['applied'] != count:
        reasons.append(f"the notification inbox holds {inbox['applied']} of the {count} events")
    if report.get('unexpectedExit') or any(o.get('unexpectedExit') for o in observations):
        reasons.append('a process of the stack exited unexpectedly')
    window_ms = (start_monotonic + epoch_offset) * 1000
    # The load's own notifications, from the measurement window on (the ramp and warmup are not steady), cut by the burst and by its drain.
    points = [(moment, latency) for moment, latency in report['background']['pairs'] if moment >= window_ms]
    return {'valid': not reasons, 'reasons': reasons, 'count': count, 'workers': workers,
            'committed_s': (committed - window_ms) / 1000, 'insert_ms': report['insertMs'],
            'drained': drained, 'drain_s': (inbox['lastAtMs'] - committed) / 1000 if drained else None,
            'drain_reading': 'đã xả xong' if drained else 'không đọc được',
            'relay_drain_s': (relay['lastPublishedAtMs'] - committed) / 1000 if relay_done else None,
            'latency_ms': latency_stats(report['latencyMs']),
            'background_latency_ms': segment_stats(points, (committed, inbox['lastAtMs'] if drained else math.inf)),
            'background_unmatched': report['background']['unmatched'],
            'queue': {'samples': len(queues), 'consumer_counts': consumers, 'ready_max': max((q['messageCount'] for q in queues), default=None),
                      'dlq_max': max(dead, default=None), 'probe_errors': sum(bool(o.get('probeError')) for o in observations),
                      'clinic_outbox_pending_max': max((o['clinicOutboxPending'] for o in observations if o.get('clinicOutboxPending') is not None), default=None),
                      'control_errors': sum('error' in o for o in observations)}}


class BurstRun:
    """The burst of one member. tick() runs once per second of the load: it fires the burst when the window has reached its moment and samples the queue and the databases
    (burst.jsonl); finish() runs after the load, waits for the inbox to hold the whole burst and reads the outcome back."""

    def __init__(self, stack, spec, workers, window_path, log_path):
        self.stack, self.spec, self.workers, self.window_path = stack, spec, workers, Path(window_path)
        self.start, self.fired, self.observations = None, None, []
        self.log = Path(log_path).open('w', encoding='utf-8')

    def window_start(self):
        """When the generator opened the measurement window (bridge_locust.py writes it once, atomically), None before."""
        try:
            value = json.loads(self.window_path.read_text(encoding='utf-8'))['start_monotonic']
        except (OSError, ValueError, KeyError, TypeError):
            return None
        return value if type(value) in (int, float) else None

    def observe(self, now):
        # A sample that fails is recorded and the load goes on; the burst itself failing to fire is not hidden (tick).
        try:
            row = {'monotonic_s': now, **self.stack.control('burst-observe')}
        except RuntimeError:
            row = {'monotonic_s': now, 'error': 'control-failed'}
        self.observations.append(row)
        self.log.write(json.dumps(row) + '\n')
        self.log.flush()
        return row

    def tick(self, now):
        if self.start is None:
            self.start = self.window_start()
        if burst_due(self.start, now, self.spec['at_s'], self.fired is not None):
            offset = time.time() - time.monotonic()
            self.fired = {'monotonic_s': now, 'epoch_offset_s': offset, 'response': self.stack.control('notification-burst', count=self.spec['count'])}
        self.observe(now)

    def finish(self, progress=print):
        if self.fired is None:
            return {'status': 'NOT_FIRED', 'valid': False, 'reasons': ['the measurement window never reached the burst moment'], **self.spec, 'window_opened': self.start is not None}
        deadline = time.monotonic() + BURST_DRAIN_WAIT_S
        while True:
            row = self.observe(time.monotonic())
            if row.get('burstApplied') == self.spec['count'] or time.monotonic() >= deadline:
                break
            time.sleep(1)
        progress(f"PCN burst: {row.get('burstApplied')} of {self.spec['count']} notifications applied")
        summary = burst_summary(self.stack.control('burst-report'), self.observations, workers=self.workers, start_monotonic=self.start,
                                epoch_offset=self.fired['epoch_offset_s'])
        return {'status': 'COMPLETE', **self.spec, 'fired_s': self.fired['monotonic_s'] - self.start, 'epoch_offset_s': self.fired['epoch_offset_s'],
                'start_monotonic': self.start, 'observations': len(self.observations), **summary}

    def close(self):
        self.log.close()


def stop_load(child):
    if child and child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait(timeout=10)


def run_pcn(repo, output, *, mode='full', replicas=1, progress=print, cqrs_configuration=None,
            settings=None, locustfile='benchmarks/phase2/kaggle/pcn_locust.py', service_env=None,
            core_replicas=1, core_proxy=False, pinning=None, vm=False, core_layout=None, db_pool_limit=None, pg_sampler=False,
            notification_workers=1, gateway_topology='direct', burst=None):
    # settings/locustfile/service_env: the M/H bridge study (bridge_study.py) runs a
    # shorter window, its own booking grid and raised per-IP limiter thresholds.
    # core_replicas/core_proxy/pinning/vm: the bridge VM study runs outside Kaggle, with
    # Clinic and Notification reaching Core through an nginx upstream (two instances in H2),
    # the generator and the controller pinned to their own CPU and the servers to the others.
    # core_layout/db_pool_limit: the Core worker layout of the tree and the Prisma pool of every service (NativeStack, stack.mjs). pg_sampler: the pg_stat_activity
    # sampler and the P2024 count for the pool question (bridge VM study, Part 2 and the pool block); it adds a psql process and a query every 0.2 s, so other members run without.
    # replicas (Clinic API instances), notification_workers (Notification workers on the one queue) and gateway_topology (direct or core-ingress) are the K9 scale-out axes: each goes to
    # NativeStack, and so to stack.mjs, only when it leaves the default, and every member's manifest records all three.
    # burst={'count': N, 'at_s': S}: fire a burst of N notifications S seconds into the measurement window, sample the queue every second (burst.jsonl), and after the load wait
    # up to BURST_DRAIN_WAIT_S for the Notification workers to apply them all, then write burst.json (BurstRun, burst_summary).
    if cqrs_configuration not in (None, 'O', 'A', 'B'): raise ValueError('Unknown CQRS configuration')
    settings = configuration(mode) if settings is None else dict(settings)
    if burst is not None:
        burst = burst_spec(burst, settings, cqrs_configuration)
    repo, output = Path(repo).resolve(), Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    kaggle = platform.system() == 'Linux' and Path('/kaggle/working').is_dir()
    if mode == 'full' and not kaggle and not vm:
        raise RuntimeError('Full PCN acceptance requires a Kaggle session; use smoke for local validation')
    manifest = {'protocol': PROTOCOL, 'mode': mode, **settings, 'clinic_replicas': replicas, 'core_replicas': core_replicas,
                'notification_workers': notification_workers, 'gateway_topology': gateway_topology,
                'core_proxy': core_proxy, 'configuration': cqrs_configuration or 'O',
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
    if vm:
        manifest['vm'] = True
    if pg_sampler:
        manifest['pg_sampler'] = True
    if burst is not None:
        manifest['burst'] = dict(burst)
    if pinning:
        manifest['pinning'] = {**pinning, 'method': PINNING_METHOD}
    # Relative to the tree this file belongs to: the bridge VM study runs several trees with one harness.
    root = Path(__file__).resolve().parents[3]
    for file in [LEGACY / 'pcn_contract.py', LEGACY / 'pcn_locustfile.py', LEGACY / 'metrics.py',
                 *[Path(__file__).with_name(name) for name in ('pcn_runner.py', 'pcn_locust.py', 'pcn_adapter.py', 'pcn_dataset.mjs', 'native_stack.py', 'stack.mjs', 'benchmark.py', 'acceptance.json')],
                 *[root / name for name in ('benchmarks/phase2/dataset.mjs', locustfile) if (root / name).is_file()]]:
        manifest['hashes'][file.resolve().relative_to(root).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
    # The run executes the repo's own copies (stack.mjs, locust files, fixtures); they must be the hashed harness bytes.
    manifest['harness_mismatch'] = [name for name, expected in manifest['hashes'].items()
                                    if not (repo / name).is_file() or hashlib.sha256((repo / name).read_bytes()).hexdigest() != expected]
    for name in ('cpu.max', 'memory.max'):
        path = Path('/sys/fs/cgroup') / name
        if path.is_file(): manifest[name] = path.read_text().strip()
    summary = legacy_report()
    summary.update({'load_status': 'NOT_RUN', 'scope': 'PCN01/PCN02 load only', 'capacity_accepted': False})
    child = None
    sampler = None
    burst_run = None
    stage = 'startup'
    stack = None
    try:
        progress(f"PCN {mode}: {settings['users']} users, {settings['seconds']}s measured, Clinic={replicas}")
        stage = 'harness-integrity'
        if manifest['harness_mismatch']:
            raise RuntimeError('Harness files of the repo differ from the hashed harness')
        stage = 'startup'
        options = {} if cqrs_configuration is None else {'cqrs_configuration': cqrs_configuration}
        if service_env:
            options['service_env'] = service_env
            manifest['service_env'] = dict(service_env)
        if core_replicas != 1:
            options['core_replicas'] = core_replicas
        if core_proxy:
            options['core_proxy'] = True
        if core_layout is not None:
            options['core_layout'] = core_layout
        if db_pool_limit is not None:
            options['db_pool_limit'] = db_pool_limit
        if notification_workers != 1:
            options['notification_workers'] = notification_workers
        if gateway_topology != 'direct':
            options['gateway_topology'] = gateway_topology
        if pinning:
            options['server_cpus'] = pinning['server']
        stack = NativeStack(repo, accounts=settings['users'], replicas=replicas, dataset_profile='pcn', **options)
        with stack:
            manifest['run'] = stack.run
            manifest['gateway'] = stack.fixture.get('gateway')
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
            if burst is not None:
                # bridge_locust.py writes the monotonic second the measurement window opens into this file, only when the variable is set (the monolith's run never sets it).
                window_path = stack.private / 'pcn-window.json'
                env['PCN_WINDOW'] = str(window_path)
                burst_run = BurstRun(stack, burst, notification_workers, window_path, output / 'burst.jsonl')
            stage = 'load'
            if pg_sampler:
                sampler = start_pg_sampler(stack.pg_sampler(stack.private / 'pg-activity.txt'), manifest)
            started_epoch = time.time()
            with (stack.private / 'pcn-load.log').open('w') as log:
                child = subprocess.Popen([*taskset_prefix(pinning), sys.executable, '-m', 'locust', '-f',
                    str(repo / locustfile), '--headless', '--only-summary',
                    '--host', stack.fixture['baseUrl'], '--users', str(settings['users']),
                    '--spawn-rate', str(settings['spawn_rate']), '--stop-timeout', '12'],
                    cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT)
                tracked = [(p['name'], p['pid'], False) for p in stack.fixture['processes']]
                tracked += [(name, proc.pid, name == 'rabbitmq') for name, proc in stack.processes if name != 'application']
                tracked += [('postgres', int((stack.private / 'pgdata/postmaster.pid').read_text().splitlines()[0]), True),
                            ('nginx', int((stack.private / 'nginx.pid').read_text().strip()), True),
                            ('generator', child.pid, False)]
                if pinning and cqrs_configuration is None:
                    tracked.append(('controller', os.getpid(), False))
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
                            if pinning and 'verified' not in manifest['pinning'] and now - started >= 3:
                                manifest['pinning'].update(observed_affinity(tracked, pinning))
                            if cqrs_configuration is not None:
                                with (output / 'cqrs.jsonl').open('a', encoding='utf-8') as handle:
                                    handle.write(json.dumps({'monotonic_s': now, **stack.control('cqrs-observe')}) + '\n')
                            process_errors += sum('error' in row and row['component'] != 'generator' for row in samples)
                            for row in samples: resource_file.write(json.dumps(row) + '\n')
                            resource_file.flush()
                            if burst_run is not None:
                                burst_run.tick(now)
                            if now >= next_progress:
                                progress(f'PCN elapsed {int(now-started)}s (ramp/warmup included); continuing without retries')
                                next_progress = now + 30
                            time.sleep(1)
                finally:
                    stop_load(child)
                    if sampler is not None:
                        manifest['pg_activity'] = sampler.stop(stack.db_pool_limit, *steady_window(settings, started_epoch, time.time()))
                        sampler = None
            manifest['locust_exit_code'] = child.returncode
            manifest['process_sample_errors'] = process_errors
            stage = 'reconciliation'
            load = json.loads((output / 'load-final.json').read_text())
            http = http_summary(output / 'http.csv')
            if pg_sampler:
                manifest['pool_timeouts'] = {**count_pool_timeouts(stack.private), 'http_503': http['http_503']}
            generator = json.loads((output / 'generator.json').read_text())
            created = [json.loads(line)['id'] for line in writes_path.read_text().splitlines()]
            after = stack.control('inspect')
            manifest['outbox'] = {'pending_before': outbox_pending(before), 'pending_after': outbox_pending(after)}
            reconciliation = reconcile(before, after, created)
            (output / 'reconciliation.json').write_text(json.dumps(reconciliation, indent=2))
            (output / 'http-summary.json').write_text(json.dumps(http, indent=2))
            summary = verdict(load, http, kaggle=kaggle and mode == 'full',
                runtime_ok=generator_ok(child.returncode, load, generator['user_errors']) and process_errors == 0 and reconciliation['status'] == 'PASS_IN_SCOPE')
            summary['achieved_rps'] = load['requests'] / load['measured_seconds'] if load.get('measured_seconds') else None
            summary['success_rps'] = (load['requests']-load['failures']) / load['measured_seconds'] if load.get('measured_seconds') else None
            if burst_run is not None:
                # After the reconciliation, so that its 'after' snapshot is the one every other member takes right at the end of the load.
                stage = 'burst-drain'
                result = burst_run.finish(progress)
                (output / 'burst.json').write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
                manifest['burst'] = {**burst, 'status': result['status'], 'valid': result['valid']}
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
        if sampler is not None:
            sampler.stop()
        if burst_run is not None:
            burst_run.close()
        if cqrs_configuration in ('A','B') and stack is not None:
            manifest['read_diagnostics'] = collect_read_diagnostics(stack.private, replicas, output)
        (output / 'manifest.json').write_text(json.dumps(manifest, indent=2))
        (output / 'pcn-report.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding='utf-8')
    return summary
