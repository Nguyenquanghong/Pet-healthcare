"""cqrs-list-matched-kaggle-v1 controller on the Kaggle shared envelope.

Builds O and AB once from the verified Q6 v9 source bundle (sources unchanged),
copies the manifested list overlay (list_trial.py, list_pcn_locust.py) into both
roots, records a fresh profile and profileKey (path-normalized build digests, pool
ceilings), runs a readiness smoke (calibration + one O,A,B block per selected
workload) and, only when that passes in the same session and mode='full', the
selected matched blocks in the locked order O,A,B / B,O,A / A,B,O. One member at
a time; one collector process per member. At most one whole-block replacement
for an environmental invalidity; correctness/application failures stop the study.
Imported only after the notebook verified every source bundle member.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import list_evaluate as ev  # noqa: E402

STUDY = 'cqrs-list-matched-kaggle-v1'
BUNDLE = 'test-results/phase2/cqrs/q6-cold-parts-20261019/cqrs-q6-source-v9.zip'
BUNDLE_SHA = '2b3d7c9c3e94980386dec3e5900198f9e6e6fd7c35d80cac9146709b47bb9037'
POLICY = 'phase2-plan/cqrs/list-study/cqrs-list-matched-kaggle-v1.policy.json'
OVERLAY = ('benchmarks/phase2/kaggle/list_trial.py', 'benchmarks/phase2/kaggle/list_pcn_locust.py')
BENCH = ('tools/phase2/cqrs/activity/bench/collector.mjs', 'tools/phase2/cqrs/activity/bench/collector-cli.mjs',
         'tools/phase2/cqrs/activity/bench/profile.mjs')
CONTROLLER = ('benchmarks/phase2/kaggle/list_study.py', 'benchmarks/phase2/kaggle/list_evaluate.py',
              'benchmarks/phase2/kaggle/make_list_policy.py', 'benchmarks/phase2/kaggle/make_list_notebook.py')
BUILD_DIRS = ('backend/dist', 'services/clinic/dist', 'services/notification/dist', 'packages/runtime/dist',
              'packages/contracts/dist', 'packages/messaging/dist')
ROLES = ['api', 'worker', 'relay', 'postgres', 'broker', 'redis', 'gateway', 'controller', 'generator']
APT = ('postgresql', 'postgresql-client', 'libpq-dev', 'rabbitmq-server', 'redis-server', 'nginx', 'ca-certificates', 'xz-utils')
PIP = ('locust==2.44.4', 'psutil==7.0.0')
NODE = 'v24.16.0'
DEADLINE = {'query-heavy': 3600, 'pcn': 4200}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def files_digest(root, names):
    return digest(json.dumps(sorted([n, digest((Path(root) / n).read_bytes())] for n in names)).encode())


class Study:
    def __init__(self, source, private, output, run, *, mode, workloads, blocks, progress=print):
        if mode not in ('smoke', 'full') or not workloads or set(workloads) - {'query-heavy', 'pcn'}:
            raise ValueError('LIST_STUDY_SELECTION')
        if mode == 'full' and (not blocks or set(blocks) - {0, 1, 2} or len(set(blocks)) != len(blocks)):
            raise ValueError('LIST_STUDY_BLOCKS')
        self.source, self.private, self.output, self.run = Path(source), Path(private), Path(output), run
        self.mode, self.workloads, self.blocks, self.progress = mode, list(workloads), list(blocks or []), progress
        self.policy = json.loads((self.source / POLICY).read_text(encoding='utf-8'))
        self.reports = self.private / 'reports'
        self.reports.mkdir(parents=True, exist_ok=True)
        self.env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'LANG', 'TMPDIR')}
        self.stages, self.outcomes = [], {w: [] for w in self.workloads}

    # ---- environment -------------------------------------------------------
    def command(self, args, timeout=900, **kwargs):
        with (self.private / 'commands.log').open('a') as log:
            result = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=timeout, **kwargs)
        if result.returncode:
            raise RuntimeError('LIST_SETUP_COMMAND_FAILED')

    def capture(self, args):
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=30, env=self.env)
        except (OSError, subprocess.TimeoutExpired):
            return 'unavailable'
        return ((result.stdout or '') + (result.stderr or '')).strip().split('\n')[0] if result.returncode == 0 else 'unavailable'

    def profile_environment(self):
        from activity_d5_native import environment_profile
        self.environment = environment_profile()
        write_json(self.reports / 'environment.json', self.environment)

    def prerequisites(self):
        if platform.system() != 'Linux' or not Path('/kaggle/working').is_dir() or os.geteuid() != 0:
            raise RuntimeError('KAGGLE_LINUX_ROOT_REQUIRED')
        policy_rc = Path('/usr/sbin/policy-rc.d'); created = not policy_rc.exists()
        if created:
            policy_rc.write_text('#!/bin/sh\nexit 101\n'); policy_rc.chmod(0o755)
        try:
            self.command(['apt-get', 'update', '-qq'])
            self.command(['apt-get', 'install', '-y', '-qq', '--no-install-recommends', *APT], env={**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'})
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
            self.env['PATH'] = os.environ['PATH']
        if self.capture(['node', '--version']) != NODE:
            raise RuntimeError('NODE_VERSION_MISMATCH')
        self.command([sys.executable, '-m', 'pip', 'install', '-q', '--no-cache-dir', *PIP])

    def build(self):
        import cqrs_benchmark
        bundle = self.source / BUNDLE
        if digest(bundle.read_bytes()) != BUNDLE_SHA:
            raise RuntimeError('LIST_BUNDLE_HASH')
        self.roots, self.plan, self.manifest = cqrs_benchmark.prepare(bundle, BUNDLE_SHA)
        for root in self.roots.values():
            for name in OVERLAY:
                target = root / name
                with target.open('xb') as handle:
                    handle.write((self.source / name).read_bytes())
        node = lambda root: json.loads(subprocess.check_output(['node', str(self.source / BENCH[2]), 'build-digest', str(root), *BUILD_DIRS], text=True, env=self.env))
        self.builds = {group: node(root) for group, root in self.roots.items()}
        if any(b['files'] == 0 for b in self.builds.values()):
            raise RuntimeError('LIST_BUILD_MISSING')

    def versions(self):
        pg_bin = self.capture(['pg_config', '--bindir'])
        dpkg = lambda p: self.capture(['dpkg-query', '-W', '-f=${Version}', p])
        pip = lambda p: self.capture([sys.executable, '-c', f'import importlib.metadata as m;print(m.version("{p}"))'])
        return {'node': self.capture(['node', '--version']), 'npm': self.capture(['npm', '--version']),
                'postgres': self.capture([pg_bin + '/postgres', '--version']), 'redis': self.capture(['redis-server', '--version']),
                'nginx': self.capture(['nginx', '-v']), 'rabbitmq': dpkg('rabbitmq-server'), 'erlang': dpkg('erlang-base'),
                'python': platform.python_version(), 'locust': pip('locust'), 'psutil': pip('psutil'), 'kernel': platform.release()}

    def profile_key(self):
        e, s = self.environment, self.source
        harness = sorted([*self.manifest['sources']['harness']['files']], key=lambda r: r['path'])
        key = {'resourceClass': self.policy['resourceClass'], 'cpuModel': e['cpuModel'], 'architecture': e['architecture'],
               'cpuQuotaAndAffinity': {'quota': e['cpuMax'], 'affinity': e['affinity']}, 'memoryMax': e['memoryMax'],
               'liveSoftwareVersions': self.live_versions, 'replicas': {'clinic': 1, 'core': 1, 'notification': 1},
               'poolLimits': self.policy['profile']['poolCeilingsPerProcess'],
               'sourceBuildManifests': {g: {'source': self.manifest['sources'][g]['sha256'], 'buildNormalized': self.builds[g]['normalized']} for g in ('O', 'AB')},
               'logicalFixtureDigest': files_digest(s, ['benchmarks/phase2/kaggle/query_dataset.mjs', 'benchmarks/phase2/kaggle/pcn_dataset.mjs']),
               'traceDigest': digest(json.dumps({'queryHeavy': self.policy['queryHeavy'], 'pcn': self.policy['pcn'],
                                                 'locustfile': digest((s / 'benchmarks/kaggle/pcn_locustfile.py').read_bytes())}, sort_keys=True).encode()),
               'harnessDigest': digest(json.dumps({'bundleHarness': self.manifest['sources']['harness']['sha256'],
                                                   'overlay': files_digest(s, [*OVERLAY, *BENCH, *CONTROLLER])}, sort_keys=True).encode()),
               'policyDigest': digest((s / POLICY).read_bytes())}
        if sorted(key) != sorted(self.policy['profile']['keyFields']):
            raise RuntimeError('LIST_PROFILE_KEY_FIELDS')
        return key

    def record_profile(self):
        self.live_versions = self.versions()
        self.key = self.profile_key()
        self.key_sha = digest(json.dumps(self.key, sort_keys=True).encode())
        write_json(self.reports / 'plan-and-hashes.json', {
            'study': STUDY, 'run': self.run, 'mode': self.mode, 'workloads': self.workloads, 'blocks': self.blocks,
            'bundleSha256': BUNDLE_SHA, 'bundleManifestSha256': self.manifest['sha256'],
            'sources': {g: {'sha256': v['sha256'], 'files': len(v['files'])} for g, v in self.manifest['sources'].items()},
            'builds': self.builds, 'overlay': {n: digest((self.source / n).read_bytes()) for n in (*OVERLAY, *BENCH, *CONTROLLER)},
            'policySha256': self.key['policyDigest'], 'profileKey': self.key, 'profileKeySha256': self.key_sha})
        write_json(self.reports / 'fresh-profile-and-pid-role-pool-ledger.json', {
            'environment': self.environment, 'versions': self.live_versions, 'profileKeySha256': self.key_sha,
            'poolCeilingsPerProcess': self.policy['profile']['poolCeilingsPerProcess'],
            'accounting': self.policy['accounting'], 'ledgers': 'per member in members/<id>/member-report.json'})

    # ---- measurement -------------------------------------------------------
    def collector(self, ledger, samples):
        return subprocess.Popen(['node', str(self.source / BENCH[1]), 'run', str(ledger), str(samples), '1000'],
                                env=self.env, stdout=subprocess.DEVNULL, stderr=(self.private / 'collector.log').open('a'))

    def window_cpu(self, samples, start, end, roles=ROLES):
        out = subprocess.check_output(['node', str(self.source / BENCH[1]), 'window', str(samples), str(start), str(end), ','.join(roles)], text=True, env=self.env)
        return json.loads(out)

    def calibration(self):
        """Open loop 120 s at 2x arrival rate into a no-op loopback sink, collector running."""
        import benchmark
        sink = subprocess.Popen([sys.executable, '-c', 'import http.server as h\nclass S(h.BaseHTTPRequestHandler):\n def do_GET(s):\n  s.send_response(204);s.end_headers()\n def log_message(s,*a):pass\nsrv=h.ThreadingHTTPServer(("127.0.0.1",0),S);print(srv.server_address[1],flush=True);srv.serve_forever()'],
                                stdout=subprocess.PIPE, text=True, env=self.env)
        port = int(sink.stdout.readline())
        ledger, samples = self.private / 'calibration-ledger.json', self.reports / 'calibration-resource.jsonl'
        collector = self.collector(ledger, samples)
        ledger.write_text(json.dumps({'generator': [os.getpid()], 'controller': [sink.pid, collector.pid]}))
        q = self.policy['queryHeavy']
        def call(index):
            import http.client
            c = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
            try:
                c.request('GET', '/noop'); status = c.getresponse().status
            finally:
                c.close()
            return {'operation': 'noop', 'status': status, 'sent': True, 'outcome': 'success' if status == 204 else 'http_error'}
        try:
            start = time.monotonic()
            load = benchmark.open_loop(call, rate=q['arrivalsPerSecond'] * self.policy['generatorValidity']['openLoopCalibrationRateMultiplier'],
                                       seconds=self.policy['generatorValidity']['openLoopCalibrationSeconds'], concurrency=q['concurrency'])
            end = start + self.policy['generatorValidity']['openLoopCalibrationSeconds']
        finally:
            collector.send_signal(signal.SIGTERM); collector.wait(timeout=15); sink.terminate(); sink.wait(timeout=10)
        member = {'workload': 'query-heavy', 'configuration': 'O',
                  'report': {'status': 'COMPLETE', 'settings': {'rate': load['offered_rps']}, 'measured': {'seconds': load['seconds']}},
                  'rows': [{**r, 'phase': 'measured', 'operation': 'noop' if r['sent'] else r['operation']} for r in load['rows']]}
        result = {'validity': ev.query_member(member, self.policy)['validity'], 'offeredRps': load['offered_rps'], 'seconds': load['seconds'],
                  'cpu': self.window_cpu(samples, start * 1000, end * 1000, roles=['generator', 'controller'])}
        write_json(self.reports / 'calibration.json', result)
        return result

    def member(self, workload, block, configuration, mode, attempt):
        ident = f'{workload}-{mode}-b{block}-{configuration}' + ('-r' if attempt else '')
        out, ledger, samples = self.reports / 'members' / ident, self.private / (ident + '-ledger.json'), self.private / (ident + '-resource.jsonl')
        ledger.write_text(json.dumps({'controller': [os.getpid()]}))
        collector = self.collector(ledger, samples)
        root = self.roots['O' if configuration == 'O' else 'AB']
        args = [sys.executable, str(root / OVERLAY[0]), '--workload', workload, '--configuration', configuration, '--mode', mode,
                '--output', str(out), '--ledger', str(ledger), '--controller-pid', str(os.getpid()), '--controller-pid', str(collector.pid)]
        started = time.monotonic()
        with (self.private / (ident + '.log')).open('wb') as log:
            child = subprocess.Popen(args, cwd=root, env=self.env, stdout=log, stderr=subprocess.STDOUT)
            try:
                while child.poll() is None:
                    if time.monotonic() - started > DEADLINE[workload]:
                        child.send_signal(signal.SIGINT); child.wait(timeout=60)
                        break
                    self.progress(f'{STUDY} {ident}: {int(time.monotonic() - started)}s; no retries')
                    try: child.wait(timeout=30)
                    except subprocess.TimeoutExpired: pass
            finally:
                if child.poll() is None:
                    child.kill(); child.wait(timeout=10)
                collector.send_signal(signal.SIGTERM)
                try: collector.wait(timeout=15)
                except subprocess.TimeoutExpired: collector.kill()
        report = json.loads((out / 'member-report.json').read_text()) if (out / 'member-report.json').is_file() else {'status': 'FAIL', 'failedStage': 'no-report'}
        window = report.get('measured') if workload == 'query-heavy' else report.get('window')
        cpu = self.window_cpu(samples, window['startMonotonicMs'], window['endMonotonicMs']) if window and window.get('startMonotonicMs') else {'complete': False, 'reasons': ['no_window']}
        shutil.copyfile(samples, out / 'resource-raw.jsonl') if samples.is_file() and out.is_dir() else None
        write_json(out / 'cpu-window.json', cpu) if out.is_dir() else None
        return {'id': ident, 'workload': workload, 'block': block, 'configuration': configuration, 'mode': mode, 'attempt': attempt,
                'exitCode': child.returncode, 'status': report.get('status'), 'failedStage': report.get('failedStage'), 'dir': str(out.relative_to(self.reports)), 'cpu': cpu}

    def loaded(self, record):
        """Member as the evaluator reads it (from the files just written)."""
        d = self.reports / record['dir']
        rows = [json.loads(l) for l in (d / 'requests.jsonl').read_text().splitlines() if l.strip()] if (d / 'requests.jsonl').is_file() else []
        probe = [json.loads(l) for l in (d / 'event-loop-probe.jsonl').read_text().splitlines() if l.strip()] if (d / 'event-loop-probe.jsonl').is_file() else []
        report = json.loads((d / 'member-report.json').read_text()) if (d / 'member-report.json').is_file() else {'status': 'FAIL'}
        return {'workload': record['workload'], 'configuration': record['configuration'], 'report': report, 'rows': rows, 'probe': probe, 'cpu': record['cpu']}

    def run_block(self, workload, block, mode):
        order = self.policy['blocksForEachWorkload'][block]
        for attempt in (0, 1):
            records = []
            for configuration in order:
                record = self.member(workload, block, configuration, mode, attempt)
                records.append(record)
                if record['status'] != 'COMPLETE':
                    break
            entry = {'index': block, 'mode': mode, 'attempt': attempt, 'order': order, 'profileKeySha256': self.key_sha, 'records': records}
            self.outcomes[workload].append(entry)
            write_json(self.reports / 'all-trial-outcomes.json', self.outcomes)
            if any(r['status'] != 'COMPLETE' for r in records):
                return 'APPLICATION_FAILURE'
            metrics = {r['configuration']: ev.member_metrics(self.loaded(r), self.policy) for r in records}
            if not all(m['correct'] for m in metrics.values()):
                return 'CORRECTNESS_FAILURE'
            if all(m['validity']['valid'] for m in metrics.values()):
                return 'COMPLETE'
        return 'INVALID_ENVIRONMENT_AFTER_REPLACEMENT'

    def readiness(self):
        checks = {}
        if 'query-heavy' in self.workloads:
            cal = self.calibration()
            checks['calibration'] = 'PASS' if cal['validity']['valid'] and cal['cpu'].get('complete') else 'FAIL'
        for workload in self.workloads:
            status = self.run_block(workload, 0, 'smoke')
            entry = self.outcomes[workload][-1]
            metrics = {r['configuration']: ev.member_metrics(self.loaded(r), self.policy) for r in entry['records']}
            pools = {c: ev.pool_check(self.loaded(r)['report'].get('pool', {}).get('peaks', {}), c, self.policy) for c, r in ((r['configuration'], r) for r in entry['records'])}
            checks[workload] = {'block': status, 'cpuComplete': all(m['cpu']['complete'] for m in metrics.values()),
                                'pools': all(p['pass'] for p in pools.values()), 'pathAndContract': all(m['correct'] for m in metrics.values()),
                                'generatorValid': all(m['validity']['valid'] for m in metrics.values())}
        ok = all(v == 'PASS' if isinstance(v, str) else (v['block'] == 'COMPLETE' and v['cpuComplete'] and v['pools'] and v['pathAndContract'] and v['generatorValid'])
                 for v in checks.values())
        result = {'status': 'READY_FOR_FULL_BLOCKS' if ok else 'NOT_READY', 'checks': checks, 'profileKeySha256': self.key_sha}
        write_json(self.reports / 'readiness.json', result)
        return result

    def full(self):
        statuses = {}
        for workload in self.workloads:
            for block in self.blocks:
                statuses[f'{workload}-b{block}'] = status = self.run_block(workload, block, 'full')
                if status != 'COMPLETE':
                    return statuses
        return statuses

    def evaluate(self):
        workloads = {}
        for workload, entries in self.outcomes.items():
            full = [e for e in entries if e['mode'] == 'full']
            chosen = {}
            for e in full:  # first valid complete attempt of each planned block wins
                if e['index'] not in chosen and len(e['records']) == 3 and all(r['status'] == 'COMPLETE' for r in e['records']):
                    members = {r['configuration']: self.loaded(r) for r in e['records']}
                    if all(ev.member_metrics(m, self.policy)['validity']['valid'] for m in members.values()) or e['attempt'] == 1:
                        chosen[e['index']] = {'index': e['index'], 'profileKeySha256': e['profileKeySha256'], 'members': members}
            if chosen:
                workloads[workload] = [chosen[i] for i in sorted(chosen)]
        result = ev.evaluate(workloads, self.policy) if workloads else {'decision': 'NOT_RUN'}
        result['scope'] = 'session-partial: combine all sessions offline with list_evaluate.py before any claim'
        write_json(self.reports / 'evaluation.json', result)
        return result


def flushed(message):
    print(message, flush=True)


def run_study(source, private, output, run, *, mode, workloads, blocks=None, progress=flushed):
    summary = {'kind': 'CQRS_LIST_MATCHED_KAGGLE_V1', 'study': STUDY, 'run': run, 'mode': mode, 'workloads': workloads,
               'blocks': blocks, 'status': 'FAIL', 'resourceClass': 'kaggle_shared_envelope', 'isolationClaimed': False}
    study = Study(source, private, output, run, mode=mode, workloads=workloads, blocks=blocks, progress=progress)
    stages = [('fresh-environment-profile', study.profile_environment), ('prerequisites', study.prerequisites),
              ('verified-build-o-ab', study.build), ('profile-and-hashes', study.record_profile)]
    current = None
    try:
        for name, work in stages:
            current = name
            receipt = {'stage': name, 'startedAtUtc': datetime.now(timezone.utc).isoformat()}
            study.stages.append(receipt); progress(json.dumps({'stage': name}))
            try:
                work(); receipt['status'] = 'PASS'
            except Exception as error:
                receipt.update(status='FAIL', errorType=type(error).__name__); raise
            finally:
                receipt['finishedAtUtc'] = datetime.now(timezone.utc).isoformat(); write_json(study.reports / 'stages.json', study.stages)
        current = 'readiness-smoke'; progress(json.dumps({'stage': current}))
        readiness = study.readiness()
        summary['readiness'] = readiness['status']
        if mode == 'full' and readiness['status'] == 'READY_FOR_FULL_BLOCKS':
            current = 'full-blocks'; progress(json.dumps({'stage': current, 'blocks': blocks}))
            summary['blocks'] = study.full()
        summary['evaluation'] = study.evaluate().get('decision')
        summary['status'] = readiness['status'] if mode == 'smoke' else 'BLOCKS_RECORDED' if all(v == 'COMPLETE' for v in summary.get('blocks', {}).values()) and summary.get('blocks') else 'STOPPED'
    except Exception as error:
        summary.update(failedStage=current, errorType=type(error).__name__, error=str(error)[:200])
    write_json(study.reports / 'summary.json', summary)
    summary['download'] = export(study.reports, Path(output), summary)
    return summary


SECRET = __import__('re').compile(r'(postgresql|amqp|redis)://|BEGIN (RSA )?PRIVATE KEY|"password"|Bearer [A-Za-z0-9]')
PUBLIC = ('summary.json', 'stages.json', 'environment.json', 'plan-and-hashes.json', 'fresh-profile-and-pid-role-pool-ledger.json',
          'calibration.json', 'calibration-resource.jsonl', 'readiness.json', 'all-trial-outcomes.json', 'evaluation.json')
MEMBER_FILES = ('member-report.json', 'requests.jsonl', 'event-loop-probe.jsonl', 'window.json', 'load-final.json', 'generator.json',
                'cpu-window.json', 'resource-raw.jsonl')


def export(reports, output, summary):
    """Positive allowlist; no logs, contexts, URLs, credentials or fixtures."""
    import zipfile
    names = [n for n in PUBLIC if (reports / n).is_file()]
    members = reports / 'members'
    if members.is_dir():
        names += [f'members/{d.name}/{n}' for d in sorted(members.iterdir()) if d.is_dir() for n in MEMBER_FILES if (d / n).is_file()]
    entries = []
    for name in names:
        source = reports / name
        if source.is_symlink() or not source.resolve().is_relative_to(reports.resolve()):
            raise RuntimeError('LIST_EXPORT_PATH')
        data = source.read_bytes()
        if SECRET.search(data.decode('utf-8', 'replace')):
            raise RuntimeError('LIST_SECRET_PATTERN_IN_' + name)
        target = output / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
        entries.append({'path': name, 'bytes': len(data), 'sha256': digest(data)})
    write_json(output / 'result-manifest.json', {'study': STUDY, 'run': summary['run'], 'files': entries})
    archive = output.with_suffix('.zip')
    with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED) as z:
        for entry in entries:
            z.write(output / entry['path'], entry['path'])
        z.write(output / 'result-manifest.json', 'result-manifest.json')
    return str(archive)
