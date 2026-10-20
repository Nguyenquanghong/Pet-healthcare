import ast
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from cqrs_baseline import run_baseline, smoke_passed
from make_cqrs_baseline import build, BASELINE, REPO
from make_pcn_notebook import build as build_pcn


def smoke_artifacts(path):
    path.mkdir()
    files = {'manifest.json': {'status': 'COMPLETE', 'mode': 'smoke', 'process_sample_errors': 0},
             'load-final.json': {'completed': True, 'requests': 12, 'started_requests': 12, 'failures': 0},
             'http-summary.json': {'requests': 12, 'failures': 0, 'http_429': 0, 'http_503': 0, 'transport_errors': 0},
             'generator.json': {'user_errors': 0}, 'reconciliation.json': {'status': 'PASS_IN_SCOPE'}}
    for name, value in files.items(): (path / name).write_text(json.dumps(value), encoding='utf-8')
    return {'load_status': 'PARTIAL', 'overall': 'PARTIAL'}


class BaselineTests(unittest.TestCase):
    def setUp(self):
        base = REPO / 'test-results/phase2/cqrs/pcn-workflow-tests'
        base.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=base)
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_fresh_full_follows_smoke_and_keeps_failed_full_verdict(self):
        calls = []
        def runner(repo, path, **kwargs):
            calls.append((path, kwargs))
            if kwargs['mode'] == 'smoke': return smoke_artifacts(path)
            path.mkdir()
            (path / 'manifest.json').write_text('{"status":"COMPLETE"}')
            return {'load_status': 'FAIL'}
        result = run_baseline(REPO, self.root / 'out', runner=runner)
        self.assertEqual([c[1]['mode'] for c in calls], ['smoke', 'full'])
        self.assertNotEqual(calls[0][0], calls[1][0])
        self.assertTrue(all(c[1]['replicas'] == 1 for c in calls))
        self.assertEqual(result['smoke_gate'], 'PASS')
        self.assertEqual(result['full'], 'FAIL')
        self.assertFalse(result['capacity_accepted'])

    def test_failed_smoke_never_starts_full(self):
        calls = []
        def runner(repo, path, **kwargs):
            calls.append(kwargs['mode'])
            result = smoke_artifacts(path)
            (path / 'reconciliation.json').write_text('{"status":"REVIEW_REQUIRED"}')
            return result
        result = run_baseline(REPO, self.root / 'out', runner=runner)
        self.assertEqual(calls, ['smoke'])
        self.assertEqual(result['full'], 'NOT_RUN')
        self.assertEqual(result['status'], 'STOPPED')

    def test_smoke_only_is_not_full_acceptance(self):
        result = run_baseline(REPO, self.root / 'out', full=False,
                              runner=lambda repo, path, **kw: smoke_artifacts(path))
        self.assertEqual(result['status'], 'SMOKE_ONLY')
        self.assertEqual(result['full'], 'NOT_RUN')

    def test_missing_bad_counts_errors_or_incomplete_evidence_fail_closed(self):
        changes = [('load-final.json', 'requests', 0), ('load-final.json', 'started_requests', 13),
                   ('load-final.json', 'completed', False), ('http-summary.json', 'failures', 1),
                   ('http-summary.json', 'http_429', 1), ('http-summary.json', 'http_503', 1),
                   ('http-summary.json', 'transport_errors', 1), ('generator.json', 'user_errors', 1),
                   ('manifest.json', 'status', 'FAILED'), ('manifest.json', 'process_sample_errors', 1)]
        for index, (name, key, value) in enumerate(changes):
            with self.subTest(name=name, key=key):
                path = self.root / str(index)
                result = smoke_artifacts(path)
                payload = json.loads((path / name).read_text()); payload[key] = value
                (path / name).write_text(json.dumps(payload))
                self.assertFalse(smoke_passed(path, result))
        path = self.root / 'missing'; result = smoke_artifacts(path)
        (path / 'generator.json').unlink()
        self.assertFalse(smoke_passed(path, result))

    def test_exceptions_are_sanitized_and_no_retry(self):
        calls = []
        def runner(repo, path, **kwargs):
            calls.append(kwargs['mode'])
            if kwargs['mode'] == 'smoke': return smoke_artifacts(path)
            raise RuntimeError('secret-not-for-artifacts')
        result = run_baseline(REPO, self.root / 'out', runner=runner)
        self.assertEqual(calls, ['smoke', 'full'])
        self.assertEqual(result['full'], 'FAIL')
        self.assertNotIn('secret-not-for-artifacts', (self.root / 'out/workflow.json').read_text())

    def test_notebook_pins_O_preserves_old_notebook_and_embeds_helpers(self):
        original = REPO / 'benchmarks/phase2/phase2-pcn-kaggle.ipynb'
        before = original.read_bytes()
        target = build(self.root / 'q0.ipynb')
        notebook = json.loads(target.read_text(encoding='utf-8'))
        code = []
        for cell in notebook['cells']:
            if cell['cell_type'] != 'code': continue
            source = ''.join(cell['source']); compile(source, str(target), 'exec'); code.append(source)
            self.assertEqual(cell['outputs'], [])
            if source.startswith('BENCHMARK_OVERLAY = '):
                payload = ast.literal_eval(ast.parse(source).body[0].value)
                self.assertIn('benchmarks/phase2/kaggle/cqrs_baseline.py', payload)
                for name, item in payload.items():
                    self.assertTrue(name.startswith(('benchmarks/kaggle/', 'benchmarks/phase2/kaggle/')))
                    self.assertEqual(item['text'], (REPO / name).read_text(encoding='utf-8'))
                    self.assertEqual(item['sha256'], hashlib.sha256(item['text'].encode()).hexdigest())
        combined = '\n'.join(code)
        self.assertIn(f"EXPECTED_COMMIT = '{BASELINE}'", combined)
        self.assertIn('RUN_FULL=True', combined)
        self.assertIn('workflow=run_baseline', combined)
        self.assertIn("('smoke','full')", combined)
        self.assertNotIn("OUTPUT/'run/", combined)
        self.assertEqual(before, original.read_bytes())

    def test_generator_rejects_ambiguous_commit_and_non_helper_overlay(self):
        with self.assertRaises(ValueError): build_pcn(base_commit='main', target=self.root / 'bad.ipynb')
        for name in ('backend/src/index.ts', '.env', 'benchmarks/kaggle/../../.env', 'benchmarks/kaggle/.env'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                build_pcn(target=self.root / 'bad.ipynb', extra_files=[name])
        self.assertFalse((self.root / 'bad.ipynb').exists())


if __name__ == '__main__':
    unittest.main()
