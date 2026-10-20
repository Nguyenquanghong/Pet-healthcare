import ast
import csv
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(HERE))
# Avoid the identically named phase-1 command-line runner in mixed discovery.
spec = importlib.util.spec_from_file_location('phase2_pcn_runner', HERE/'pcn_runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
from pcn_adapter import collection, contract_error, request_headers
from make_pcn_notebook import build, FILES


def full_load():
    names = ['GET pets', 'GET appointments', 'GET medical by pet', 'GET hotel',
             'GET invoices', 'GET notifications', 'POST appointment', 'POST rescue report']
    return {'completed': True, 'requests': 1000, 'started_requests': 1000, 'failures': 0,
            'observed_user_min': 100, 'observed_user_max': 100, 'measured_seconds': 1800,
            'error_rate': 0, 'endpoints': [{'name': name, 'requests': 125, 'p95_ms': 100,
                                          'within_2s_success_ratio': 1} for name in names]}


class PcnComparisonTests(unittest.TestCase):
    def test_full_configuration_matches_phase1_and_smoke_cannot_pass(self):
        self.assertEqual(runner.configuration('full'), {'users': 100, 'seconds': 1800, 'warmup': 30, 'spawn_rate': 10})
        with self.assertRaises(ValueError): runner.configuration('unknown')
        for change in ({'measured_seconds': 1799}, {'observed_user_min': 99}, {'completed': False}):
            data = {**full_load(), **change}
            result = runner.verdict(data, {'requests': 1000, 'failures': 0}, kaggle=True, runtime_ok=True)
            self.assertEqual(result['load_status'], 'PARTIAL')
        result = runner.verdict(full_load(), {'requests': 1000, 'failures': 0}, kaggle=False, runtime_ok=True)
        self.assertEqual(result['load_status'], 'PARTIAL')

    def test_phase1_thresholds_and_missing_evidence_cannot_become_pass(self):
        data = full_load()
        result = runner.verdict(data, {'requests': 1000, 'failures': 0}, kaggle=True, runtime_ok=True)
        self.assertEqual(result['load_status'], 'PASS_IN_SCOPE')
        self.assertEqual(result['overall'], 'PARTIAL')
        self.assertFalse(result['capacity_accepted'])
        self.assertTrue(all(result['requirements'][f'PCN{i:02}']['status'] == 'NOT_RUN' for i in range(3, 8)))
        for http, runtime_ok in (({'requests': 999, 'failures': 0}, True), ({'requests': 1000, 'failures': 0}, False)):
            self.assertEqual(runner.verdict(data, http, kaggle=True, runtime_ok=runtime_ok)['load_status'], 'FAIL')
        data['endpoints'][0]['within_2s_success_ratio'] = .949
        self.assertEqual(runner.verdict(data, {'requests': 1000, 'failures': 0}, kaggle=True, runtime_ok=True)['load_status'], 'FAIL')
        data = full_load(); data.update(error_rate=.011, failures=11)
        result = runner.verdict(data, {'requests': 1000, 'failures': 11}, kaggle=True, runtime_ok=True)
        self.assertEqual(result['requirements']['PCN02']['status'], 'FAIL')
        data = full_load(); data['endpoints'][0]['p95_ms'] = 2001
        self.assertEqual(runner.verdict(data, {'requests': 1000, 'failures': 0}, kaggle=True, runtime_ok=True)['load_status'], 'FAIL')

    def test_contract_adapter_preserves_ownership_and_requires_unique_create_key(self):
        self.assertEqual(collection({'items': [{'id': 'pet'}]}), [{'id': 'pet'}])
        for body in ([{'id': 'pet'}], {'items': [{'id': 'pet'}]}):
            self.assertIsNone(contract_error('GET', 'GET pets', body, 'pet'))
        for body in ({'items': [{'id': 'foreign'}]}, {'error': 'unavailable'}, 'bad-json'):
            self.assertIsNotNone(contract_error('GET', 'GET pets', body, 'pet'))
        self.assertIsNotNone(contract_error('POST', 'POST appointment', {'appointment': {'petId': 'foreign'}}, 'pet'))
        self.assertNotEqual(request_headers('POST', 'POST appointment'), request_headers('POST', 'POST appointment'))
        self.assertEqual(request_headers('POST', 'POST rescue report'), {})

    def test_locust_nonzero_for_acceptable_http_errors_does_not_tighten_pcn(self):
        self.assertTrue(runner.generator_ok(1, {'failures': 1}, 0))
        self.assertFalse(runner.generator_ok(1, {'failures': 0}, 0))
        self.assertFalse(runner.generator_ok(1, {'failures': 1}, 1))
        self.assertFalse(runner.generator_ok(2, {'failures': 1}, 0))
        data = full_load(); data.update(failures=5, error_rate=.005)
        result = runner.verdict(data, {'requests': 1000, 'failures': 5}, kaggle=True,
                                runtime_ok=runner.generator_ok(1, data, 0))
        self.assertEqual(result['load_status'], 'PASS_IN_SCOPE')

    def test_startup_failure_still_exports_sanitized_report(self):
        base = REPO/'test-results/phase2/pcn-unit-tests'; base.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as temporary:
            with patch.object(runner, 'NativeStack', side_effect=RuntimeError('secret-must-not-escape')):
                result = runner.run_pcn(REPO, Path(temporary)/'run', mode='smoke', progress=lambda _: None)
            self.assertEqual(result['overall'], 'FAIL')
            self.assertEqual(result['requirements']['PCN01']['status'], 'NOT_RUN')
            manifest = (Path(temporary)/'run/manifest.json').read_text()
            self.assertNotIn('secret-must-not-escape', manifest)
            self.assertEqual(json.loads(manifest)['failed_stage'], 'startup')

    def test_original_tasks_are_reused_without_weight_or_wait_changes(self):
        source = (HERE/'pcn_locust.py').read_text(encoding='utf-8')
        self.assertIn('PcnUser = legacy.PcnUser', source)
        tree = ast.parse((REPO/'benchmarks/kaggle/pcn_locustfile.py').read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'PcnUser')
        weights = {n.name: n.decorator_list[0].args[0].value for n in cls.body
                   if isinstance(n, ast.FunctionDef) and n.decorator_list}
        self.assertEqual(weights, dict(pets=4, appointments=2, medical=2, hotel=1, invoices=1, notifications=1, appointment=2, rescue=1))
        self.assertIn('wait_time = between(0.5, 1.5)', ast.unparse(cls))

    def test_notebook_compiles_and_embeds_exact_helpers_without_secret_output(self):
        historical = REPO/'benchmarks/phase2/phase2-pcn-kaggle.ipynb'
        original_hash = hashlib.sha256(historical.read_bytes()).hexdigest()
        output = REPO/'test-results/phase2/pcn-unit-tests'/str(uuid.uuid4())
        output.mkdir(parents=True, exist_ok=False)
        target = build(target=output/'notebook.ipynb')
        self.assertEqual(hashlib.sha256(historical.read_bytes()).hexdigest(), original_hash)
        notebook = json.loads(target.read_text(encoding='utf-8'))
        payload = None
        for cell in notebook['cells']:
            if cell['cell_type'] != 'code': continue
            code = ''.join(cell['source'])
            compile(code, str(target), 'exec')
            self.assertEqual(cell['outputs'], [])
            self.assertIsNone(cell['execution_count'])
            if code.startswith('BENCHMARK_OVERLAY = '):
                payload = ast.literal_eval(ast.parse(code).body[0].value)
        self.assertEqual(set(payload), set(FILES))
        for name, item in payload.items():
            self.assertEqual(item['text'], (REPO/name).read_text(encoding='utf-8'))
            self.assertEqual(item['sha256'], hashlib.sha256(item['text'].encode()).hexdigest())
        sources = '\n'.join(''.join(c['source']) for c in notebook['cells'] if c['cell_type'] == 'code')
        self.assertIn("MODE='full'", sources)
        self.assertIn("CLINIC_REPLICAS=1", sources)
        # Setup cannot reference imports removed when deriving from deep notebook.
        setup = next(''.join(c['source']) for c in notebook['cells'] if c['cell_type']=='code' and ''.join(c['source']).startswith('assert os.geteuid()'))
        self.assertNotIn('POLICY', setup)

    @unittest.skipUnless(importlib.util.find_spec('locust'), 'Install locust==2.44.4 to run real HTTP generator checks')
    def test_actual_locust_http_success_and_429_preserve_raw_denominator(self):
        base = REPO/'test-results/phase2/pcn-http-tests'
        base.mkdir(parents=True, exist_ok=True)
        state = {'limit': False, 'keys': [], 'writes': 0}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def reply(self, code, body):
                raw = json.dumps(body).encode()
                self.send_response(code); self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
            def do_GET(self):
                pet = self.headers.get('Authorization', '').removeprefix('Bearer token-')
                self.reply(429 if state['limit'] else 200, {'items': [{'id': 'pet-'+pet}]})
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
                if state['limit']:
                    self.reply(429, {'error': 'Rate limited'}); return
                if self.path == '/api/appointments':
                    key = self.headers.get('Idempotency-Key')
                    if not key:
                        self.reply(422, {'error': 'Missing key'}); return
                    state['keys'].append(key); state['writes'] += 1
                    self.reply(201, {'appointment': {'id': str(state['writes']), 'petId': body['petId']}})
                else:
                    self.reply(201, {'ok': True})

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with tempfile.TemporaryDirectory(dir=base) as temporary:
                root = Path(temporary)
                fixture = root/'fixture.json'
                fixture.write_text(json.dumps({'users': [{'petId': f'pet-{i}', 'token': f'token-{i}', 'qrToken': f'qr-{i}'} for i in range(10)]}))
                for limited in (False, True):
                    state['limit'] = limited
                    output = root/str(limited); output.mkdir()
                    env = {**os.environ, 'BENCH_FIXTURE': str(fixture), 'PCN_USERS': '10',
                           'PCN_DURATION': '4', 'PCN_WARMUP': '1', 'PCN_FINAL': str(output/'load-final.json'),
                           'PCN_RAW': str(output/'requests.jsonl'), 'PCN_HTTP': str(output/'http.csv'), 'PCN_WRITES': str(output/'writes.jsonl'),
                           'PCN_GENERATOR': str(output/'generator.json')}
                    with (output/'locust.log').open('w') as log:
                        process = subprocess.run([sys.executable, '-m', 'locust', '-f', str(HERE/'pcn_locust.py'),
                            '--headless', '--only-summary', '--host', f'http://127.0.0.1:{server.server_port}',
                            '--users', '10', '--spawn-rate', '10', '--stop-timeout', '12'], cwd=REPO,
                            env=env, stdout=log, stderr=subprocess.STDOUT, timeout=35)
                    self.assertTrue((output/'load-final.json').exists(), (output/'locust.log').read_text())
                    load = json.loads((output/'load-final.json').read_text())
                    http = runner.http_summary(output/'http.csv')
                    self.assertTrue(load['completed'])
                    self.assertEqual(load['started_requests'], load['requests'])
                    self.assertEqual(http['requests'], load['requests'])
                    self.assertEqual(http['failures'], load['failures'])
                    self.assertEqual(len((output/'requests.jsonl').read_text().splitlines()), load['requests'])
                    self.assertEqual(json.loads((output/'generator.json').read_text())['user_errors'], 0)
                    self.assertGreater(load['requests'], 10)
                    if limited:
                        self.assertEqual(http['http_429'], load['requests'])
                        self.assertEqual(load['error_rate'], 1)
                    else:
                        self.assertEqual(process.returncode, 0, (output/'locust.log').read_text())
                        self.assertEqual(load['failures'], 0)
                        self.assertGreater(state['writes'], 0)
                        self.assertEqual(len(state['keys']), len(set(state['keys'])))
                        self.assertEqual(len((output/'writes.jsonl').read_text().splitlines()), state['writes'])
                    for public in ('http.csv', 'requests.jsonl', 'load-final.json'):
                        self.assertNotIn('token-', (output/public).read_text())
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)


if __name__ == '__main__': unittest.main()
