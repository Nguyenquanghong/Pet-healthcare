"""Offline checks for the M/H bridge study: booking grid, ABBA grading, member metrics, archive validation."""
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bridge_study as bs  # noqa: E402
import make_bridge_notebook as nb  # noqa: E402


def member(p95, cpu=0.5, valid=True):
    ops = {name: {'p95_ms': p95, 'p50_ms': p95 / 2, 'mean_response_bytes': 100} for name in ('GET pets', 'POST appointment')}
    return {'valid': valid, 'reasons': [] if valid else ['x'], 'operations': ops, 'p50_ms': p95 / 2, 'p95_ms': p95,
            'success_rps': 90.0, 'server_cores': cpu, 'cpu_ms_per_success': cpu * 1000 / 90, 'server_rss_mb': 300.0}


class Grading(unittest.TestCase):
    def test_linear_drift_cancels_in_abba(self):
        # True H/M = 1.2; the host slows 10% per member position.
        drift = lambda position: 1.1 ** position
        members = [member(10 * drift(0)), member(12 * drift(1)), member(12 * drift(2)), member(10 * drift(3))]
        result = bs.compare(members)
        self.assertEqual(result['decision'], 'COMPARED')
        self.assertAlmostEqual(result['operations']['GET pets']['p95_ratio'], 1.2, places=9)
        self.assertEqual(result['operations']['GET pets']['reading'], 'H chậm hơn')

    def test_bands_are_fixed(self):
        self.assertEqual(bs.band(0.9), 'H nhanh hơn')
        self.assertEqual(bs.band(1.0), 'tương đương')
        self.assertEqual(bs.band(1.1), 'H chậm hơn')

    def test_invalid_member_blocks_comparison(self):
        result = bs.compare([member(10), member(10, valid=False), member(10), member(10)])
        self.assertEqual(result['decision'], 'INVALID')
        self.assertEqual(bs.compare([member(10)])['decision'], 'NOT_RUN')

    def test_cpu_ratio(self):
        result = bs.compare([member(10, 0.5), member(10, 1.0), member(10, 1.0), member(10, 0.5)])
        self.assertAlmostEqual(result['overall_ratios_H_over_M']['cpu_ms_per_success'], 2.0)
        self.assertEqual(result['cpu_per_success_reading'], 'H chậm hơn')


class MemberMetrics(unittest.TestCase):
    def write(self, directory, *, users=2, completed=True, missing=0):
        settings = {'users': users, 'seconds': 30, 'warmup': 2, 'spawn_rate': 10}
        d = Path(directory)
        (d / 'manifest.json').write_text(json.dumps({'status': 'COMPLETE', 'process_sample_errors': 0}))
        (d / 'pcn-report.json').write_text(json.dumps({'raw_counts_match': True, 'success_rps': 2.0, 'load_status': 'PASS_IN_SCOPE'}))
        (d / 'load-final.json').write_text(json.dumps({'completed': completed, 'observed_user_min': users, 'error_rate': 0.0}))
        (d / 'reconciliation.json').write_text(json.dumps({'missing_success_ids': missing, 'duplicate_active_slots': 0,
                                                           'duplicate_response_ids': 0, 'unexpected_child_exit': False,
                                                           'writes_without_success_response': 0}))
        rows = [{'name': 'GET pets', 'response_time_ms': float(ms), 'failed': False, 'response_bytes': 50} for ms in range(1, 101)]
        (d / 'requests.jsonl').write_text('\n'.join(json.dumps(r) for r in rows) + '\n')
        samples = []
        for t in range(60):
            for component, cpu in (('core', 20.0), ('postgres', 10.0), ('generator', 90.0)):
                samples.append({'component': component, 'monotonic_s': float(t), 'cpu_percent_one_core': None if t == 0 else cpu,
                                'rss_bytes_sum': 2**20})
        (d / 'resources.jsonl').write_text('\n'.join(json.dumps(s) for s in samples) + '\n')
        return settings

    def test_metrics_exclude_generator_and_ramp(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = self.write(directory)
            m = bs.member_metrics(directory, settings)
            self.assertTrue(m['valid'], m['reasons'])
            self.assertEqual(m['operations']['GET pets']['p95_ms'], 95.0)
            self.assertEqual(m['operations']['GET pets']['p50_ms'], 50.0)
            self.assertAlmostEqual(m['server_cores'], 0.3)
            self.assertAlmostEqual(m['cpu_ms_per_success'], 150.0)
            self.assertAlmostEqual(m['server_rss_mb'], 2.0)

    def test_reconciliation_and_population_invalidate(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = self.write(directory, missing=1, completed=False)
            m = bs.member_metrics(directory, settings)
            self.assertFalse(m['valid'])
            self.assertIn('reconciliation missing_success_ids', m['reasons'])
            self.assertIn('window not completed', m['reasons'])


class Booking(unittest.TestCase):
    def test_grid_slots_are_distinct_and_on_the_p10_grid(self):
        try:
            import locust  # noqa: F401
        except ImportError:
            self.skipTest('locust not installed')
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / 'fixture.json'
            fixture.write_text(json.dumps({'users': [{'token': 't', 'petId': 'p', 'qrToken': 'q'}] * 100}))
            os.environ['BENCH_FIXTURE'] = str(fixture)
            import bridge_locust as bl
            slots = [bl.booking(i) for i in range(20000)]
        self.assertEqual(len(set(slots)), len(slots))
        times = {t for _, t in slots}
        self.assertEqual(min(times), '08:00')
        self.assertEqual(max(times), '17:00')
        self.assertTrue(all(t[3:] in ('00', '30') for t in times))
        weights = {}
        for task in bl.PcnUser.tasks:
            weights[task.__name__] = weights.get(task.__name__, 0) + 1
        self.assertEqual(weights, {'pets': 4, 'appointments': 2, 'medical': 2, 'hotel': 1, 'invoices': 1,
                                   'notifications': 1, 'appointment': 2, 'rescue': 1})
        self.assertIs(dict((t.__name__, t) for t in bl.PcnUser.tasks)['appointment'], bl.appointment)


class Archive(unittest.TestCase):
    def archive(self, files):
        listing = [{'path': k, 'bytes': len(v), 'sha256': hashlib.sha256(v).hexdigest()} for k, v in sorted(files.items())]
        manifest = {'format': nb.FORMAT, 'files': listing,
                    'treeSha256': hashlib.sha256(json.dumps(listing, separators=(',', ':')).encode()).hexdigest()}
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as z:
            z.writestr('bundle-manifest.json', json.dumps(manifest))
            for k, v in files.items():
                z.writestr(k, v)
        raw = buffer.getvalue()
        return raw, hashlib.sha256(raw).hexdigest()

    def test_accepts_clean_and_rejects_unsafe(self):
        raw, sha = self.archive({'M/backend/a.ts': b'a', 'H/services/b.ts': b'b'})
        manifest, values = nb.verified_members(raw, sha)
        self.assertEqual(set(values), {'M/backend/a.ts', 'H/services/b.ts'})
        with self.assertRaises(ValueError):
            nb.verified_members(raw, '0' * 64)
        for bad in ('X/a.ts', 'H/../a.ts', 'H/.env', 'H/node_modules/x.js'):
            raw, sha = self.archive({bad: b'x'})
            with self.assertRaises(ValueError):
                nb.verified_members(raw, sha)


if __name__ == '__main__':
    unittest.main()
