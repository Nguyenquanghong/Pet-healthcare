"""Local pure checks for the D5 readiness notebook; never starts the native stack.

Fixtures live in a run-owned directory under test-results (inside the project)
and are removed afterwards.
"""
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sys
import types
import unittest
import uuid
import zipfile
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]


def module(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


with patch.dict(sys.modules, {'pwd': types.SimpleNamespace()} if sys.platform == 'win32' else {}):
    native = module('activity_d5_native')
builder = module('make_activity_d5_notebook')
FIXTURES = REPO / 'test-results/phase2/cqrs/activity/d5-20261021' / ('py-fixtures-' + uuid.uuid4().hex)


class D5Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        FIXTURES.mkdir(parents=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(FIXTURES)

    def test_paths_are_run_scoped(self):
        run = str(uuid.uuid4())
        with patch.object(native.Path, 'is_symlink', return_value=False), patch.object(native.Path, 'resolve', lambda self: self):
            native.validate_d5_paths(f'/tmp/clinic-activity-d5-{run}/source', f'/tmp/clinic-activity-d5-{run}', f'/kaggle/working/clinic-activity-d5-{run}', run)
            for args in ((f'/tmp/clinic-activity-d1-{run}/source', f'/tmp/clinic-activity-d1-{run}', f'/kaggle/working/clinic-activity-d5-{run}', run),
                         (f'/tmp/clinic-activity-d5-{run}/source', f'/tmp/clinic-activity-d5-{run}', '/kaggle/working/other', run),
                         ('/x', '/y', '/z', 'not-a-uuid')):
                with self.assertRaises(ValueError):
                    native.validate_d5_paths(*args)

    def test_environment_profile_reads_fresh_cgroup_v2_and_v1(self):
        proc, cg = FIXTURES / 'proc', FIXTURES / 'cgroup'
        proc.mkdir(); cg.mkdir()
        (proc / 'cpuinfo').write_text('processor : 0\nmodel name : Synthetic CPU @ 2.0GHz\n')
        (proc / 'meminfo').write_text('MemTotal:       32000000 kB\n')
        (proc / 'loadavg').write_text('0.1 0.2 0.3 1/100 42\n')
        (cg / 'cpu.max').write_text('400000 100000\n'); (cg / 'memory.max').write_text('34359738368\n'); (cg / 'cgroup.controllers').write_text('cpu memory\n')
        p = native.environment_profile(proc, cg)
        self.assertEqual((p['cpuModel'], p['cpuMax'], p['memoryMax'], p['memTotalBytes'], p['cgroupVersion']),
                         ('Synthetic CPU @ 2.0GHz', '400000 100000', '34359738368', 32000000 * 1024, 2))
        self.assertIn('NONE_CLAIMED', p['isolation'])
        v1 = FIXTURES / 'cgroup1'; (v1 / 'cpu').mkdir(parents=True); (v1 / 'memory').mkdir()
        (v1 / 'cpu/cpu.cfs_quota_us').write_text('-1\n'); (v1 / 'cpu/cpu.cfs_period_us').write_text('100000\n'); (v1 / 'memory/memory.limit_in_bytes').write_text('9223372036854771712\n')
        p1 = native.environment_profile(proc, v1)
        self.assertEqual((p1['cpuMax'], p1['memoryMax'], p1['cgroupVersion']), ('-1 100000', '9223372036854771712', 1))

    def test_bundle_round_trip_contains_runtime_sources_and_rejects_tampering(self):
        raw, manifest = builder.source_bundle()
        expected = builder.digest(raw)
        got, values = builder.verified_members(raw, expected)
        self.assertEqual(got['format'], 'clinic-activity-d5-readiness-source-v1')
        self.assertIs(got['performanceMeasurementsAllowed'], False)
        for name in builder.EXTRA + builder.REQUIRED:
            self.assertIn(name, values)
        self.assertEqual(got['policyAtBuildSha256'], builder.digest((REPO / 'phase2-plan/cqrs/clinic-activity/acceptance.frozen.json').read_bytes()))
        with self.assertRaises(ValueError):
            builder.verified_members(raw + b'x', expected)
        buffer = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(raw)) as src, zipfile.ZipFile(buffer, 'w') as dst:
            for info in src.infolist():
                data = src.read(info)
                if info.filename == 'source/tools/phase2/cqrs/activity/kaggleD5.mjs':
                    data += b'\n// tampered'
                dst.writestr(info, data)
        tampered = buffer.getvalue()
        with self.assertRaises(ValueError):
            builder.verified_members(tampered, builder.digest(tampered))
        for bad in ('../x', 'a/.git/b', 'x.pem', '.env', 'a\\b', 'node_modules/x'):
            with self.assertRaises(ValueError):
                builder.safe_source_path(bad)

    def test_export_allowlist_and_secret_guard(self):
        private, output = FIXTURES / 'private', FIXTURES / 'out'
        (private / 'reports').mkdir(parents=True); output.mkdir()
        (private / 'reports/readiness.json').write_text(json.dumps({'status': 'READY_FOR_POLICY_FREEZE_REVIEW'}))
        (private / 'reports/context.json').write_text('{"urls":"postgresql://secret"}')
        target = native.export_reports(private, output, {'status': 'x'}, 'a' * 64)
        with zipfile.ZipFile(target) as z:
            self.assertEqual(sorted(z.namelist()), ['readiness.json', 'result-manifest.json', 'summary.json'])
        leak, out2 = FIXTURES / 'leak', FIXTURES / 'out2'
        (leak / 'reports').mkdir(parents=True); out2.mkdir()
        (leak / 'reports/smoke.json').write_text('{"x":"amqp://d5:pw@127.0.0.1"}')
        with self.assertRaises(RuntimeError):
            native.export_reports(leak, out2, {'status': 'x'}, 'a' * 64)


if __name__ == '__main__':
    unittest.main()
