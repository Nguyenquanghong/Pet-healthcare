"""List study evaluator/policy/runner-helper tests on synthetic data only."""
import copy
import json
from pathlib import Path
import unittest

import list_evaluate as ev
import make_list_policy

POLICY = json.loads((make_list_policy.REPO / 'phase2-plan/cqrs/list-study/cqrs-list-matched-kaggle-v1.policy.json').read_text(encoding='utf-8'))
QH_OPS = ('owner-list', 'admin-list', 'admin-search', 'admin-unbilled', 'owner-calendar', 'admin-calendar', 'admin-filter', 'admin-page')


def qh_member(configuration, latency, *, lag=2.0, drop=0, error_op=None, cpu=(True, 100.0)):
    rate, seconds = 12, 800
    rows = []
    for i in range(rate * seconds):
        op = QH_OPS[i % 8]
        row = {'phase': 'measured', 'sequence': i, 'operation': op, 'sent': True, 'outcome': 'success',
               'scheduled_s': i / rate, 'lag_ms': lag, 'total_ms': latency.get(op, 50) + (i % 10)}
        if i < drop:
            row.update(operation='generator.drop', sent=False, outcome='generator_drop')
        if error_op == op and i < 64:
            row['outcome'] = 'contract_error'
        rows.append(row)
    report = {'status': 'COMPLETE', 'settings': {'rate': rate}, 'measured': {'seconds': seconds}, 'pool': {'peaks': {'p8_clinic': 9}}}
    return {'workload': 'query-heavy', 'configuration': configuration, 'report': report, 'rows': rows,
            'cpu': {'complete': cpu[0], 'reasons': [] if cpu[0] else ['role_unreadable:postgres:reset'], 'applicationCpuSeconds': cpu[1]}}


def pcn_member(configuration, latency, *, writes=1200, path=None, cpu=(True, 100.0), probe=5.0):
    names = {'GET pets': 4000, 'GET appointments': 2000, 'GET medical by pet': 2000, 'GET hotel': 1000,
             'GET invoices': 1000, 'GET notifications': 1000, 'POST appointment': writes, 'POST rescue report': writes}
    source = path or ev.expected_path(configuration)
    rows = []
    for name, n in names.items():
        for i in range(n):
            rows.append({'user': i % 100, 'name': name, 'startMonotonic': 1000 + i, 'latencyMs': latency.get(name, 40) + (i % 10),
                         'failed': False, 'readSource': source if name == 'GET appointments' else 'absent', 'generationMatches': configuration == 'B'})
    report = {'status': 'COMPLETE', 'settings': {'seconds': 1800}, 'reconciliation': {'status': 'PASS_IN_SCOPE'},
              'window': {'completed': True, 'targetUsers': 100, 'populationMin': 100, 'populationMax': 100}, 'pool': {'peaks': {}}}
    return {'workload': 'pcn', 'configuration': configuration, 'report': report, 'rows': rows,
            'probe': [{'delayMs': probe} for _ in range(18000)], 'cpu': {'complete': cpu[0], 'reasons': [], 'applicationCpuSeconds': cpu[1]}}


def blocks(maker, by_config, key='k1', count=3, per_block=None):
    out = []
    for index in range(count):
        members = {}
        for c in 'OAB':
            args = (per_block or {}).get((index, c), by_config[c])
            members[c] = maker(c, **args) if isinstance(args, dict) and 'latency' in args else maker(c, args)
        out.append({'index': index, 'profileKeySha256': key, 'members': members})
    return out


FAST = {'admin-list': 40}
BASE = {'admin-list': 100}


def study(qh=None, pcn=None):
    qh = qh or blocks(qh_member, {'O': BASE, 'A': BASE, 'B': FAST})
    pcn = pcn or blocks(pcn_member, {'O': {}, 'A': {}, 'B': {}})
    return ev.evaluate({'query-heavy': qh, 'pcn': pcn}, POLICY)


class PolicyTests(unittest.TestCase):
    def test_policy_copies_locked_plan_values(self):
        plan = json.loads(make_list_policy.PLAN.read_text(encoding='utf-8'))
        self.assertEqual(POLICY['acceptance'], plan['listStudy']['acceptance'])
        self.assertEqual(POLICY['blocksForEachWorkload'], [['O', 'A', 'B'], ['B', 'O', 'A'], ['A', 'B', 'O']])
        self.assertEqual(POLICY['queryHeavy'], plan['listStudy']['queryHeavy'])
        self.assertEqual(POLICY['pcn'], plan['listStudy']['pcn'])
        self.assertEqual(POLICY['generatorValidity'], plan['generatorValidity'])
        self.assertEqual(POLICY['sessions'], plan['sessions'])
        sidecar = make_list_policy.TARGET.with_suffix('').with_suffix('.sha256').read_text(encoding='utf-8').split()[0]
        self.assertEqual(sidecar, make_list_policy.digest(make_list_policy.TARGET.read_bytes()))
        with self.assertRaises(ValueError):
            make_list_policy.build()


class DecisionTests(unittest.TestCase):
    def test_win_in_scope_when_both_ratios_and_regressions_pass(self):
        result = study()
        self.assertEqual(result['decision'], 'WIN_IN_SCOPE')
        qh = result['workloads'][0]['gates']
        self.assertEqual(qh['readPathImprovement']['status'], 'PASS')
        self.assertLess(qh['readPathImprovement']['median'], 0.5)

    def test_read_path_benefit_only_when_b_over_o_misses(self):
        qh = blocks(qh_member, {'O': {'admin-list': 50}, 'A': BASE, 'B': {'admin-list': 45}})
        self.assertEqual(study(qh=qh)['decision'], 'READ_PATH_BENEFIT_ONLY')

    def test_no_meaningful_benefit(self):
        qh = blocks(qh_member, {'O': BASE, 'A': BASE, 'B': {'admin-list': 95}})
        self.assertEqual(study(qh=qh)['decision'], 'NO_MEANINGFUL_BENEFIT')

    def test_any_block_write_regression_is_regression(self):
        slow = {'latency': {'POST appointment': 60}}
        pcn = blocks(pcn_member, {'O': {}, 'A': {}, 'B': {}}, per_block={(1, 'B'): slow})
        result = study(pcn=pcn)
        self.assertEqual(result['decision'], 'REGRESSION')
        self.assertEqual(result['workloads'][1]['gates']['writeBtoO']['POST appointment']['status'], 'FAIL')

    def test_missing_cpu_coverage_is_total_cost_inconclusive_not_pass(self):
        qh = blocks(qh_member, {'O': BASE, 'A': BASE, 'B': FAST}, per_block={(2, 'B'): {'latency': FAST, 'cpu': (False, None)}})
        result = study(qh=qh)
        self.assertEqual(result['workloads'][0]['gates']['cpuPerSuccessBtoO']['status'], 'TOTAL_COST_INCONCLUSIVE')
        self.assertEqual(result['decision'], 'INCONCLUSIVE')

    def test_generator_drop_is_invalid_environment_and_contract_error_is_correctness(self):
        qh = blocks(qh_member, {'O': BASE, 'A': BASE, 'B': FAST}, per_block={(0, 'A'): {'latency': BASE, 'drop': 1}})
        self.assertEqual(study(qh=qh)['decision'], 'INVALID_ENVIRONMENT')
        qh = blocks(qh_member, {'O': BASE, 'A': BASE, 'B': FAST}, per_block={(0, 'B'): {'latency': FAST, 'error_op': 'owner-list'}})
        self.assertEqual(study(qh=qh)['decision'], 'FAIL_CORRECTNESS')

    def test_wrong_read_path_in_pcn_is_correctness_failure(self):
        pcn = blocks(pcn_member, {'O': {}, 'A': {}, 'B': {}}, per_block={(0, 'B'): {'latency': {}, 'path': 'authoritative'}})
        self.assertEqual(study(pcn=pcn)['decision'], 'FAIL_CORRECTNESS')

    def test_declared_v1_fallback_in_pcn_is_allowed_and_reported(self):
        pcn = blocks(pcn_member, {'O': {}, 'A': {}, 'B': {}})
        rows = [r for r in pcn[0]['members']['B']['rows'] if r['name'] == 'GET appointments']
        for r in rows[:50]:
            r.update(readSource='authoritative', generationMatches=False, degraded=True)
        result = study(pcn=pcn)
        self.assertEqual(result['decision'], 'WIN_IN_SCOPE')
        b = result['workloads'][1]['blocks'][0]['members']['B']
        self.assertEqual((b['pathErrors'], b['listFallbacks'], b['listFallbackRate']), (0, 50, 50 / 2000))
        rows[60].update(readSource='authoritative', generationMatches=False, degraded=False)
        self.assertEqual(study(pcn=pcn)['decision'], 'FAIL_CORRECTNESS')

    def test_profile_key_mismatch_or_two_blocks_is_inconclusive(self):
        qh = blocks(qh_member, {'O': BASE, 'A': BASE, 'B': FAST})
        qh[2]['profileKeySha256'] = 'other'
        self.assertEqual(study(qh=qh)['workloads'][0]['status'], 'INCONCLUSIVE_INSUFFICIENT_MATCHED_BLOCKS')
        self.assertEqual(study(qh=qh[:2])['decision'], 'INCONCLUSIVE')

    def test_insufficient_write_samples_are_inconclusive_not_rescued(self):
        pcn = blocks(pcn_member, {'O': {'latency': {}, 'writes': 900}, 'A': {'latency': {}, 'writes': 900}, 'B': {'latency': {}, 'writes': 900}})
        result = study(pcn=pcn)
        self.assertEqual(result['workloads'][1]['gates']['writeBtoO']['POST appointment']['status'], 'INCONCLUSIVE_INSUFFICIENT_WRITE_SAMPLES')
        self.assertEqual(result['decision'], 'INCONCLUSIVE')

    def test_closed_loop_probe_over_limit_is_invalid(self):
        pcn = blocks(pcn_member, {'O': {}, 'A': {}, 'B': {}}, per_block={(1, 'O'): {'latency': {}, 'probe': 150.0}})
        self.assertEqual(study(pcn=pcn)['decision'], 'INVALID_ENVIRONMENT')


class BoundaryTests(unittest.TestCase):
    def test_gate_boundaries_inclusive(self):
        self.assertEqual(ev.gate([0.8, 0.8, 1.1], median_max=0.8, every_max=1.1)['status'], 'PASS')
        self.assertEqual(ev.gate([0.8, 0.81, 0.81], median_max=0.8, every_max=1.1)['status'], 'FAIL')
        self.assertEqual(ev.gate([0.9, 0.95, 1.0], every_min=0.9)['status'], 'PASS')
        self.assertEqual(ev.gate([0.9, None, 1.0], every_min=0.9)['status'], 'INCONCLUSIVE')
        self.assertEqual(ev.nearest_rank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], .95), 10)
        self.assertEqual(ev.nearest_rank(list(range(1, 101)), .95), 95)

    def test_pool_check_uses_shared_role_ceilings(self):
        ok = ev.pool_check({'p8_clinic': 13, 'p8_core': 16, 'p8_notification': 12}, 'B', POLICY)
        self.assertTrue(ok['pass'])
        self.assertEqual(ok['roles']['p8_clinic']['ceiling'], 4 + 1 + 4 + 1 + 4)
        self.assertFalse(ev.pool_check({'p8_clinic': 13}, 'O', POLICY)['pass'])
        self.assertFalse(ev.pool_check({'stranger': 1}, 'O', POLICY)['pass'])


class BlockControlTests(unittest.TestCase):
    """run_block/evaluate control flow with synthetic members (no processes)."""
    def study(self, plan):
        import list_study
        s = list_study.Study.__new__(list_study.Study)
        s.policy, s.key_sha, s.outcomes = POLICY, 'key', {'query-heavy': []}
        s.reports = make_list_policy.REPO / 'test-results/phase2/cqrs/list-study-control-fixture'
        s.reports.mkdir(parents=True, exist_ok=True)
        calls = []
        def member(workload, block, configuration, mode, attempt):
            calls.append((block, configuration, attempt))
            return {'id': f'{block}{configuration}{attempt}', 'workload': workload, 'block': block, 'configuration': configuration,
                    'mode': mode, 'attempt': attempt, 'status': plan.get((block, configuration, attempt), {}).get('status', 'COMPLETE'), 'cpu': {}}
        def loaded(record):
            spec = plan.get((record['block'], record['configuration'], record['attempt']), {})
            latency = FAST if record['configuration'] == 'B' else BASE
            return qh_member(record['configuration'], latency, drop=spec.get('drop', 0), error_op=spec.get('error_op'))
        s.member, s.loaded, s.calls = member, loaded, calls
        return s

    def tearDown(self):
        import shutil
        shutil.rmtree(make_list_policy.REPO / 'test-results/phase2/cqrs/list-study-control-fixture', ignore_errors=True)

    def test_valid_block_runs_once_in_locked_order(self):
        s = self.study({})
        self.assertEqual(s.run_block('query-heavy', 1, 'full'), 'COMPLETE')
        self.assertEqual(s.calls, [(1, 'B', 0), (1, 'O', 0), (1, 'A', 0)])

    def test_environment_invalid_block_gets_one_whole_replacement_then_stops(self):
        s = self.study({(0, 'A', 0): {'drop': 1}})
        self.assertEqual(s.run_block('query-heavy', 0, 'full'), 'COMPLETE')
        self.assertEqual(len(s.calls), 6)
        self.assertEqual([e['attempt'] for e in s.outcomes['query-heavy']], [0, 1])
        s = self.study({(0, 'A', 0): {'drop': 1}, (0, 'O', 1): {'drop': 1}})
        self.assertEqual(s.run_block('query-heavy', 0, 'full'), 'INVALID_ENVIRONMENT_AFTER_REPLACEMENT')

    def test_correctness_or_application_failure_stops_without_replacement(self):
        s = self.study({(2, 'B', 0): {'error_op': 'owner-list'}})
        self.assertEqual(s.run_block('query-heavy', 2, 'full'), 'CORRECTNESS_FAILURE')
        self.assertEqual(len(s.calls), 3)
        s = self.study({(2, 'A', 0): {'status': 'FAIL'}})
        self.assertEqual(s.run_block('query-heavy', 2, 'full'), 'APPLICATION_FAILURE')
        self.assertEqual(s.calls, [(2, 'A', 0)])

    def test_evaluate_uses_first_valid_attempt_and_ignores_smoke(self):
        s = self.study({(0, 'A', 0): {'drop': 1}})
        s.run_block('query-heavy', 0, 'smoke')
        for block in (0, 1, 2):
            s.run_block('query-heavy', block, 'full')
        s.outcomes['pcn'] = []
        result = s.evaluate()
        qh = result['workloads'][0]
        self.assertEqual(qh['comparableBlocks'], 3)
        self.assertEqual(qh['gates']['readPathImprovement']['status'], 'PASS')
        self.assertEqual(result['decision'], 'INCONCLUSIVE')  # PCN not run in this session


class NotebookBundleTests(unittest.TestCase):
    def test_bundle_verifies_and_rejects_tampering_and_unsafe_paths(self):
        import io, zipfile
        import make_list_notebook as nb
        raw, manifest = nb.source_bundle()
        got, values = nb.verified_members(raw, nb.digest(raw))
        self.assertEqual(got['q6BundleSha256'], nb.BUNDLE_SHA)
        self.assertIn('benchmarks/phase2/kaggle/list_trial.py', values)
        self.assertTrue(all(name in values for name in nb.Q6_HARNESS))
        with self.assertRaises(ValueError):
            nb.verified_members(raw, '0' * 64)
        buffer = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(raw)) as src, zipfile.ZipFile(buffer, 'w') as out:
            for info in src.infolist():
                data = src.read(info)
                if info.filename.endswith('list_trial.py'):
                    data += b'#'
                out.writestr(info, data)
        bad = buffer.getvalue()
        with self.assertRaisesRegex(ValueError, 'LIST_SOURCE_HASH'):
            nb.verified_members(bad, nb.digest(bad))
        for name in ('../x.py', 'a/.env', 'node_modules/x.js', 'x.ipynb', 'other.zip', 'C:/x.py'):
            with self.assertRaises(ValueError):
                nb.safe_path(name)


class LedgerTests(unittest.TestCase):
    def test_stack_ledger_maps_every_process_and_rejects_unknown(self):
        import importlib, sys, types
        for name in ('native_stack', 'benchmark', 'cqrs_probe', 'query_heavy'):
            sys.modules.setdefault(name, types.SimpleNamespace(NativeStack=None, Client=None, reconcile=None, preflight=None,
                                                                QueryClient=None, measure=None, OPERATIONS=QH_OPS))
        trial = importlib.import_module('list_trial')
        tmp = make_list_policy.REPO / 'test-results/phase2/cqrs/list-study-ledger-fixture'
        (tmp / 'pgdata').mkdir(parents=True, exist_ok=True)
        (tmp / 'pgdata/postmaster.pid').write_text('300\n/x\n'); (tmp / 'nginx.pid').write_text('400\n')
        child = lambda pid: types.SimpleNamespace(pid=pid)
        stack = types.SimpleNamespace(private=tmp, processes=[('redis', child(10)), ('rabbitmq', child(11)), ('application', child(12))],
                                      fixture={'processes': [{'name': n, 'pid': 20 + i} for i, n in enumerate(
                                          ['clinic-read-worker', 'core', 'clinic-0', 'notification', 'core-outbox', 'clinic-worker', 'notification-worker', 'billing-worker'])]})
        ledger = trial.stack_ledger(stack, generator=[1], controller=[2])
        self.assertEqual(ledger['api'], [21, 22, 23]); self.assertEqual(ledger['relay'], [25]); self.assertEqual(ledger['worker'], [20, 24, 26, 27])
        self.assertEqual(ledger['controller'], [2, 12]); self.assertEqual(ledger['postgres'], [300]); self.assertEqual(ledger['gateway'], [400])
        stack.fixture['processes'].append({'name': 'mystery', 'pid': 99})
        with self.assertRaises(RuntimeError):
            trial.stack_ledger(stack, generator=[1], controller=[2])
        for name in ('native_stack', 'benchmark', 'cqrs_probe', 'query_heavy', 'list_trial'):
            sys.modules.pop(name, None)
        import shutil; shutil.rmtree(tmp)


if __name__ == '__main__':
    unittest.main()
