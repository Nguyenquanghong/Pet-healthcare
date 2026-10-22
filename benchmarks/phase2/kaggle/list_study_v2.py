"""cqrs-list-matched-kaggle-v2 controller: the v1 controller with v2 identity.

list_study.py (v1) is reused unchanged: this module rebinds its study, bundle,
policy and controller-file constants, and swaps in a Study subclass that runs a
MemberDiagnostics sampler beside each member. v1 halted on two failures whose
causes the result set could not show (outbox backlog, projected statement
timeouts); the sampler records exactly those signals. Diagnostic only, identical
for O/A/B, never used for grading. Imported only after the notebook verified
every source bundle member.
"""
import json
from pathlib import Path
import re
import subprocess
import sys
import threading
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import list_study as base  # noqa: E402

base.STUDY = 'cqrs-list-matched-kaggle-v2'
base.BUNDLE = 'test-results/phase2/cqrs/list-v2/cqrs-list-source-v10.zip'
base.BUNDLE_SHA = '08956163934b6b64016c7a86eca8285d9357c349e5bb544a40c5be5dedea3843'
base.POLICY = 'phase2-plan/cqrs/list-study/cqrs-list-matched-kaggle-v2.policy.json'
base.CONTROLLER = (*base.CONTROLLER, 'benchmarks/phase2/kaggle/list_study_v2.py', 'benchmarks/phase2/kaggle/make_list_policy_v2.py',
                   'benchmarks/phase2/kaggle/make_list_notebook_v2.py', 'benchmarks/phase2/kaggle/list_source_v2.py')
DIAGNOSTIC_FILES = ('diagnostics.jsonl', 'postgres-log.jsonl', 'clinic-read-diagnostics.jsonl')
base.MEMBER_FILES = (*base.MEMBER_FILES, *DIAGNOSTIC_FILES)
INTERVAL = 5
STACK_GLOB = 'pet-phase2-kaggle-*'
PG_KEEP = re.compile(r'checkpoint (starting|complete)|automatic (vacuum|analyze)|ERROR:|STATEMENT:|FATAL:|WARNING:|PANIC:')
OUTBOX = ('SELECT json_build_object(\'pending\', count(*), \'oldestSeconds\', extract(epoch FROM now()-min("createdAt"))) '
          'FROM "OutboxEvent" WHERE "publishedAt" IS NULL')
SERVER = ("SELECT json_build_object("
          "'activity', (SELECT coalesce(json_agg(a), '[]') FROM (SELECT backend_type, wait_event_type, wait_event, count(*) n "
          "FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state IS DISTINCT FROM 'idle' AND backend_type <> 'walwriter' "
          "GROUP BY 1, 2, 3) a), "
          "'checkpoints', (SELECT json_build_object('timed', checkpoints_timed, 'requested', checkpoints_req, "
          "'writeMs', checkpoint_write_time, 'syncMs', checkpoint_sync_time, 'buffers', buffers_checkpoint) FROM pg_stat_bgwriter))")


def read_diagnostic(line, instance):
    if 'CLINIC_READ_DIAGNOSTIC {' not in line:
        return None
    try:
        value = json.loads(line.split('CLINIC_READ_DIAGNOSTIC ', 1)[1])
    except ValueError:
        return {'instance': instance, 'unparsed': True}
    return {'instance': instance, **value} if isinstance(value, dict) else {'instance': instance, 'unparsed': True}


def clean(line):
    """Never let one log line break the allowlisted export (base.SECRET)."""
    return {'redacted': True} if base.SECRET.search(line) else None


class MemberDiagnostics:
    """Samples the member's private stack while it runs and tails its logs.

    The stack directory is deleted at teardown, so logs are read incrementally
    on every tick. Reads use the admin socket (trust auth, postgres role) the
    harness already uses; nothing is written to the stack.
    """

    def __init__(self, out, existing, env):
        self.out, self.existing, self.env = Path(out), set(existing), env
        self.stop_event, self.offsets, self.errors = threading.Event(), {}, 0
        self.thread = threading.Thread(target=self.loop, daemon=True)

    def start(self):
        self.out.mkdir(parents=True, exist_ok=True)
        self.thread.start()
        return self

    def stop(self):
        self.stop_event.set(); self.thread.join(timeout=30)
        with (self.out / 'diagnostics.jsonl').open('a', encoding='utf-8') as handle:
            handle.write(json.dumps({'event': 'sampler-stopped', 'errors': self.errors}) + '\n')

    def stack(self):
        found = [p for p in Path('/tmp').glob(STACK_GLOB) if p.is_dir() and p.name not in self.existing]
        return max(found, key=lambda p: p.stat().st_mtime) if found else None

    def psql(self, directory, port, database, sql):
        result = subprocess.run(['psql', '-h', str(directory), '-p', port, '-U', 'postgres', '-d', database, '-Atq', '-c', sql],
                                capture_output=True, text=True, timeout=4, env=self.env)
        if result.returncode:
            raise RuntimeError('PSQL')
        return json.loads(result.stdout.strip().replace('\n', ' '))

    def tail(self, path, target, keep):
        offset = self.offsets.get(path, 0)
        try:
            with path.open('rb') as handle:
                handle.seek(offset); data = handle.read()
        except OSError:
            return
        complete = data.rfind(b'\n') + 1
        self.offsets[path] = offset + complete
        rows = []
        for raw in data[:complete].decode('utf-8', 'replace').splitlines():
            item = keep(raw)
            if item is not None:
                rows.append(clean(raw) or item)
        if rows:
            with (self.out / target).open('a', encoding='utf-8') as handle:
                handle.writelines(json.dumps(r, ensure_ascii=False) + '\n' for r in rows)

    def tick(self, stack):
        sample = {'monotonicMs': time.monotonic() * 1000, 'wallMs': time.time() * 1000}
        socket = next(iter(stack.glob('.s.PGSQL.*[0-9]')), None)
        if socket:
            port = socket.name.rsplit('.', 1)[1]
            for name, database in (('clinicOutbox', 'p8_clinic'), ('coreOutbox', 'p8_core')):
                try: sample[name] = self.psql(stack, port, database, OUTBOX)
                except Exception: self.errors += 1; sample[name] = None
            try: sample['server'] = self.psql(stack, port, 'postgres', SERVER)
            except Exception: self.errors += 1; sample['server'] = None
        with (self.out / 'diagnostics.jsonl').open('a', encoding='utf-8') as handle:
            handle.write(json.dumps(sample) + '\n')
        self.tail(stack / 'postgres.log', 'postgres-log.jsonl',
                  lambda line: {'line': line[:2000]} if PG_KEEP.search(line) else None)
        for log in sorted(stack.glob('clinic-[0-9]*.log')):
            self.tail(log, 'clinic-read-diagnostics.jsonl', lambda line, n=log.stem: read_diagnostic(line, n))

    def loop(self):
        while not self.stop_event.is_set():
            try:
                stack = self.stack()
                if stack:
                    self.tick(stack)
            except Exception:
                self.errors += 1
            self.stop_event.wait(INTERVAL)


class Study(base.Study):
    def member(self, workload, block, configuration, mode, attempt):
        ident = f'{workload}-{mode}-b{block}-{configuration}' + ('-r' if attempt else '')
        existing = [p.name for p in Path('/tmp').glob(STACK_GLOB)]
        # list_trial creates the member directory itself (exist_ok=False): stage privately.
        staging = self.private / (ident + '-diagnostics')
        diagnostics = MemberDiagnostics(staging, existing, self.env).start()
        try:
            return super().member(workload, block, configuration, mode, attempt)
        finally:
            diagnostics.stop()
            out = self.reports / 'members' / ident
            if out.is_dir():
                for name in DIAGNOSTIC_FILES:
                    if (staging / name).is_file():
                        (out / name).write_bytes((staging / name).read_bytes())


base.Study = Study
run_study = base.run_study
