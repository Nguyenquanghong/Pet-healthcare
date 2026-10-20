import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).parent))
from cqrs_source import REPO, make_plan, snapshot
from cqrs_benchmark import matrix, run
from cqrs_probe import read_evidence, correct_path, preflight
from query_heavy import QueryClient
from native_stack import NativeStack


class BenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.root = REPO / 'test-results/phase2/cqrs/benchmark-tests' / str(uuid4())
        self.root.mkdir(parents=True)
        policy = json.loads((REPO / 'phase2-plan/cqrs/acceptance.json').read_text())
        self.plan = make_plan(policy, {'O': snapshot({'old.ts': b'O'}), 'AB': snapshot({'new.ts': b'AB'})})

    def test_three_pairs_sequential_with_same_AB_root_and_no_capacity_claim(self):
        for workload in ('pcn', 'query-heavy'):
            calls = []
            def dispatch(root, output, item):
                calls.append((str(root), item['configuration'], item['pair'], item['phase']))
                return {'status': 'SMOKE_PASS' if item['phase'] == 'smoke' else 'BENCHMARK_RUN_RECORDED'}
            result = matrix({'O': Path('old'), 'AB': Path('current')}, self.root / workload,
                            self.plan, workload=workload, full=True, dispatch=dispatch)
            self.assertEqual(''.join(c[1] for c in calls), 'OABOOOABBAAB')
            self.assertTrue(all(c[0] == ('old' if c[1] == 'O' else 'current') for c in calls))
            self.assertEqual(result['status'], 'MEASUREMENTS_RECORDED')
            self.assertFalse(result['capacity_accepted']); self.assertFalse(result['deployment_accepted'])
            self.assertEqual(result['decision'], 'INCONCLUSIVE')

    def test_failure_stops_without_retry_or_later_pairs_and_keeps_first_result(self):
        calls = []
        def dispatch(root, output, item):
            calls.append(item['name'])
            return {'status': 'FAIL' if len(calls) == 2 else 'SMOKE_PASS'}
        result = matrix({'O': Path('old'), 'AB': Path('new')}, self.root / 'stop', self.plan,
                        workload='query-heavy', full=True, dispatch=dispatch)
        self.assertEqual(calls, ['smoke-O', 'smoke-A'])
        self.assertEqual(result['status'], 'STOPPED')
        self.assertEqual(result['trials'][-1]['status'], 'FAIL')

    def test_smoke_only_never_schedules_full_load(self):
        result = matrix({'O': Path('old'), 'AB': Path('new')}, self.root / 'smoke', self.plan,
                        workload='pcn', dispatch=lambda *args: {'status': 'SMOKE_PASS'})
        self.assertEqual(len(result['trials']), 3); self.assertEqual(result['status'], 'SMOKE_ONLY')

    def test_windows_records_blocker_before_source_extract_or_database_setup(self):
        with patch('cqrs_benchmark.platform.system', return_value='Windows'), patch('cqrs_benchmark.prepare') as prepare:
            result = run('missing.zip', '0' * 64, self.root / 'windows', workload='query-heavy')
        prepare.assert_not_called()
        self.assertEqual(result['status'], 'INVALID_ENVIRONMENT')
        self.assertEqual(result['measurements'], 'NOT_RUN')

    def test_exception_messages_do_not_export_private_urls(self):
        def dispatch(*args): raise RuntimeError('postgresql://PRIVATE:SECRET@server')
        result = matrix({'O': Path('old'), 'AB': Path('new')}, self.root / 'exception', self.plan,
                        workload='pcn', dispatch=dispatch)
        self.assertEqual(result['status'], 'STOPPED')
        self.assertNotIn('PRIVATE', json.dumps(result)); self.assertNotIn('SECRET', json.dumps(result))

    def test_response_headers_prove_path_and_generation_without_exporting_tokens(self):
        good = read_evidence({'x-clinic-read-source': 'projection', 'X-Clinic-Projection-Generation': 'g',
                              'X-Clinic-Read-Token': 'PRIVATE'}, 'g')
        self.assertTrue(correct_path('B', good)); self.assertNotIn('PRIVATE', json.dumps(good))
        self.assertFalse(correct_path('B', read_evidence({'X-Clinic-Read-Source': 'authoritative'})))
        self.assertFalse(correct_path('B', read_evidence({'X-Clinic-Read-Source': 'projection', 'X-Clinic-Projection-Generation': 'old'}, 'new')))
        self.assertTrue(correct_path('B', read_evidence({'X-Clinic-Read-Source': 'authoritative'}), unbilled=True))
        self.assertTrue(correct_path('O', read_evidence({})))
        self.assertFalse(correct_path('O', read_evidence({'X-Clinic-Read-Source': 'authoritative'})))

    def test_B_authoritative_fallback_cannot_be_counted_as_projected_query_success(self):
        client = QueryClient.__new__(QueryClient)
        client.actors = [{'id': 'a', 'token': 'fixture'}]; client.admin_token = 'fixture'; client.paths = ['/'] * 8
        client.cqrs = {'configuration': 'B', 'generation': 'g'}
        with patch.object(client, 'request', return_value=(200, {}, {'X-Clinic-Read-Source': 'authoritative'})), patch('query_heavy.valid_response', return_value=True):
            row = client.read(0)
        self.assertEqual(row['outcome'], 'contract_error'); self.assertEqual(row['read_source'], 'authoritative')

    def test_invalid_modes_rejected_before_creating_native_trial(self):
        with patch('native_stack.platform.system', return_value='Linux'), patch('native_stack.Path.mkdir') as mkdir:
            for mode, replicas, profile in [('shadow', 1, 'pcn'), ('B', 2, 'pcn'), ('A', 1, 'deep')]:
                with self.assertRaises(ValueError):
                    NativeStack(REPO, accounts=2, replicas=replicas, dataset_profile=profile, cqrs_configuration=mode)
        mkdir.assert_not_called()

    def test_preflight_checks_list_and_calendar_before_measurement(self):
        class Client:
            actors = [{'token': 'fixture'}]
            def __init__(self): self.paths = []
            def request(self, method, path, **kwargs):
                self.paths.append(path)
                return 200, {}, {'X-Clinic-Read-Source': 'projection', 'X-Clinic-Projection-Generation': 'g'}
        client = Client(); checks = preflight(client, 'B', 'g')
        self.assertEqual(len(checks), 2); self.assertIn('calendar', client.paths[1])


if __name__ == '__main__': unittest.main()
