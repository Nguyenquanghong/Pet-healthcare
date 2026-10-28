import ast
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from query_heavy import CONFIG, OPERATIONS, QueryClient, healthy, measure, run_workflow, run_trial, valid_response, preflight, validate_profile, limiter_headers
from make_query_notebook import build, REPO, BASELINE
from native_stack import NativeStack


def reader_contract_dependencies_match_baseline():
    """query_reader_contract.mjs byte-compares these working-tree Clinic files with the pinned baseline (CRLF-insensitive)."""
    for name in ('domain/error.ts', 'domain/validation.ts', 'lib/serialize.ts'):
        path = 'services/clinic/src/' + name
        try:
            pinned = subprocess.run(['git', 'show', BASELINE + ':' + path], cwd=REPO, capture_output=True, check=True).stdout
            current = (REPO / path).read_bytes()
        except (OSError, subprocess.CalledProcessError):
            return False
        if pinned.replace(b'\r\n', b'\n') != current.replace(b'\r\n', b'\n'):
            return False
    return True


def owner_page():
    return {'items': [{'id': str(i), 'ownerId': 'owner-a'} for i in range(20)],
            'pagination': {'page': 1, 'pageSize': 20, 'total': 1000, 'totalPages': 50},
            'counts': {**dict(zip(('pending','confirmed','checked_in','in_progress','completed','cancelled','no_show'), (143,143,143,143,143,143,142))), 'billingHeld': 20},
            'related': {'owners': [{'id': 'owner-a'}], 'pets': [{'id': 'pet-a', 'ownerId': 'owner-a'}]}}


class QueryTests(unittest.TestCase):
    def setUp(self):
        root = REPO / 'test-results/phase2/cqrs/query-notebook-tests'
        root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=root)
        self.path = Path(self.temp.name)

    def tearDown(self):
        assert self.path.resolve().is_relative_to((REPO / 'test-results/phase2/cqrs/query-notebook-tests').resolve())
        self.temp.cleanup()

    def test_owner_scope_redaction_and_counts_are_not_status_only_checks(self):
        actor = {'id': 'owner-a'}
        self.assertTrue(valid_response('owner-list', owner_page(), actor))
        for change in ('scope', 'note', 'total', 'related', 'empty'):
            body = owner_page()
            if change == 'scope': body['items'][0]['ownerId'] = 'owner-b'
            if change == 'note': body['items'][0]['internalNote'] = 'PRIVATE'
            if change == 'total': body['pagination']['total'] = 2000
            if change == 'related': body['related']['owners'].append({'id': 'owner-b'})
            if change == 'empty': body['items'] = []
            self.assertFalse(valid_response('owner-list', body, actor), change)

    def test_calendar_checks_each_date_not_just_total(self):
        calendar = {f'2028-02-{n:02d}': 48 for n in range(1, 21)}
        calendar['2028-02-21'] = 40
        self.assertTrue(valid_response('owner-calendar', calendar, {}))
        self.assertTrue(valid_response('admin-calendar', {k: v*100 for k,v in calendar.items()}, {}))
        calendar['2028-02-01'] -= 1; calendar['2028-02-02'] += 1
        self.assertFalse(valid_response('owner-calendar', calendar, {}))

    def test_unbilled_and_filter_keep_base_status_counts(self):
        body = owner_page()
        body['counts'] = {'completed': 13700, 'billingHeld': 300}
        body['pagination'].update(total=13700, totalPages=685)
        self.assertTrue(valid_response('admin-unbilled', body, {}))
        body['counts']['completed'] = 14300  # must exclude HELD/INVOICED
        self.assertFalse(valid_response('admin-unbilled', body, {}))
        # Independent fixture enumeration: first 48 slots, spa types 6,7,8.
        chosen = [n for n in range(48) if n % 10 in (6,7,8)]
        statuses = ('pending','confirmed','checked_in','in_progress','completed','cancelled','no_show')
        body['counts'] = {s: sum(n % 7 == i for n in chosen)*100 for i,s in enumerate(statuses)}
        body['counts'] = {k:v for k,v in body['counts'].items() if v}
        body['counts']['billingHeld'] = 0
        total = sum(n % 7 < 4 for n in chosen)*100
        body['pagination'].update(total=total, totalPages=(total+19)//20)
        self.assertTrue(valid_response('admin-filter', body, {}))

    def test_billing_held_is_required_and_wrong_value_cannot_pass(self):
        for value in (None, 0, 21):
            body = owner_page()
            if value is None: del body['counts']['billingHeld']
            else: body['counts']['billingHeld'] = value
            self.assertFalse(valid_response('owner-list', body, {'id': 'owner-a'}))

    @unittest.skipUnless(reader_contract_dependencies_match_baseline(),
                         'pinned O reader oracle needs domain/error.ts, domain/validation.ts and lib/serialize.ts identical to baseline 3e88d7e; '
                         'they changed on main in 080aedf, ac1b8ef, 570ab0b, 62953f0 and 31a7429 (drift from the pinned baseline, not a removed file)')
    def test_validator_accepts_actual_pinned_reader_contract_for_all_operations(self):
        result = subprocess.run(['node', str(REPO/'benchmarks/phase2/kaggle/query_reader_contract.mjs')],
                                cwd=REPO, capture_output=True, text=True, encoding='utf-8', check=True, timeout=60)
        oracle = json.loads(result.stdout)
        self.assertEqual(oracle['baselineSha'], BASELINE); self.assertEqual(oracle['rows'], 100000)
        self.assertEqual({r['operation'] for r in oracle['results']}, set(OPERATIONS))
        for result in oracle['results']:
            self.assertTrue(valid_response(result['operation'], result['body'], result['actor']), result['operation'])
            if 'counts' in result['body']:
                damaged = copy.deepcopy(result['body']); damaged['counts']['billingHeld'] += 1
                self.assertFalse(valid_response(result['operation'], damaged, result['actor']))

    def test_preflight_diagnostics_preserve_status_and_counts_without_private_payload(self):
        client = QueryClient.__new__(QueryClient)
        client.actors = [{'id': 'owner-a', 'token': 'SECRET'}, {'id': 'owner-b', 'token': 'SECRET'}]
        body = owner_page(); body['counts']['billingHeld'] = 99; body['token'] = 'SECRET'
        body['counts']['password'] = 'SECRET'; body['pagination']['extra'] = 'SECRET'
        with patch.object(client, 'request', return_value=(200, body, {})):
            checks = preflight(client)
        self.assertEqual(len(checks), 1); self.assertFalse(checks[0]['valid'])
        self.assertEqual(checks[0]['counts']['billingHeld'], 99)
        self.assertNotIn('SECRET', json.dumps(checks)); self.assertNotIn('owner-a', json.dumps(checks))

    def test_http_failures_and_malformed_success_are_preserved(self):
        client = QueryClient.__new__(QueryClient)
        client.actors = [{'id': 'owner-a', 'token': 'synthetic'}]
        client.admin_token = 'synthetic'; client.paths = ['/']*8
        for status, payload, expected in [(429, {}, 'overload'), (503, {}, 'overload'), (403, {}, 'http_error'),
                                          (200, {'items': []}, 'contract_error'), (200, owner_page(), 'success')]:
            with patch.object(client, 'request', return_value=(status, payload, {})):
                row = client.read(0)
                self.assertEqual(row['status'], status); self.assertEqual(row['outcome'], expected)

    def test_dropped_arrival_keeps_intended_operation_and_fails_gate(self):
        row = {'sequence': 2, 'operation': 'generator.drop', 'sent': False, 'outcome': 'generator_drop', 'status': 0,
               'latency_ms': 0, 'lag_ms': 100, 'total_ms': 100}
        with patch('query_heavy.open_loop', return_value={'rows': [row], 'generator_valid': False, 'seconds': 1}):
            result = measure(None, rate=24, seconds=1, concurrency=16)
        self.assertEqual(result['rows'][0]['operation'], 'admin-search')
        self.assertEqual(result['summary'][0]['not_sent'], 1)
        self.assertFalse(healthy(result, full=False))

    def test_protocol_budget_and_gate_do_not_accept_insufficient_or_failed_load(self):
        self.assertGreaterEqual(CONFIG['warmup'], 120)
        self.assertGreaterEqual(CONFIG['seconds'], 300)
        self.assertEqual(CONFIG['rate']*CONFIG['seconds']//len(OPERATIONS), 1200)
        good = {'generator_valid': True, 'seconds': 400, 'rows': [{'outcome': 'success'}],
                'summary': [{'success': 1200, 'threshold_result': 'PASS_IN_SCOPE'} for _ in OPERATIONS]}
        self.assertTrue(healthy(good, full=True))
        for change in ('sample', 'latency', 'error', 'generator'):
            bad = copy.deepcopy(good)
            if change == 'sample': bad['summary'][0]['success'] = 999
            if change == 'latency': bad['summary'][0]['threshold_result'] = 'FAIL'
            if change == 'error': bad['rows'].append({'outcome': 'http_error'})
            if change == 'generator': bad['generator_valid'] = False
            self.assertFalse(healthy(bad, full=True), change)

    def test_actor_budget_rejects_failed_v1_and_v2_keeps_sample_count(self):
        validate_profile(CONFIG)
        with self.assertRaises(ValueError): validate_profile({**CONFIG, 'rate': 24})
        self.assertEqual(CONFIG['rate']*60*6/8, 540)
        self.assertEqual(CONFIG['rate']*CONFIG['seconds']/8, 1200)
        # Simulate the same fixed-window bucket across warmup and full measurement.
        for rate, seconds, expected_rejects in [(24,120,960),(12,CONFIG['warmup']+CONFIG['seconds'],0)]:
            expiry, used, rejected = -1, 0, 0
            for i in range(rate*seconds):
                if not OPERATIONS[i%8].startswith('admin-'): continue
                at = i/rate
                if at >= expiry: expiry, used = at+60, 0
                if used >= 600: rejected += 1
                else: used += 1
            self.assertEqual(rejected, expected_rejects)

    def test_limiter_diagnostics_only_export_bounded_numeric_headers(self):
        self.assertEqual(limiter_headers({'RateLimit-Limit':'600','ratelimit-remaining':'0','Retry-After':'27',
                                        'Authorization':'PRIVATE','Set-Cookie':'PRIVATE'}),
                         {'limit':600,'remaining':0,'retry_after_seconds':27})
        self.assertEqual(limiter_headers({'Retry-After':'PRIVATE'})['retry_after_seconds'], None)

    def test_query_profile_rejects_wrong_scope_before_native_setup(self):
        with patch('native_stack.platform.system', return_value='Linux'):
            for accounts, replicas in [(99,1),(100,2)]:
                with self.assertRaises(ValueError):
                    NativeStack(REPO, accounts=accounts, replicas=replicas, dataset_profile='query-heavy')

    def test_workflow_runs_three_fresh_trials_and_stops_at_first_failure(self):
        calls = []
        def runner(repo, output, **kw):
            calls.append(output.name)
            return {'status': 'SMOKE_PASS' if kw['mode']=='smoke' else 'BASELINE_RUN_RECORDED', 'run': output.name}
        report = run_workflow(REPO, self.path/'good', runner=runner)
        self.assertEqual(calls, ['smoke','run-1','run-2','run-3'])
        self.assertEqual(report['status'], 'BASELINE_O_RECORDED')
        self.assertFalse(report['capacity_accepted'])
        calls.clear()
        def fail(repo, output, **kw):
            calls.append(output.name)
            return {'status': 'SMOKE_PASS' if kw['mode']=='smoke' else 'FAIL'}
        self.assertEqual(run_workflow(REPO, self.path/'bad', runner=fail)['status'], 'STOPPED')
        self.assertEqual(calls, ['smoke','run-1'])

    def test_smoke_failure_and_exception_never_start_full_or_export_error_message(self):
        calls = []
        def fail(*args, **kw):
            calls.append(kw['mode']); raise RuntimeError('postgresql://private-token')
        report = run_workflow(REPO, self.path/'exception', runner=fail)
        self.assertEqual(calls, ['smoke']); self.assertNotIn('private-token', json.dumps(report))
        self.assertEqual(report['status'], 'STOPPED')

    def test_notebook_pin_cells_overlay_and_export_allowlist(self):
        historical = [REPO/'benchmarks/phase2/phase2-pcn-kaggle.ipynb', REPO/'benchmarks/phase2/cqrs-q0-pcn-baseline.ipynb']
        before = [p.read_bytes() for p in historical]
        path = build(self.path/'query.ipynb')
        nb = json.loads(path.read_text(encoding='utf-8'))
        for cell in nb['cells']:
            if cell['cell_type']=='code': ast.parse(''.join(cell['source']))
        self.assertIn(BASELINE, ''.join(nb['cells'][1]['source']))
        overlay = ast.literal_eval(ast.parse(''.join(nb['cells'][5]['source'])).body[0].value)
        for name, item in overlay.items():
            self.assertTrue(name.startswith(('benchmarks/phase2/kaggle/', 'benchmarks/kaggle/')))
            self.assertEqual(hashlib.sha256(item['text'].encode()).hexdigest(), item['sha256'])
        self.assertIn('benchmarks/phase2/kaggle/query_dataset.mjs', overlay)
        export = ''.join(nb['cells'][11]['source'])
        self.assertNotIn('context.json', export); self.assertNotIn('ready.json', export)
        self.assertIn("'requests.jsonl'", export); self.assertIn("'run-3'", export)
        self.assertEqual(before, [p.read_bytes() for p in historical])

    def test_startup_failure_exports_raw_files_and_only_sanitized_error(self):
        with patch('query_heavy.NativeStack', side_effect=RuntimeError('postgresql://private-token')):
            result = run_trial(REPO, self.path/'trial', mode='smoke', progress=lambda text: None)
        self.assertEqual(result['status'], 'FAIL'); self.assertEqual(result['failed_stage'], 'startup')
        for path in (self.path/'trial').iterdir():
            self.assertNotIn('private-token', path.read_text())
        self.assertEqual(set(result['hashes']), {'requests.jsonl','resources.jsonl','database.jsonl'})

    def test_export_cell_omits_private_files_and_keeps_failed_trial(self):
        import contextlib
        import io
        from zipfile import ZipFile
        notebook = json.loads(build(self.path/'export.ipynb').read_text(encoding='utf-8'))
        output = self.path/'result'
        (output/'trials/smoke').mkdir(parents=True)
        (output/'context.json').write_text('PRIVATE')
        (output/'trials/smoke/ready.json').write_text('PRIVATE')
        (output/'trials/smoke/report.json').write_text('{"status":"FAIL"}')
        (output/'trials/smoke/requests.jsonl').write_text('')
        namespace = {'OUTPUT': output, 'workflow': {'status': 'STOPPED'}, 'display': lambda value: None, 'FileLink': str}
        with contextlib.redirect_stdout(io.StringIO()):
            exec(''.join(notebook['cells'][11]['source']), namespace)
        with ZipFile(output.with_suffix('.zip')) as archive:
            self.assertEqual(set(archive.namelist()), {'trials/smoke/report.json','trials/smoke/requests.jsonl'})
            self.assertIn(b'FAIL', archive.read('trials/smoke/report.json'))


if __name__ == '__main__': unittest.main()
