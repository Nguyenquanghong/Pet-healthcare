"""Final study (F against O) evaluator/policy/controller tests on synthetic data only."""
import json
import unittest

import cqrs_probe
import final_evaluate as fe
import make_final_policy
from test_list_study import qh_member, pcn_member

POLICY = json.loads(make_final_policy.TARGET.read_text(encoding='utf-8'))
BASE = {'admin-list': 100}


def blocks(maker, by_config, key='k1', count=3, per_block=None):
    out = []
    for index in range(count):
        members = {}
        for c in fe.CONFIGURATIONS:
            args = (per_block or {}).get((index, c), by_config[c])
            members[c] = maker(c, **args) if isinstance(args, dict) and 'latency' in args else maker(c, args)
        out.append({'index': index, 'profileKeySha256': key, 'members': members})
    return out


def study(qh=None, pcn=None):
    qh = qh or blocks(qh_member, {'O': BASE, 'F': BASE})
    pcn = pcn or blocks(pcn_member, {'O': {}, 'F': {}})
    return fe.evaluate({'query-heavy': qh, 'pcn': pcn}, POLICY)


class PolicyTests(unittest.TestCase):
    def test_policy_is_frozen_from_v3_with_only_the_final_changes(self):
        v3 = json.loads(make_final_policy.V3.read_text(encoding='utf-8'))
        for key in make_final_policy.UNCHANGED:
            self.assertEqual(POLICY[key], v3[key], key)
        self.assertEqual(POLICY['status'], 'FROZEN_BEFORE_MEASUREMENT')
        self.assertEqual(POLICY['blocksForEachWorkload'], [['O', 'F'], ['F', 'O'], ['O', 'F']])
        self.assertEqual(set(POLICY['configurations']), {'O', 'F'})
        self.assertEqual(POLICY['profile']['poolCeilingsPerProcess']['F'], v3['profile']['poolCeilingsPerProcess']['O'])
        self.assertNotIn('clinic-read-worker', POLICY['profile']['poolCeilingsPerProcess']['F'])
        gates, acc = POLICY['acceptance']['finalNonRegressionAgainstO'], v3['acceptance']
        self.assertEqual(gates['writeP95RatioMax'], acc['wholeFeatureNonRegressionAgainstO']['writeP95RatioMax'])
        self.assertEqual(gates['applicationCpuPerSuccessRatioMax'], acc['wholeFeatureNonRegressionAgainstO']['applicationCpuPerSuccessRatioMax'])
        self.assertEqual(gates['successfulThroughputRatioMin'], acc['wholeFeatureNonRegressionAgainstO']['successfulThroughputRatioMin'])
        self.assertEqual(gates['pcnAppointmentListP95RatioMax'], acc['pcnAppointmentListP95RatioMax'])
        self.assertEqual(gates['calendarP95RatioMax'], acc['queryHeavyOwnerAndAdminCalendarP95RatioToOMax'])
        sidecar = make_final_policy.TARGET.with_suffix('').with_suffix('.sha256').read_text(encoding='utf-8').split()[0]
        self.assertEqual(sidecar, make_final_policy.digest(make_final_policy.TARGET.read_bytes()))
        with self.assertRaises(ValueError):
            make_final_policy.build()


class EvaluatorTests(unittest.TestCase):
    def test_equal_members_are_no_regression(self):
        result = study()
        self.assertEqual(result['decision'], 'NO_REGRESSION')
        qh = result['workloads'][0]
        self.assertEqual(qh['gates']['primaryFtoO']['status'], 'PASS')
        self.assertEqual(qh['comparableBlocks'], 3)

    def test_one_slow_block_is_a_regression(self):
        qh = blocks(qh_member, {'O': BASE, 'F': BASE}, per_block={(1, 'F'): {'admin-list': 130}})
        result = study(qh=qh)
        self.assertEqual(result['decision'], 'REGRESSION')
        self.assertEqual(result['workloads'][0]['gates']['primaryFtoO']['status'], 'FAIL')

    def test_pcn_write_and_list_regressions_fail(self):
        slow = {'POST appointment': 60, 'GET appointments': 40}
        pcn = blocks(pcn_member, {'O': {}, 'F': slow})
        gates = study(pcn=pcn)['workloads'][1]['gates']
        self.assertEqual(gates['writeFtoO']['POST appointment']['status'], 'FAIL')
        self.assertEqual(gates['listFtoO']['status'], 'PASS')

    def test_f_must_read_authoritative_and_o_absent(self):
        pcn = blocks(pcn_member, {'O': {}, 'F': {}}, per_block={(0, 'F'): {'latency': {}, 'path': 'projection'}})
        result = study(pcn=pcn)
        self.assertEqual(result['decision'], 'FAIL_CORRECTNESS')
        self.assertTrue(cqrs_probe.correct_path('F', {'read_source': 'authoritative', 'generation_matches': False}))
        self.assertFalse(cqrs_probe.correct_path('F', {'read_source': 'projection', 'generation_matches': True}))
        self.assertFalse(cqrs_probe.correct_path('F', {'read_source': 'absent', 'generation_matches': False}))

    def test_missing_blocks_or_mixed_profiles_are_inconclusive(self):
        self.assertEqual(study(qh=blocks(qh_member, {'O': BASE, 'F': BASE}, count=2))['decision'], 'INCONCLUSIVE')
        mixed = blocks(qh_member, {'O': BASE, 'F': BASE})
        mixed[2]['profileKeySha256'] = 'k2'
        self.assertEqual(study(qh=mixed)['workloads'][0]['status'], 'INCONCLUSIVE_INSUFFICIENT_MATCHED_BLOCKS')

    def test_incomplete_cpu_coverage_never_passes(self):
        qh = blocks(qh_member, {'O': BASE, 'F': BASE}, per_block={(2, 'F'): {'latency': BASE, 'cpu': (False, 100.0)}})
        result = study(qh=qh)
        self.assertEqual(result['workloads'][0]['gates']['cpuPerSuccessFtoO']['status'], 'TOTAL_COST_INCONCLUSIVE')
        self.assertEqual(result['decision'], 'INCONCLUSIVE')


class ControllerTests(unittest.TestCase):
    def test_controller_rebinds_identity_overlay_and_grader(self):
        import final_study
        base = final_study.base
        self.assertEqual(base.STUDY, 'cqrs-final-matched-kaggle-v1')
        self.assertEqual(base.POLICY, make_final_policy.TARGET.relative_to(make_final_policy.REPO).as_posix())
        self.assertEqual(base.BUNDLE_SHA, make_final_policy.BUNDLE_SHA)
        self.assertEqual(base.OVERLAY[0], 'benchmarks/phase2/kaggle/final_trial.py')
        self.assertIn('benchmarks/phase2/kaggle/list_trial.py', base.OVERLAY)
        self.assertIs(base.ev, fe)
        self.assertIs(base.Study, final_study.Study)
        for name in (*base.OVERLAY, *base.BENCH, *base.CONTROLLER):
            self.assertTrue((make_final_policy.REPO / name).is_file(), name)

    def test_runner_accepts_only_o_and_f(self):
        import final_trial
        with self.assertRaises(SystemExit):
            final_trial.main(['--workload', 'pcn', '--configuration', 'A', '--mode', 'smoke', '--output', 'x', '--ledger', 'y'])


if __name__ == '__main__':
    unittest.main()
