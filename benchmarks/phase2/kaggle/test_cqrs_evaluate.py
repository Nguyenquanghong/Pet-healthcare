"""Adversarial acceptance cases: a fast endpoint must not hide invalid evidence."""
import copy
import hashlib
import io
import json
from pathlib import Path
import stat
import unittest
from unittest.mock import patch
import warnings
from zipfile import ZipFile, ZipInfo

import cqrs_evaluate as ev
import cqrs_source

POLICY_BYTES = (Path(__file__).resolve().parents[3] / 'phase2-plan/cqrs/acceptance.json').read_bytes()
POLICY = json.loads(POLICY_BYTES)


def query_summary(configuration='A', p95=100):
    return {'configuration': configuration, 'full': True, 'profile_valid': True, 'sample_valid': True,
            'contract_valid': True, 'read_path_valid': True, 'generator_valid': True, 'nfr_valid': True,
            'settings': {'rate': 12, 'concurrency': 16}, 'success_rps': 12,
            'measured': {op: {'p95_success_ms': p95} for op in ev.OPERATIONS},
            'cpu': {'coverage_valid': True, 'cpu_seconds_per_success_observed': .1}}


def matrix():
    return {f'pair-{i}-{c}': query_summary(c, 100 if c == 'A' else 80)
            for i in range(1, 4) for c in 'AB'} | {f'O-{i}': query_summary('O', 100) for i in range(1, 4)}


def pcn_matrix():
    return {name: {'configuration': q['configuration'], 'full': True, 'profile_valid': True,
                   'contract_valid': True, 'read_path_valid': True, 'nfr_valid': True, 'success_rps': 100,
                   'endpoints': {op: {'p95_all_ms': 100} for op in ev.PCN_OPERATIONS}}
            for name, q in matrix().items()}


def raw_query(op='admin-list', source='projection', **overrides):
    return {'operation': op, 'phase': 'measured', 'sequence': 0, 'status': 200, 'sent': True,
            'outcome': 'success', 'read_source': source, 'generation_matches': True, 'degraded': False,
            'latency_ms': 20, 'total_ms': 21, 'lag_ms': 1, **overrides}


def gate_named(gates, name):
    return next(g for g in gates if g['gate'] == name)


class DecisionTests(unittest.TestCase):
    def test_frozen_policy_is_unchanged(self):
        self.assertEqual(hashlib.sha256(POLICY_BYTES).hexdigest(), cqrs_source.POLICY_SHA)

    def test_exact_twenty_percent_boundary_passes_primary_only(self):
        self.assertEqual(ev.primary_comparison(matrix(), POLICY)['status'], 'PASS')

    def test_small_gain_fails_even_when_calendar_search_are_faster(self):
        trials = matrix()
        for t in trials.values():
            if t['configuration'] == 'B':
                t['measured']['admin-list']['p95_success_ms'] = 96
                t['measured']['admin-calendar']['p95_success_ms'] = 1
                t['measured']['admin-search']['p95_success_ms'] = 1
        self.assertEqual(ev.primary_comparison(trials, POLICY)['status'], 'FAIL')

    def test_one_pair_regresses_more_than_ten_percent_despite_good_median(self):
        trials = matrix()
        trials['pair-2-B']['measured']['admin-list']['p95_success_ms'] = 111
        result = ev.primary_comparison(trials, POLICY)
        self.assertAlmostEqual(result['median_improvement_percent'], 20)
        self.assertEqual(result['status'], 'FAIL')

    def test_ten_percent_pair_boundary_is_allowed(self):
        trials = matrix()
        trials['pair-2-B']['measured']['admin-list']['p95_success_ms'] = 110
        self.assertEqual(ev.primary_comparison(trials, POLICY)['status'], 'PASS')

    def test_short_sample_cannot_pass_primary(self):
        trials = matrix()
        trials['pair-3-B']['sample_valid'] = False
        self.assertEqual(ev.primary_comparison(trials, POLICY)['status'], 'INSUFFICIENT_SAMPLES')

    def test_missing_pair_cannot_be_replaced_by_smoke(self):
        trials = matrix()
        trials['smoke-B'] = trials.pop('pair-3-B')
        self.assertEqual(ev.primary_comparison(trials, POLICY)['status'], 'NOT_RUN')

    def test_different_load_cannot_be_presented_as_speedup(self):
        trials = matrix()
        trials['pair-1-B']['settings']['rate'] = 6
        self.assertEqual(ev.primary_comparison(trials, POLICY)['status'], 'INVALID_ENVIRONMENT')

    def test_invalid_generator_or_contract_cannot_pass(self):
        for field in ('contract_valid', 'read_path_valid', 'generator_valid', 'nfr_valid'):
            with self.subTest(field=field):
                trials = matrix(); trials['pair-2-B'][field] = False
                self.assertEqual(ev.primary_comparison(trials, POLICY)['status'], 'FAIL')

    def test_write_regression_is_visible_even_when_primary_passes(self):
        trials = pcn_matrix()
        for t in trials.values():
            if t['configuration'] == 'B':
                t['endpoints']['POST appointment']['p95_all_ms'] = 112
        gates = ev.workload_gates(matrix(), trials, POLICY)
        self.assertEqual(gate_named(gates, 'query_primary_admin_list')['status'], 'PASS')
        self.assertEqual(gate_named(gates, 'pcn_POST_appointment_p95_vs_O')['status'], 'FAIL')

    def test_throughput_uses_successes_and_direction_is_correct(self):
        trials = pcn_matrix()
        for t in trials.values():
            if t['configuration'] == 'B': t['success_rps'] = 89
        g = gate_named(ev.workload_gates({}, trials, POLICY), 'pcn_successful_throughput_vs_O')
        self.assertEqual(g['status'], 'FAIL')
        self.assertAlmostEqual(g['change_vs_O_percent']['B'], -11)

    def test_cpu_increase_is_not_hidden_by_fast_list(self):
        trials = matrix()
        for t in trials.values():
            if t['configuration'] == 'B': t['cpu']['cpu_seconds_per_success_observed'] = .112
        g = gate_named(ev.workload_gates(trials, {}, POLICY), 'query_total_cpu_per_success_vs_O')
        self.assertEqual(g['status'], 'FAIL')


class RawEvidenceTests(unittest.TestCase):
    def test_429_503_and_drops_remain_in_denominator_and_all_http_latency(self):
        rows = [raw_query(), raw_query(sequence=1, status=429, latency_ms=1000, outcome='http_error'),
                raw_query(sequence=2, status=503, latency_ms=1500, outcome='http_error'),
                raw_query(sequence=3, status=0, sent=False, latency_ms=None, outcome='dropped')]
        stats = ev.summarize_query(rows, 'B', 1)['admin-list']
        self.assertEqual((stats['scheduled'], stats['success'], stats['dropped']), (4, 1, 1))
        self.assertEqual((stats['http_429'], stats['http_503']), (1, 1))
        self.assertEqual(stats['success_ratio_of_scheduled'], .25)
        self.assertEqual(stats['p95_all_http_ms'], 1500)

    def test_http_200_fallback_does_not_count_as_projected_success(self):
        stats = ev.summarize_query([raw_query(source='authoritative', degraded=True)], 'B', 1)['admin-list']
        self.assertEqual(stats['success'], 0)
        self.assertEqual(stats['wrong_read_path'], 1)

    def test_wrong_generation_does_not_count_as_success(self):
        stats = ev.summarize_query([raw_query(generation_matches=False)], 'B', 1)['admin-list']
        self.assertEqual(stats['success'], 0)

    def test_unbilled_intentionally_stays_authoritative(self):
        stats = ev.summarize_query([raw_query(op='admin-unbilled', source='authoritative', degraded=True)], 'B', 1)
        self.assertEqual(stats['admin-unbilled']['success'], 1)

    def test_duplicate_request_and_nonfinite_latency_are_invalid(self):
        for rows in ([raw_query(), raw_query()], [raw_query(latency_ms=float('nan'))]):
            with self.assertRaises(ev.EvidenceError): ev.summarize_query(rows, 'B', 1)

    def test_percentiles_use_nearest_rank_not_mean_or_locust_rounding(self):
        rows = [raw_query(sequence=i, latency_ms=i + 1) for i in range(100)]
        stats = ev.summarize_query(rows, 'B', 10)['admin-list']
        self.assertEqual((stats['p95_success_ms'], stats['p99_success_ms']), (95, 99))

    def test_cpu_counts_database_projector_broker_and_generator(self):
        names = ('billing-worker', 'clinic-0', 'clinic-read-worker', 'clinic-worker', 'core', 'core-outbox',
                 'generator', 'nginx', 'notification', 'notification-worker', 'postgres', 'rabbitmq',
                 'redis', 'stack-supervisor')
        rows = [{'component': n, 'phase': 'measured', 'cpu_seconds_delta': 10 if n == 'postgres' else 1,
                 'interval_seconds': 100} for n in names]
        rows.append({'component': 'postgres', 'phase': 'warmup', 'cpu_seconds_delta': 999, 'interval_seconds': 5})
        cpu = ev.cpu_query(rows, 100, 100, 'B')
        self.assertTrue(cpu['coverage_valid'])
        self.assertEqual(cpu['total_cpu_seconds_observed'], 23)
        self.assertEqual(cpu['cpu_seconds_per_success_observed'], .23)
        self.assertFalse(ev.cpu_query([r for r in rows if r['component'] != 'clinic-read-worker'], 100, 100, 'B')['coverage_valid'])

    def test_cpu_partial_coverage_is_not_accepted(self):
        self.assertFalse(ev.cpu_query([], 100, 100, 'B')['coverage_valid'])

    def test_full_raw_trial_recomputes_counts_and_rejects_missing_arrivals(self):
        prefix = 'query-heavy/trials/pair-1-B/'
        measured = [raw_query(op=ev.OPERATIONS[i % 8], sequence=i,
                    source='authoritative' if ev.OPERATIONS[i % 8] == 'admin-unbilled' else 'projection',
                    degraded=ev.OPERATIONS[i % 8] == 'admin-unbilled') for i in range(9600)]
        warmup = [{**r, 'phase': 'warmup'} for r in measured[:1440]]
        report = {'configuration': 'B', 'mode': 'full', 'run': 'trial-uuid',
                  'settings': {'seconds': 800, 'warmup': 120, 'rate': 12, 'concurrency': 16},
                  'measured': {'scheduled': 9600}, 'dataset': {'appointments': 100000},
                  'reconciliation': {'status': 'PASS'}, 'process_sample_errors': 0,
                  'status': 'BENCHMARK_RUN_RECORDED', 'preflight': [{'valid': True}] * 3,
                  'cqrs': {'readMode': 'projection', 'projectorEnabled': True, 'shadowEnabled': False}}
        payload = {prefix + 'report.json': json.dumps(report).encode(), prefix + 'resources.jsonl': b'',
                   prefix + 'requests.jsonl': b'\n'.join(json.dumps(r).encode() for r in warmup + measured)}
        result = ev.query_trial(payload, 'pair-1-B', POLICY)
        self.assertTrue(result['sample_valid'] and result['contract_valid'] and result['nfr_valid'])
        self.assertEqual(result['measured']['admin-list']['success'], 1200)
        self.assertEqual(result['success_rps'], 12)
        payload[prefix + 'requests.jsonl'] = b'\n'.join(json.dumps(r).encode() for r in warmup + measured[:-1])
        with self.assertRaisesRegex(ev.EvidenceError, '^QUERY_COUNT_MISMATCH$'):
            ev.query_trial(payload, 'pair-1-B', POLICY)


class ArchiveAndProvenanceTests(unittest.TestCase):
    def write_archive(self, files, alter_manifest=False, extra=None):
        entries = [{'path': n, 'bytes': len(d), 'sha256': ev.digest(d)} for n, d in sorted(files.items())]
        if alter_manifest: entries[0]['sha256'] = '0' * 64
        buffer = io.BytesIO()
        with ZipFile(buffer, 'w') as z:
            for name, data in files.items(): z.writestr(name, data)
            z.writestr('result-manifest.json', json.dumps({'files': entries, 'source_archive_sha256': '1' * 64}))
            if extra:
                info, data = extra; z.writestr(info, data)
        return buffer.getvalue()

    def test_hash_mismatch_rejected(self):
        raw = self.write_archive({'summary.json': b'{}'}, alter_manifest=True)
        with self.assertRaisesRegex(ev.EvidenceError, '^RESULT_HASH_OR_INVENTORY$'): ev.read_result_archive(raw)

    def test_traversal_unknown_files_duplicate_and_symlinks_rejected(self):
        symlink = ZipInfo('setup-versions.json'); symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        for info in ('../outside', 'private.log', 'summary.json', symlink):
            with self.subTest(info=str(info)), warnings.catch_warnings():
                warnings.simplefilter('ignore', UserWarning)
                raw = self.write_archive({'summary.json': b'{}'}, extra=(info, b'PRIVATE_SECRET'))
                with self.assertRaises(ev.EvidenceError) as caught: ev.read_result_archive(raw)
                self.assertNotIn('PRIVATE_SECRET', str(caught.exception))

    def test_source_and_policy_mismatch_rejected_before_performance(self):
        payload = {'result-manifest.json': json.dumps({'source_archive_sha256': 'other'}).encode()}
        with self.assertRaisesRegex(ev.EvidenceError, '^SOURCE_ARCHIVE_HASH$'):
            ev.evaluate(payload, {}, 'expected', POLICY, {})

    def test_missing_workloads_and_equal_budget_never_produce_overall_pass(self):
        payload = {'result-manifest.json': json.dumps({'source_archive_sha256': 'expected'}).encode()}
        report = ev.evaluate(payload, {}, 'expected', POLICY, {})
        self.assertEqual(report['decision'], 'INCONCLUSIVE')
        self.assertFalse(report['significant_improvement_proven'])
        self.assertFalse(report['deployment_accepted'])
        self.assertEqual(gate_named(report['gates'], 'pcn_calendar_regression')['status'], 'NOT_RUN')
        self.assertEqual(gate_named(report['gates'], 'equal_enforced_total_resource_budget')['status'], 'INCONCLUSIVE')

    def workflow_payload(self):
        sources = {k: {'sha256': k, 'files': []} for k in ('O', 'AB', 'harness')}
        plan = cqrs_source.make_plan(POLICY, sources)
        manifest = {'sha256': 'manifest', 'sources': sources}
        env = {'source_archive_sha256': 'expected', 'source_manifest_sha256': 'manifest',
               'sources': sources, 'policy_sha256': cqrs_source.POLICY_SHA, 'plan': plan}
        payload = {'result-manifest.json': json.dumps({'source_archive_sha256': 'expected'}).encode(),
                   'query-heavy/environment.json': json.dumps(env).encode()}
        return payload, manifest, plan

    def test_ab_order_cannot_be_cherry_picked(self):
        payload, manifest, plan = self.workflow_payload()
        trials = copy.deepcopy(plan['trials'][:3]); trials[0], trials[1] = trials[1], trials[0]
        payload['query-heavy/trials/workflow.json'] = json.dumps({'full': False, 'trials': trials}).encode()
        with self.assertRaisesRegex(ev.EvidenceError, '^TRIAL_ORDER$'):
            ev.evaluate(payload, manifest, 'expected', POLICY, plan)

    def test_environment_plan_cannot_silently_change_rate_or_policy(self):
        payload, manifest, plan = self.workflow_payload()
        env = json.loads(payload['query-heavy/environment.json']); env['policy_sha256'] = 'wrong'
        payload['query-heavy/environment.json'] = json.dumps(env).encode()
        with self.assertRaisesRegex(ev.EvidenceError, '^SOURCE_POLICY_PLAN_MISMATCH$'):
            ev.evaluate(payload, manifest, 'expected', POLICY, plan)

    def test_full_primary_pass_is_distinct_from_q6_approval_and_duplicate_runs_rejected(self):
        payload, manifest, plan = self.workflow_payload()
        entries = copy.deepcopy([t for t in plan['trials'] if t['workload'] == 'query-heavy'])
        for i, row in enumerate(entries):
            row['run'] = 'run-' + str(i)
            for filename in ('report.json', 'requests.jsonl', 'resources.jsonl'):
                payload['query-heavy/trials/' + row['name'] + '/' + filename] = b'{}'
        payload['query-heavy/trials/workflow.json'] = json.dumps({'full': True, 'trials': entries}).encode()
        def synthetic_trial(_, name, __):
            row = next(r for r in entries if r['name'] == name)
            result = query_summary(row['configuration'], 80 if row['configuration'] == 'B' else 100)
            result.update(run=row['run'], warmup={}, warmup_seconds=120, measured_seconds=800)
            return result
        with patch.object(ev, 'query_trial', side_effect=synthetic_trial):
            report = ev.evaluate(payload, manifest, 'expected', POLICY, plan)
            self.assertEqual(gate_named(report['gates'], 'query_primary_admin_list')['status'], 'PASS')
            self.assertEqual(report['decision'], 'INCONCLUSIVE')
            self.assertFalse(report['significant_improvement_proven'])
            entries[-1]['run'] = entries[-2]['run']
            payload['query-heavy/trials/workflow.json'] = json.dumps({'full': True, 'trials': entries}).encode()
            with self.assertRaisesRegex(ev.EvidenceError, '^DUPLICATE_OR_WRONG_RUN$'):
                ev.evaluate(payload, manifest, 'expected', POLICY, plan)


if __name__ == '__main__':
    unittest.main()
