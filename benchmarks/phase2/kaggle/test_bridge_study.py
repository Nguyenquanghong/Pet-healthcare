"""Offline checks for the M/H bridge studies (Kaggle v1 and VM v1): booking grid, ABBA and balanced-order grading,
member metrics, VM configurations and pinning, archive validation, and the harness the VM study runs on: worker layouts, Prisma pool,
application_name, the pg_stat_activity sampler, 800 owners."""
import base64
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import MagicMock, mock_open, patch
import zipfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(HERE))
import bridge_study as bs  # noqa: E402
import make_bridge_notebook as nb  # noqa: E402
import native_stack  # noqa: E402
# Under another name: mixed discovery also sees the phase-1 command-line runner called pcn_runner.
spec = importlib.util.spec_from_file_location('phase2_pcn_runner_bridge', HERE / 'pcn_runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


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
    def write(self, directory, *, users=2, completed=True, missing=0, pinning=None, scale=1.0):
        settings = {'users': users, 'seconds': 30, 'warmup': 2, 'spawn_rate': 10}
        d = Path(directory)
        manifest = {'status': 'COMPLETE', 'process_sample_errors': 0}
        if pinning is not None:
            manifest['pinning'] = pinning
        (d / 'manifest.json').write_text(json.dumps(manifest))
        (d / 'pcn-report.json').write_text(json.dumps({'raw_counts_match': True, 'success_rps': 2.0, 'load_status': 'PASS_IN_SCOPE'}))
        (d / 'load-final.json').write_text(json.dumps({'completed': completed, 'observed_user_min': users, 'error_rate': 0.0}))
        (d / 'reconciliation.json').write_text(json.dumps({'missing_success_ids': missing, 'duplicate_active_slots': 0,
                                                           'duplicate_response_ids': 0, 'unexpected_child_exit': False,
                                                           'writes_without_success_response': 0}))
        rows = [{'started_seconds': float(ms), 'name': 'GET pets', 'response_time_ms': float(ms) * scale, 'failed': False, 'response_bytes': 50}
                for ms in range(1, 101)]
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

    def test_v1_metrics_carry_no_late_key_and_late_window_is_extra(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = self.write(directory)
            plain = bs.member_metrics(directory, settings)
            self.assertNotIn('late', plain)
            late = bs.member_metrics(directory, settings, late_from=10)
            self.assertEqual({k: v for k, v in late.items() if k != 'late'}, plain)
            tail = late['late']
            self.assertEqual(tail['requests'], 91)  # started_seconds 10..100
            self.assertEqual(tail['p95_ms'], 96.0)  # nearest rank over 10..100
            self.assertAlmostEqual(tail['success_rps'], 91 / 20)
            self.assertAlmostEqual(tail['server_cores'], 0.3)
            self.assertAlmostEqual(tail['cpu_ms_per_success'], 0.3 * 1000 / (91 / 20))
            self.assertEqual(tail['operations']['GET pets']['requests'], 91)
            # A window no longer than late_from has no late part.
            self.assertIsNone(bs.member_metrics(directory, settings, late_from=30)['late'])

    def test_pinning_must_be_verified(self):
        for pinning, valid in ((None, True), ({'generator': [0], 'server': [1], 'verified': True}, True),
                               ({'generator': [0], 'server': [1], 'verified': False}, False), ({'generator': [0], 'server': [1]}, False)):
            with tempfile.TemporaryDirectory() as directory:
                settings = self.write(directory, pinning=pinning)
                m = bs.member_metrics(directory, settings)
                self.assertEqual(m['valid'], valid, m['reasons'])
                self.assertEqual('pinning not applied' in m['reasons'], not valid)


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

    def test_the_booking_grid_gives_800_owners_a_slot_each_after_the_fixture_visits(self):
        # Load without locust: the module only needs the adapter's names, so a stub stands in for them.
        class Stub:
            def appointment(self):
                pass

            def rescue(self):
                pass

            def on_start(self):
                pass
            tasks = [appointment, rescue]
        legacy = types.SimpleNamespace(PcnUser=Stub, USERS=[{}] * 800)
        with patch.dict(sys.modules, {'pcn_locust': types.SimpleNamespace(legacy=legacy)}):
            spec = importlib.util.spec_from_file_location('bridge_locust_800', HERE / 'bridge_locust.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        # Each user books at index round * users + its own offset; 60 rounds of 800 is more than a 300 s window at 800 users books.
        slots = [module.booking(number * 800 + offset) for number in range(60) for offset in range(800)]
        self.assertEqual(len(set(slots)), len(slots))  # no slot twice, so none is full and no pet overlaps its own booking
        self.assertGreater(min(day for day, _ in slots), '2098-12-31')  # after the fixture visits (2098-01-01 .. 2098-02-12) and stays (to 2098-07-10)
        self.assertLess(max(day for day, _ in slots), '2200-01-01')
        self.assertEqual({t for _, t in slots}, {f'{m // 60:02d}:{m % 60:02d}' for m in range(480, 1021, 30)})  # the 19 slots of 08:00-17:00


TRUE_P95 ={'M': 10.0, 'H0': 50.0, 'H1': 40.0, 'H2': 30.0}
TRUE_CPU = {'M': 0.5, 'H0': 2.0, 'H1': 1.6, 'H2': 1.6}


def vm_members(drift=1.0, p95=TRUE_P95, cpu=TRUE_CPU, late=None):
    """One member per position of VM_ORDER; the host slows by `drift` per position, the work per request stays put."""
    members = []
    for position, name in enumerate(bs.VM_ORDER):
        slow = drift ** position
        m = member(p95[name] * slow, cpu[name] * slow)
        if late is not None:
            m['late'] = {'p50_ms': m['p95_ms'] / 2 * late, 'p95_ms': m['p95_ms'] * late, 'success_rps': 90.0, 'server_cores': m['server_cores'],
                         'cpu_ms_per_success': m['cpu_ms_per_success'], 'operations': {k: {'p95_ms': v['p95_ms'] * late} for k, v in m['operations'].items()}}
        members.append(m)
    return members


class VmGrading(unittest.TestCase):
    def test_order_is_balanced_and_every_pair_is_adjacent(self):
        self.assertEqual(bs.VM_ORDER, ('M', 'H0', 'H1', 'H2', 'H2', 'H1', 'H0', 'M'))
        self.assertEqual(bs.VM_SMOKE_ORDER, ('M', 'H0', 'H1', 'H2'))
        self.assertEqual({c: bs.VM_ORDER.count(c) for c in bs.VM_SMOKE_ORDER}, {c: 2 for c in bs.VM_SMOKE_ORDER})
        self.assertEqual([(label, bs.pair_indices(bs.VM_ORDER, base, other)) for label, base, other in bs.VM_COMPARISONS],
                         [('H0/M', [(0, 1), (7, 6)]), ('H1/H0', [(1, 2), (6, 5)]), ('H2/H1', [(2, 3), (5, 4)])])
        for bad in (('M', 'H0', 'H1', 'M'), ('M', 'H0', 'H0', 'M', 'H1', 'H1')):
            with self.assertRaises(ValueError):
                bs.pair_indices(bad, 'M', 'H1')

    def test_configurations_are_trees_and_core_instances(self):
        self.assertEqual({c: bs.vm_member_plan(c) for c in bs.VM_SMOKE_ORDER},
                         {'M': ('M', 1), 'H0': ('H0', 1), 'H1': ('H1', 1), 'H2': ('H1', 2)})

    def test_linear_drift_cancels_in_all_three_ratios(self):
        for drift in (1.0, 1.07):
            result = bs.compare_vm(vm_members(drift))
            self.assertEqual(result['decision'], 'COMPARED')
            expected = {'H0/M': 5.0, 'H1/H0': 0.8, 'H2/H1': 0.75}
            for label, ratio in expected.items():
                entry = result['comparisons'][label]
                self.assertAlmostEqual(entry['operations']['GET pets']['p95_ratio'], ratio, places=9)
                self.assertAlmostEqual(entry['overall_ratios']['p95_ms'], ratio, places=9)
            cpu = {label: result['comparisons'][label]['overall_ratios']['cpu_ms_per_success'] for label in expected}
            self.assertAlmostEqual(cpu['H0/M'], 4.0)
            self.assertAlmostEqual(cpu['H1/H0'], 0.8)
            self.assertAlmostEqual(cpu['H2/H1'], 1.0)
            self.assertEqual(result['comparisons']['H0/M']['overall_p95_reading'], 'H0 chậm hơn')
            self.assertEqual(result['comparisons']['H1/H0']['overall_p95_reading'], 'H1 nhanh hơn')
            self.assertEqual(result['comparisons']['H1/H0']['cpu_per_success_reading'], 'H1 nhanh hơn')
            self.assertEqual(result['comparisons']['H2/H1']['cpu_per_success_reading'], 'tương đương')
            self.assertEqual(result['comparisons']['H2/H1']['operations']['POST appointment']['reading'], 'H2 nhanh hơn')

    def test_ratio_is_the_geometric_mean_of_forward_and_reverse(self):
        members = vm_members()
        # H0/M: forward pair (M0, H0@1) reads 2.0, reverse pair (H0@6, M7) reads 0.5: the mean is 1.
        for index, value in ((0, 10.0), (1, 20.0), (6, 10.0), (7, 20.0)):
            members[index] = member(value)
        entry = bs.compare_vm(members)['comparisons']['H0/M']['operations']['GET pets']
        self.assertEqual(entry['p95_pair_ratios'], [2.0, 0.5])
        self.assertAlmostEqual(entry['p95_ratio'], 1.0)
        self.assertEqual(entry['reading'], 'tương đương')
        self.assertEqual(entry['p95_ms'], {'base': [10.0, 20.0], 'other': [20.0, 10.0]})

    def test_invalid_or_partial_runs_are_not_compared(self):
        members = vm_members()
        members[5] = member(40.0, valid=False)
        invalid = bs.compare_vm(members)
        self.assertEqual(invalid['decision'], 'INVALID')
        self.assertTrue(invalid['invalid'][0].startswith('5:H1: '))
        self.assertEqual(bs.compare_vm(vm_members()[:5])['decision'], 'NOT_RUN')
        members = vm_members()
        del members[3]['operations']['POST appointment']
        self.assertEqual(bs.compare_vm(members)['invalid'], ['operation missing: POST appointment'])

    def test_exploratory_late_window_is_labelled_and_only_present_with_data(self):
        self.assertNotIn('exploratory_late', bs.compare_vm(vm_members())['comparisons']['H0/M'])
        late = bs.compare_vm(vm_members(late=0.5))['comparisons']['H1/H0']['exploratory_late']
        self.assertIn('EXPLORATORY', late['label'])
        self.assertEqual(late['from_seconds'], bs.LATE_FROM)
        self.assertAlmostEqual(late['overall_ratios']['p95_ms'], 0.8)
        self.assertAlmostEqual(late['p95_ratios']['GET pets'], 0.8)

    def test_v1_grading_and_band_labels_are_unchanged(self):
        self.assertEqual(bs.ORDER, ('M', 'H', 'H', 'M'))
        self.assertEqual(bs.STUDY, 'bridge-m-h-kaggle-v1')
        self.assertEqual((bs.band(0.9), bs.band(1.0), bs.band(1.1)), ('H nhanh hơn', 'tương đương', 'H chậm hơn'))
        self.assertEqual((bs.band(0.9, 'H2'), bs.band(1.1, 'H2'), bs.band(None, 'H2')), ('H2 nhanh hơn', 'H2 chậm hơn', None))


class VmPinning(unittest.TestCase):
    def test_generator_gets_the_lowest_cpu_and_servers_the_rest(self):
        self.assertEqual(bs.plan_pinning({7, 0, 3, 1, 2, 4, 5, 6}),
                         {'generator': [0], 'server': [1, 2, 3, 4, 5, 6, 7], 'smt_siblings_left_idle': [], 'thread_siblings_list': None})
        self.assertEqual(bs.plan_pinning([2, 3, 5])['server'], [3, 5])
        with self.assertRaisesRegex(RuntimeError, 'VM_NEEDS_2_CPUS: found 1 usable CPU'):
            bs.plan_pinning({0})

    def test_the_smt_sibling_of_the_generator_cpu_stays_idle(self):
        self.assertEqual(bs.parse_cpu_list('0,4'), {0, 4})
        self.assertEqual(bs.parse_cpu_list('0-1\n'), {0, 1})
        self.assertEqual(bs.parse_cpu_list('2,5-7'), {2, 5, 6, 7})
        plan = bs.plan_pinning(range(8), '0,4\n')
        self.assertEqual((plan['generator'], plan['server'], plan['smt_siblings_left_idle'], plan['thread_siblings_list']),
                         ([0], [1, 2, 3, 5, 6, 7], [4], '0,4'))
        self.assertEqual(bs.plan_pinning(range(8), '0-1')['server'], [2, 3, 4, 5, 6, 7])
        self.assertEqual(bs.plan_pinning(range(8), '0')['smt_siblings_left_idle'], [])  # no SMT: only itself
        message = 'VM_NO_SERVER_CPU_AFTER_SMT_EXCLUSION.*' + re.escape('SMT sibling(s) [1]') + '.*' + re.escape("thread_siblings_list '0-1'")
        with self.assertRaisesRegex(RuntimeError, message):
            bs.plan_pinning([0, 1], '0-1')  # the only other CPU is the sibling

    def test_taskset_prefix_only_when_pinning(self):
        self.assertEqual(runner.taskset_prefix(None), [])
        self.assertEqual(runner.taskset_prefix({'generator': [0], 'server': [1, 2]}), ['taskset', '-c', '0'])

    def test_observed_affinity_verifies_the_split(self):
        affinities = {1: [0], 2: [3, 1, 2], 3: [1, 2, 3]}
        def process(pid):
            if pid not in affinities:
                raise ProcessLookupError(pid)
            return types.SimpleNamespace(cpu_affinity=lambda: affinities[pid])
        fake = types.SimpleNamespace(NoSuchProcess=ProcessLookupError, AccessDenied=PermissionError, Process=process)
        pinning = {'generator': [0], 'server': [1, 2, 3]}
        tracked = [('generator', 1, False), ('core', 2, False), ('nginx', 3, True), ('gone', 4, False)]
        with patch.dict(sys.modules, {'psutil': fake}):
            seen = runner.observed_affinity(tracked, pinning)
            self.assertEqual(seen, {'observed': {'generator': [0], 'core': [1, 2, 3], 'nginx': [1, 2, 3]}, 'verified': True})
            affinities[2] = [0, 1]  # a server leaking onto the generator CPU
            self.assertFalse(runner.observed_affinity(tracked, pinning)['verified'])
            affinities[2], affinities[1] = [1], [0, 1]  # a generator that is not alone
            self.assertFalse(runner.observed_affinity(tracked, pinning)['verified'])
            self.assertFalse(runner.observed_affinity([('core', 2, False)], pinning)['verified'])  # no generator seen
            # The controller (sampler) belongs on the generator CPU, not among the servers.
            affinities.update({1: [0], 2: [1, 2, 3], 5: [0]})
            self.assertTrue(runner.observed_affinity(tracked + [('controller', 5, False)], pinning)['verified'])
            affinities[5] = [1, 2, 3]
            self.assertFalse(runner.observed_affinity(tracked + [('controller', 5, False)], pinning)['verified'])

    def test_servers_start_under_taskset_and_the_controller_stays_out(self):
        self.assertEqual(runner.server_taskset_prefix(None), [])
        self.assertEqual(runner.server_taskset_prefix([1, 2, 3]), ['taskset', '-c', '1,2,3'])
        with patch('native_stack.platform.system', return_value='Linux'), patch('native_stack.Path.mkdir'):
            plain = native_stack.NativeStack(REPO, accounts=2, dataset_profile='pcn')
            pinned = native_stack.NativeStack(REPO, accounts=2, dataset_profile='pcn', server_cpus=[1, 2, 3], core_proxy=True, core_replicas=2)
        self.assertEqual((plain.server_prefix, plain.core_proxy, plain.core_replicas), ([], False, 1))
        self.assertEqual((pinned.server_prefix, pinned.core_proxy, pinned.core_replicas), (['taskset', '-c', '1,2,3'], True, 2))
        # Every command and every long-running process of the stack goes through the prefix.
        with patch('native_stack.subprocess.run') as run, patch('native_stack.subprocess.Popen') as popen, \
                patch('pathlib.Path.open', mock_open()):
            pinned.command(['initdb', '-D', 'x'])
            pinned.start_process('redis', ['redis-server', 'conf'])
            plain.command(['initdb', '-D', 'x'])
        self.assertEqual(run.call_args_list[0].args[0], ['taskset', '-c', '1,2,3', 'initdb', '-D', 'x'])
        self.assertEqual(popen.call_args.args[0], ['taskset', '-c', '1,2,3', 'redis-server', 'conf'])
        self.assertEqual(run.call_args_list[1].args[0], ['initdb', '-D', 'x'])

    def test_core_proxy_and_server_cpus_are_validated(self):
        with patch('native_stack.platform.system', return_value='Linux'), patch('native_stack.Path.mkdir') as mkdir:
            for kwargs in ({'core_replicas': 3}, {'core_replicas': 2, 'dataset_profile': 'deep'}, {'core_proxy': True, 'dataset_profile': 'deep'},
                           {'core_proxy': True, 'dataset_profile': 'pcn', 'cqrs_configuration': 'O'}, {'core_proxy': 1},
                           {'server_cpus': []}, {'server_cpus': ['1']}):
                with self.assertRaises(ValueError, msg=str(kwargs)):
                    native_stack.NativeStack(REPO, **{'accounts': 2, 'dataset_profile': 'pcn', **kwargs})
        mkdir.assert_not_called()


class VmStudyFlow(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / 'src'
        self.root.mkdir()
        self.private, self.output = Path(self.directory.name) / 'private', Path(self.directory.name) / 'results'
        self.private.mkdir()

    def study(self, mode='full'):
        return bs.VmStudy(self.root, self.private, self.output, 'run-1', mode=mode, progress=lambda text: None)

    def test_member_runs_each_configuration_on_its_tree(self):
        study = self.study()
        study.pinning = {'generator': [0], 'server': [1, 2]}
        monolith, pcn = MagicMock(), MagicMock()
        with patch.dict(sys.modules, {'bridge_monolith': types.SimpleNamespace(run_monolith=monolith),
                                      'pcn_runner': types.SimpleNamespace(run_pcn=pcn)}):
            for index, configuration in enumerate(bs.VM_ORDER[:4]):
                study.member(index, configuration, bs.SMOKE, 'smoke')
            study.member(7, 'H2', bs.FULL, 'full')
        self.assertEqual(monolith.call_count, 1)
        self.assertEqual(monolith.call_args.args[:2], (self.root / 'M', self.root / 'H1'))
        self.assertEqual(monolith.call_args.kwargs['pinning'], study.pinning)
        seen = [(c.args[0].name, c.kwargs['core_replicas'], c.kwargs['mode']) for c in pcn.call_args_list]
        self.assertEqual(seen, [('H0', 1, 'smoke'), ('H1', 1, 'smoke'), ('H1', 2, 'smoke'), ('H1', 2, 'full')])
        for call in pcn.call_args_list:
            self.assertEqual(call.kwargs['service_env'], bs.H_LIMITS)
            self.assertEqual(call.kwargs['pinning'], study.pinning)
            self.assertTrue(call.kwargs['vm'])
            self.assertTrue(call.kwargs['core_proxy'])  # H0, H1 and H2 all reach Core through the same nginx hop
            self.assertEqual(call.kwargs['locustfile'], bs.LOCUSTFILE)
        self.assertEqual([s['stage'] for s in study.stages][:2], ['smoke-0-M', 'smoke-1-H0'])

    def test_execute_runs_smoke_then_the_balanced_order_and_exports_a_directory(self):
        helper = MemberMetrics()
        settings = {'users': 2, 'seconds': 30, 'warmup': 2, 'spawn_rate': 10}
        (self.root / 'bundle-manifest.json').write_text(json.dumps({'mCommit': 'm', 'h0Commit': 'h0', 'h1Commit': 'h1', 'files': [1]}))
        order = []
        study = self.study()
        study.stages = []

        def fake_member(index, configuration, wanted, label):
            order.append((label, configuration))
            directory = study.private / 'members' / f'{label}-{index}-{configuration}'
            directory.mkdir(parents=True)
            helper.write(directory, pinning={'generator': [0], 'server': [1], 'verified': True})
            return directory
        with patch.object(bs, 'FULL', settings), patch.object(bs, 'SMOKE', settings), patch.object(bs, 'LATE_FROM', 10), \
                patch.object(study, 'member', fake_member), patch.object(study, 'versions', return_value={}), \
                patch.object(study, 'build'), patch.object(study, 'before_members'):
            study.pinning = {'generator': [0], 'server': [1]}
            result = study.execute(install=False)
        self.assertEqual(order, [('smoke', c) for c in bs.VM_SMOKE_ORDER] + [('full', c) for c in bs.VM_ORDER])
        self.assertEqual((result['study'], result['status'], result['comparison']['decision']), (bs.VM_STUDY, 'COMPLETE', 'COMPARED'))
        self.assertEqual(set(result['comparison']['comparisons']), {'H0/M', 'H1/H0', 'H2/H1'})
        self.assertEqual(result['vm']['sources']['h1Commit'], 'h1')
        self.assertEqual(result['vm']['pinning'], {'generator': [0], 'server': [1]})
        self.assertTrue(any('Notification' in text for text in result['vm']['harnessChanges']))
        self.assertEqual(Path(result['download']), self.output)
        self.assertTrue((self.output / 'reports/evaluation.json').is_file())
        self.assertTrue((self.output / 'bundle-manifest.json').is_file())
        self.assertTrue((self.output / 'members/full-3-H2/manifest.json').is_file())
        self.assertFalse(any(p.suffix == '.log' for p in self.output.rglob('*')))

    def test_smoke_mode_stops_after_the_gate_and_a_failed_smoke_blocks_the_study(self):
        helper = MemberMetrics()
        settings = {'users': 2, 'seconds': 30, 'warmup': 2, 'spawn_rate': 10}
        for mode, broken, status in (('smoke', None, 'SMOKE_PASSED'), ('full', 'H2', 'SMOKE_FAILED')):
            self.private = Path(self.directory.name) / ('private-' + mode)
            self.private.mkdir()
            study, order = self.study(mode), []
            study.output = Path(self.directory.name) / ('results-' + mode)

            def fake_member(index, configuration, wanted, label):
                order.append((label, configuration))
                directory = study.private / 'members' / f'{label}-{index}-{configuration}'
                directory.mkdir(parents=True)
                helper.write(directory, completed=configuration != broken)
                return directory
            with patch.object(bs, 'SMOKE', settings), patch.object(study, 'member', fake_member), patch.object(study, 'versions', return_value={}), \
                    patch.object(study, 'build'), patch.object(study, 'before_members'):
                result = study.execute(install=False)
            self.assertEqual(result['status'], status)
            self.assertEqual(order, [('smoke', c) for c in bs.VM_SMOKE_ORDER])


class KaggleStudyFlow(unittest.TestCase):
    """The refactored Study.execute still runs the v1 order: smoke M,H, then M,H,H,M, exported as a zip."""

    def test_v1_order_and_zip_export_are_unchanged(self):
        helper = MemberMetrics()
        settings = {'users': 2, 'seconds': 30, 'warmup': 2, 'spawn_rate': 10}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'bundle-manifest.json').write_text('{}')
            study = bs.Study(root / 'M', root / 'H', root / 'private', root / 'bridge-run', 'r1', mode='full', progress=lambda text: None)
            (root / 'private').mkdir()
            order = []

            def fake_member(index, configuration, wanted, label):
                order.append((label, configuration))
                directory = study.private / 'members' / f'{label}-{index}-{configuration}'
                directory.mkdir(parents=True)
                helper.write(directory)
                return directory
            with patch.object(bs, 'FULL', settings), patch.object(bs, 'SMOKE', settings), patch.object(study, 'member', fake_member), \
                    patch.object(study, 'versions', return_value={}), patch.object(study, 'build'):
                result = study.execute(install=False)
            self.assertEqual(order, [('smoke', 'M'), ('smoke', 'H')] + [('full', c) for c in ('M', 'H', 'H', 'M')])
            self.assertEqual((result['study'], result['status'], result['comparison']['decision']), (bs.STUDY, 'COMPLETE', 'COMPARED'))
            self.assertNotIn('vm', result)
            self.assertNotIn('late', result['members'][0])
            self.assertEqual(Path(result['download']), root / 'bridge-run.zip')
            with zipfile.ZipFile(result['download']) as archive:
                names = set(archive.namelist())
            self.assertIn('reports/evaluation.json', names)
            self.assertIn('bundle-manifest.json', names)
            self.assertIn('members/full-3-M/manifest.json', names)


class HarnessSource(unittest.TestCase):
    """stack.mjs is a script that starts a stack, so its gateway rules are checked as text."""
    text = (HERE / 'stack.mjs').read_text(encoding='utf-8')
    # The directive word is not written in this file (tools/phase2/gateway-routing.mjs sweeps it for proxies): the locations are matched by shape.
    CORE_LOCATION = 'location /api/ { ${coreGateway} '
    OWNED_LOCATION = re.compile(r'location ~ \^/api/\S+ \{ \$\{headers\} [^;]*; \} ')

    def template(self, name):
        found = re.findall(r'const ' + name + r'=`([^`]*)`', self.text)
        self.assertEqual(len(found), 1, name)
        return found[0]

    def test_the_gateway_topology_comes_from_the_context_and_picks_one_of_two_templates(self):
        self.assertIn("const gatewayTopology=context.gatewayTopology??'direct';", self.text)  # absent in every older context: direct
        self.assertIn("assert.ok(['direct','core-ingress'].includes(gatewayTopology),", self.text)
        self.assertIn("const config=gatewayTopology==='core-ingress'?coreIngressConfig:directConfig;", self.text)
        self.assertLess(self.text.index("const gatewayTopology="), self.text.index('const coreEdge='))
        self.assertLess(self.text.index('const directConfig='), self.text.index('const coreIngressConfig='))
        self.assertLess(self.text.index('const coreIngressConfig='), self.text.index('const config='))
        self.assertEqual(self.text.count('const config='), 1)
        self.assertIn("assert.equal(gatewayTopology,'direct');", self.text)  # the CQRS studies run the direct gateway only
        self.assertIn("gateway:{topology:gatewayTopology,notificationsRoute:gatewayTopology==='direct'?'direct-to-notification':'through-core',", self.text)
        self.assertNotIn('@nipopeto/contracts', self.text)  # the H1 tree predates the contracts module: the routing lives in the two templates

    def test_direct_sends_the_owned_prefixes_to_their_services_and_core_ingress_sends_them_to_core(self):
        direct, ingress = self.template('directConfig'), self.template('coreIngressConfig')
        owned = self.OWNED_LOCATION.findall(direct)
        self.assertEqual(len(owned), 2)
        self.assertTrue(owned[0].startswith('location ~ ^/api/(appointments|medical-records|dashboard/clinic)(/|$) { ${headers} '))
        self.assertTrue(owned[1].startswith('location ~ ^/api/notifications(/|$) { ${headers} '))
        self.assertTrue(owned[1].endswith(' ${origins.notification}; } '))
        self.assertLess(direct.index(owned[1]), direct.index(self.CORE_LOCATION))
        self.assertEqual(self.OWNED_LOCATION.findall(ingress), [])
        for needle in ('/api/(appointments', 'dashboard/clinic', '/api/notifications', 'origins.notification'):
            self.assertNotIn(needle, ingress)
        for config in (direct, ingress):
            self.assertRegex(config, re.escape(self.CORE_LOCATION) + r'\w+ http://core; \}')

    def test_the_two_templates_differ_only_in_the_locations_the_gateway_owns(self):
        direct, ingress = self.template('directConfig'), self.template('coreIngressConfig')
        self.assertNotEqual(direct, ingress)
        self.assertEqual(self.OWNED_LOCATION.sub('', direct), ingress)

    def test_both_templates_raise_the_nginx_descriptors_and_connections(self):
        for name in ('directConfig', 'coreIngressConfig'):
            config = self.template(name)
            self.assertIn(' worker_rlimit_nofile 8192; events { worker_connections 4096; } ', config)
            self.assertEqual(config.count('worker_connections'), 1)
        self.assertNotIn('worker_connections 1024', self.text)

    def test_core_layouts_are_exact_and_the_context_must_name_the_one_the_tree_has(self):
        self.assertIn("const CORE_LAYOUTS={workers:{notification:'backend/dist/src/workers/notification.js',billing:'backend/dist/src/workers/billing.js'},"
                      "phase2:{notification:'backend/dist/src/phase2/notificationWorker.js',billing:'backend/dist/src/phase2/billingWorker.js'}};", self.text)
        self.assertIn("const coreLayout=context.coreLayout??'workers';", self.text)  # absent in every older context: the tree of today
        self.assertRegex(self.text, r"import \{[^}]*\bexistsSync\b[^}]*\} from 'node:fs';")
        self.assertIn('const builtLayouts=Object.keys(CORE_LAYOUTS).filter(name=>Object.values(CORE_LAYOUTS[name]).every(file=>existsSync(file)));', self.text)
        # Exactly one layout is built, and it is the one the context names; checked before any database is touched.
        self.assertIn('assert.deepEqual(builtLayouts,[coreLayout],', self.text)
        self.assertLess(self.text.index('assert.deepEqual(builtLayouts'), self.text.index('const clients='))
        # Both Core workers take their path from the table: each path is written once.
        self.assertIn("await child('core-outbox',CORE_LAYOUTS[coreLayout].notification,{", self.text)
        self.assertIn("await child('billing-worker',CORE_LAYOUTS[coreLayout].billing,{", self.text)
        self.assertEqual(self.text.count('backend/dist/src/workers/'), 2)
        self.assertEqual(self.text.count('backend/dist/src/phase2/'), 2)
        self.assertIn('coreLayout,dbPoolLimit,coreUpstream:', self.text)  # ready.json.gateway records both

    def test_the_layout_paths_exist_in_the_trees_they_name(self):
        table = dict((name, (n, b)) for name, n, b in re.findall(r"(workers|phase2):\{notification:'([^']+)',billing:'([^']+)'\}", self.text))
        self.assertEqual(set(table), {'workers', 'phase2'})
        source = lambda built: re.sub(r'\.js$', '.ts', built.replace('/dist/', '/'))
        if not (HERE.parents[2] / 'backend/src/workers').is_dir():
            self.skipTest('product source not in this tree')
        for built in table['workers']:
            self.assertTrue((HERE.parents[2] / source(built)).is_file(), built)  # H3, the tree of today
        for built in table['phase2']:
            self.assertFalse((HERE.parents[2] / source(built)).exists(), built)  # exactly one layout in a tree
        try:  # H1, 2841d1b: the tree before backend/src/phase2 was split up
            listing = nb.git('ls-tree', '-r', '--name-only', '2841d1b', 'backend/src/phase2', 'backend/src/workers').decode().split()
        except (OSError, nb.subprocess.CalledProcessError):
            self.skipTest('commit 2841d1b not available here')
        for built in table['phase2']:
            self.assertIn(source(built), listing)
        self.assertFalse([name for name in listing if name.startswith('backend/src/workers/')])

    def test_the_prisma_pool_comes_from_the_context_between_4_and_8(self):
        self.assertIn('const dbPoolLimit=context.dbPoolLimit??4;', self.text)  # absent in every older context: 4
        self.assertIn('Number.isInteger(dbPoolLimit)&&dbPoolLimit>=4&&dbPoolLimit<=8', self.text)
        self.assertLess(self.text.index('const dbPoolLimit='), self.text.index('const clients='))
        self.assertIn('DB_POOL_LIMIT:String(dbPoolLimit),', self.text)
        self.assertNotIn("DB_POOL_LIMIT:'4'", self.text)
        # The CQRS studies keep today's layout and the pool of 4.
        self.assertIn("assert.equal(coreLayout,'workers');assert.equal(dbPoolLimit,4);", self.text)

    def test_every_process_names_its_database_connections_after_itself(self):
        self.assertIn("const withApplicationName=(url,name)=>{const u=new URL(url);u.searchParams.set('application_name','p8-'+name);return u.toString();};", self.text)
        self.assertIn('if(env.DATABASE_URL)env.DATABASE_URL=withApplicationName(env.DATABASE_URL,name);', self.text)
        self.assertIn('spawn(process.execPath,[file],{env,stdio:', self.text)
        # The name is the one of the process (p8-core, or p8-core-0 and p8-core-1; p8-clinic-0, p8-clinic-1; p8-notification-worker ...), never one per kind of service.
        calls = re.findall(r"child\(((?:'[a-z-]+'|coreReplicas===1\?'core':'core-'\+i|'clinic-'\+i)),", self.text)
        self.assertEqual(calls, ["'clinic-read-worker'", "coreReplicas===1?'core':'core-'+i", "'clinic-'+i", "'notification'", "'core-outbox'",
                                 "'clinic-worker'", "'notification-worker'", "'billing-worker'"])
        self.assertEqual(self.text.count('DATABASE_URL:context.urls.'), len(calls))  # every one of them is given a database URL to name
        self.assertEqual(self.text.count('withApplicationName('), 1)  # one call, in child(), for every process
        self.assertEqual(native_stack.PgSampler.QUERY.count("'^(p8-|m-api$)'"), 1)  # what the sampler looks for: these names and the monolith's

    def test_the_database_url_function_of_the_services_keeps_the_application_name_and_the_engine_knows_it(self):
        config = HERE.parents[2] / 'packages/runtime/src/config.ts'
        if not config.is_file():
            self.skipTest('product source not in this tree')
        text = config.read_text(encoding='utf-8')
        # databaseUrl() starts from the URL it is given and sets these three only: any other parameter, application_name, stays as given.
        self.assertRegex(text, r'url = new URL\(value\);')
        self.assertEqual(sorted(re.findall(r"url\.searchParams\.set\('(\w+)'", text)), ['connect_timeout', 'connection_limit', 'pool_timeout'])
        self.assertRegex(text, r"integer\('DB_POOL_LIMIT',\s*4,\s*1,\s*32\)")
        engines = [p for pattern in ('libquery_engine*.node', 'query_engine*.node') for p in (HERE.parents[2] / 'node_modules/@prisma/engines').glob(pattern)]
        if not engines:
            self.skipTest('no Prisma query engine installed here')
        # The connection string of the engine reads application_name (quaint's PostgreSQL URL); a string search, not a connection.
        self.assertIn(b'application_name', engines[0].read_bytes())

    def test_core_upstreams_instances_and_the_internal_hop(self):
        self.assertEqual(self.text.count('upstream core { ${coreServers} }'), 2)  # one per template
        self.assertEqual(self.text.count(self.CORE_LOCATION), 2)
        self.assertIn("const coreServers=corePorts.map(p=>'server 127.0.0.1:'+p+' max_fails=0;').join(' ');", self.text)
        # coreProxy (set by the VM study for every H configuration, forced by two instances): ports.core is an nginx listener in front of
        # core_internal, which keeps connections alive; one hop, the same for one Core or two. Everything else keeps the plain single Core.
        self.assertIn('const coreProxy=context.coreProxy===true||coreReplicas>1;', self.text)
        self.assertIn('if(!coreProxy)corePorts.push(ports.core);else for(let n=0;n<coreReplicas;n++)corePorts.push(await port());', self.text)
        edge = self.text[self.text.index('const coreEdge='):self.text.index('const directConfig=')]
        for needle in ('upstream core_internal { ${coreServers} keepalive 16; keepalive_timeout 4s; }', 'proxy_http_version 1.1;',
                       'proxy_set_header Connection "";', 'proxy_set_header X-Request-ID $core_req_id;', 'proxy_next_upstream off;',
                       ' http://core_internal; }', 'map $http_x_request_id $core_req_id { default $http_x_request_id; "" $request_id; }',
                       'listen 127.0.0.1:${ports.core};'):
            self.assertIn(needle, edge)
        # No keepalive and no HTTP/1.1 upstream on the gateway path (or anywhere else).
        self.assertEqual(self.text.count('keepalive 16;'), 1)
        self.assertEqual(self.text.count('proxy_http_version'), 1)
        self.assertNotIn('keepalive', self.text[self.text.index("const headers='"):self.text.index('const coreServers=')])
        self.assertIn("SERVICE_INSTANCE_ID:coreReplicas===1?'p8-core':'p8-core-'+i", self.text)
        self.assertIn("...(coreReplicas>1?{HASH_CONCURRENCY:'1'}:{})", self.text)
        self.assertIn('const coreReplicas=context.coreReplicas??1;', self.text)
        self.assertIn('assert.equal(coreReplicas,1);assert.ok(!coreProxy);', self.text)  # the CQRS studies keep one, direct Core
        self.assertIn('the 28/10 handoff plan; resilience.test.mjs itself uses 2 per instance', self.text)

    def test_gateway_core_location_does_not_retry_when_core_is_proxied(self):
        headers = re.search(r"const headers='([^']*)';", self.text).group(1)
        self.assertEqual(headers, 'proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Request-ID $request_id; '
                                  'proxy_connect_timeout 1s; proxy_read_timeout 15s; proxy_next_upstream error timeout http_502 http_503 http_504;')
        needle = "headers.replace('proxy_next_upstream error timeout http_502 http_503 http_504;','proxy_next_upstream off;')"
        self.assertIn('const coreGateway=coreProxy?' + needle + ':headers;', self.text)
        self.assertIn('proxy_next_upstream error timeout http_502 http_503 http_504;', headers)  # the replace really finds its text
        replaced = headers.replace('proxy_next_upstream error timeout http_502 http_503 http_504;', 'proxy_next_upstream off;')
        self.assertEqual(replaced.count('proxy_next_upstream'), 1)  # one directive per location: nginx rejects a duplicate
        self.assertTrue(replaced.endswith('proxy_next_upstream off;'))
        # Only the Core location uses it; clinic and notification locations keep `headers` and the non-proxied gateway is the old string.
        self.assertEqual(self.text.count(self.CORE_LOCATION), 2)
        self.assertEqual(self.text.count('${coreGateway}'), 2)  # the Core location of each template, nowhere else
        self.assertEqual(self.text.count('location / { ${headers} '), 2)  # the Clinic edge server of each template
        self.assertEqual(self.text.count('/api/(appointments|medical-records|dashboard/clinic)(/|$) { ${headers} '), 1)  # direct only
        self.assertEqual(self.text.count('/api/notifications(/|$) { ${headers} '), 1)  # direct only

    def test_upstream_keepalive_stays_below_cores(self):
        core = HERE.parents[2] / 'backend/src/index.ts'
        if not core.is_file():
            self.skipTest('product source not in this tree')
        idle = int(re.search(r'keepAliveTimeout\s*=\s*(\d+)', core.read_text(encoding='utf-8')).group(1))
        configured = int(re.search(r'keepalive_timeout (\d+)s;', self.text).group(1))
        self.assertLess(configured * 1000, idle)

    def test_nginx_config_is_checked_before_nginx_starts(self):
        check = self.text.index("execFileSync('nginx',['-t','-p',dir+'/','-c',resolve(dir,'nginx.conf')]")
        self.assertLess(self.text.index("writeFileSync(resolve(dir,'nginx.conf'),config)"), check)
        self.assertLess(check, self.text.index("nginx=spawn('nginx'"))
        self.assertIn("throw new Error('nginx -t rejected the generated config: '+String(e.stderr??e.message).trim())", self.text)

    def test_vm_run_script_contract(self):
        script = (HERE / 'vm_run.sh').read_text(encoding='utf-8')
        for needle in ('sha256sum -c', '--platform vm', 'tar -czf', 'set -Eeuo pipefail', '--verify-extracted'):
            self.assertIn(needle, script)
        self.assertNotRegex(script, r'(?i)(password|secret|private key|token)\s*=')
        # The bundle hash is checked before anything is installed or executed, and sudo does not carry the caller's environment over.
        self.assertLess(script.index('sha256sum -c'), script.index('apt-get'))
        self.assertLess(script.index('--verify-extracted'), script.index('bridge_study.py'))
        self.assertNotIn('sudo -E', script)
        self.assertIn('exec sudo bash', script)
        # TOCTOU: the bundle is copied into the root-owned work directory first; the one hash check and the extraction use that copy.
        copy = script.index('install -m 0600 "$BUNDLE" "$WORK/bundle.zip"')
        self.assertLess(script.index('WORK=$(mktemp -d'), copy)
        self.assertLess(copy, script.index('sha256sum -c'))
        self.assertEqual(script.count('sha256sum -c'), 1)
        self.assertIn('sha256sum -c - >/dev/null', script)
        self.assertIn('"$SHA  $WORK/bundle.zip"', script)
        self.assertIn('unzip -q "$WORK/bundle.zip"', script)
        self.assertNotIn('unzip -q "$BUNDLE"', script)
        self.assertNotIn('$SHA  $BUNDLE', script)

    def test_shell_scripts_are_lf_in_the_repository(self):
        attributes = (HERE.parents[2] / '.gitattributes').read_text(encoding='utf-8').splitlines()
        self.assertIn('*.sh text eol=lf', attributes)


def activity_text(samples):
    """What PgSampler's psql writes: per sample one `epoch|name|busy|total` row for each application and a `*` row."""
    lines = []
    for moment, rows in samples:
        lines += [f'{moment:.3f}|{name}|{busy}|{total}' for name, (busy, total) in rows.items()] + [f'{moment:.3f}|*|0|0', '']
    return '\n'.join(lines) + '\n'


SAMPLES = [(100.0, {'p8-core': (4, 4), 'p8-clinic-0': (1, 3)}),
           (100.2, {'p8-core': (4, 4)}),  # p8-clinic-0 has no connection in this sample
           (100.4, {'p8-core': (2, 4), 'p8-clinic-0': (2, 3)}),
           (100.6, {'p8-core': (4, 4), 'p8-clinic-0': (0, 3)}),
           (100.8, {'p8-core': (1, 1)})]  # the last sample is dropped: the stop can cut it short


class OwnedStackOptions(unittest.TestCase):
    """800 owners, the worker layout and the Prisma pool reach NativeStack and its context."""

    def stack(self, **kwargs):
        with patch('native_stack.platform.system', return_value='Linux'), patch('native_stack.Path.mkdir'):
            return native_stack.NativeStack(REPO, **kwargs)

    def test_pcn_takes_800_owners_and_the_other_profiles_keep_their_limits(self):
        for kwargs in ({'accounts': 2, 'dataset_profile': 'pcn'}, {'accounts': 800, 'dataset_profile': 'pcn'}, {'accounts': 40},
                       {'accounts': 100, 'dataset_profile': 'query-heavy'}):
            self.stack(**kwargs)
        for kwargs in ({'accounts': 801, 'dataset_profile': 'pcn'}, {'accounts': 1, 'dataset_profile': 'pcn'}, {'accounts': 2.0, 'dataset_profile': 'pcn'},
                       {'accounts': 41}, {'accounts': 800, 'dataset_profile': 'query-heavy'}, {'accounts': 99, 'dataset_profile': 'query-heavy'},
                       {'accounts': 100, 'dataset_profile': 'unknown'}):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                self.stack(**kwargs)
        self.assertEqual(native_stack.MAX_ACCOUNTS, {'deep': 40, 'pcn': 800, 'query-heavy': 100})

    def test_layout_and_pool_default_to_today_and_are_validated(self):
        plain = self.stack(accounts=2, dataset_profile='pcn')
        self.assertEqual((plain.core_layout, plain.db_pool_limit), ('workers', 4))
        for layout, pool in (('phase2', 4), ('workers', 8), ('phase2', 8), ('workers', 6)):
            built = self.stack(accounts=2, dataset_profile='pcn', core_layout=layout, db_pool_limit=pool, core_proxy=True)
            self.assertEqual((built.core_layout, built.db_pool_limit), (layout, pool))
        for kwargs in ({'core_layout': 'other'}, {'core_layout': None}, {'db_pool_limit': 3}, {'db_pool_limit': 9}, {'db_pool_limit': '4'},
                       {'db_pool_limit': 4.0}, {'db_pool_limit': True}):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                self.stack(**{'accounts': 2, 'dataset_profile': 'pcn', **kwargs})
        # Only the bridge study (pcn profile, no CQRS configuration) leaves the defaults.
        for kwargs in ({'dataset_profile': 'pcn', 'cqrs_configuration': 'O', 'core_layout': 'phase2'},
                       {'dataset_profile': 'pcn', 'cqrs_configuration': 'F', 'db_pool_limit': 8},
                       {'dataset_profile': 'deep', 'core_layout': 'phase2'}, {'dataset_profile': 'deep', 'db_pool_limit': 8},
                       {'dataset_profile': 'query-heavy', 'accounts': 100, 'db_pool_limit': 8}):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                self.stack(**{'accounts': 2, **kwargs})
        self.stack(accounts=2, dataset_profile='pcn', cqrs_configuration='O', core_layout='workers', db_pool_limit=4)

    def test_the_context_stack_mjs_reads_carries_both(self):
        import inspect
        start = inspect.getsource(native_stack.NativeStack.start)
        self.assertIn("'coreLayout': self.core_layout, 'dbPoolLimit': self.db_pool_limit", start)

    def test_the_sampler_connects_to_the_cluster_of_the_stack(self):
        stack = self.stack(accounts=2, dataset_profile='pcn')
        stack.pg_port = 5444
        sampler = stack.pg_sampler('activity.txt')
        self.assertEqual(sampler.command[sampler.command.index('-h') + 1], str(stack.private))
        self.assertEqual(sampler.command[sampler.command.index('-p') + 1], '5444')
        self.assertEqual(sampler.output, Path('activity.txt'))


class PgSampling(unittest.TestCase):
    def test_the_summary_skips_junk_and_the_last_sample_and_counts_missing_rows_as_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'activity.txt'
            path.write_text('Thu 12 Nov 2026 (every 0.2s)\n' + activity_text(SAMPLES) + '100.9|p8-cl', encoding='utf-8')  # a cut-off line at the end
            summary = native_stack.read_activity(path, pool_limit=4)
            self.assertEqual((summary['samples'], summary['first_s'], summary['last_s'], summary['pool_limit']), (4, 100.0, 100.6, 4))
            core, clinic = summary['applications']['p8-core'], summary['applications']['p8-clinic-0']
            self.assertEqual((core['busy_max'], core['busy_mean'], core['total_max'], core['at_pool_limit_share']), (4, 3.5, 4, 0.75))
            self.assertEqual((clinic['busy_max'], clinic['busy_mean'], clinic['total_max'], clinic['at_pool_limit_share']), (2, 0.75, 3, 0.0))
            self.assertEqual(sorted(summary['applications']), ['p8-clinic-0', 'p8-core'])
            # No pool limit (the monolith: its pool is the Prisma default): no share.
            self.assertNotIn('at_pool_limit_share', native_stack.read_activity(path)['applications']['p8-core'])
            # since/until keep the steady part only.
            window = native_stack.read_activity(path, 4, since=100.2, until=100.4)
            self.assertEqual((window['samples'], window['applications']['p8-core']['busy_mean'], window['applications']['p8-core']['at_pool_limit_share']), (2, 3.0, 0.5))
            self.assertEqual(native_stack.read_activity(path, 4, since=500.0)['samples'], 0)
            path.write_text('', encoding='utf-8')
            self.assertEqual(native_stack.read_activity(path)['applications'], {})

    def test_psql_repeats_one_query_until_it_is_stopped(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'activity.txt'
            sampler = native_stack.PgSampler('/tmp/pg-socket', 5433, output)
            self.assertEqual(sampler.command, ['psql', '-X', '-q', '-A', '-t', '-F', '|', '-h', '/tmp/pg-socket', '-p', '5433', '-U', 'postgres', '-d', 'postgres',
                                               '-v', 'ON_ERROR_STOP=1'])
            fake = MagicMock()
            fake.poll.return_value = None
            with patch('native_stack.subprocess.Popen', return_value=fake) as popen:
                sampler.start()
                self.assertEqual(popen.call_args.args[0], sampler.command)
                self.assertIs(popen.call_args.kwargs['stdin'], subprocess.PIPE)
                sent = fake.stdin.write.call_args.args[0].decode()
                self.assertTrue(sent.startswith('WITH a AS (SELECT application_name'))
                self.assertTrue(sent.endswith(' \\watch 0.2\n'))
                self.assertEqual(sent.count('\\watch'), 1)
                self.assertIn('FROM pg_stat_activity', sent)
                self.assertIn("backend_type = 'client backend'", sent)
                self.assertIn("count(*) FILTER (WHERE state <> 'idle')", sent)
                fake.terminate.side_effect = lambda: output.write_text(activity_text(SAMPLES), encoding='utf-8')
                result = sampler.stop(pool_limit=4)
            fake.terminate.assert_called_once()
            self.assertEqual((result['status'], result['samples'], result['interval_s']), ('COMPLETE', 4, 0.2))
            self.assertNotIn('psql_exit_code', result)
            with self.assertRaisesRegex(RuntimeError, 'not running'):
                sampler.stop()

    def test_a_psql_that_wrote_nothing_or_ended_early_is_reported_not_hidden(self):
        with tempfile.TemporaryDirectory() as directory:
            for poll, status in ((None, 'NO_SAMPLES'), (2, 'EXITED_EARLY')):
                sampler = native_stack.PgSampler('/tmp/pg-socket', 5433, Path(directory) / f'{status}.txt')
                fake = MagicMock()
                fake.poll.return_value = poll
                with patch('native_stack.subprocess.Popen', return_value=fake):
                    sampler.start()
                    result = sampler.stop(pool_limit=4)
                self.assertEqual((result['status'], result.get('psql_exit_code')), (status, poll))
                self.assertEqual(fake.terminate.called, poll is None)  # psql that already ended is not signalled
            # A psql that ignores the stop is killed.
            sampler = native_stack.PgSampler('/tmp/pg-socket', 5433, Path(directory) / 'stubborn.txt')
            fake = MagicMock()
            fake.poll.return_value = None
            fake.wait.side_effect = [subprocess.TimeoutExpired('psql', 5), 0]
            with patch('native_stack.subprocess.Popen', return_value=fake):
                sampler.start()
                sampler.stop()
            fake.kill.assert_called_once()

    def test_a_sampler_that_cannot_start_is_written_into_the_manifest_and_the_load_goes_on(self):
        with tempfile.TemporaryDirectory() as directory:
            sampler, manifest = native_stack.PgSampler('/tmp/pg-socket', 5433, Path(directory) / 'activity.txt'), {}
            with patch('native_stack.subprocess.Popen', side_effect=FileNotFoundError('psql')):
                self.assertIsNone(native_stack.start_pg_sampler(sampler, manifest))
            self.assertEqual(manifest['pg_activity'], {'status': 'NOT_STARTED', 'error_type': 'FileNotFoundError'})
            self.assertTrue(sampler.sink.closed)
            self.assertIsNone(sampler.process)
            started = MagicMock()
            self.assertIs(native_stack.start_pg_sampler(started, {}), started.start.return_value)

    def test_pool_timeouts_are_counted_per_log_as_a_lower_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            d = Path(directory)
            (d / 'core.log').write_text('listening\nPrismaClientKnownRequestError code P2024\nTimed out fetching a new connection from the connection pool. More info\n')
            (d / 'clinic-0.log').write_text('listening\n')
            (d / 'notification.log').write_text('x P2024 y\n')
            (d / 'setup.txt').write_text('P2024\n')  # not a log
            self.assertEqual(native_stack.count_pool_timeouts(d), {'p2024_log_lines': 3, 'by_log': {'core.log': 2, 'notification.log': 1}})
            self.assertEqual(native_stack.count_pool_timeouts(Path(directory) / 'nothing'), {'p2024_log_lines': 0, 'by_log': {}})

    def test_the_steady_window_is_the_one_member_metrics_keeps_and_the_outbox_is_read_from_inspect(self):
        settings = {'users': 100, 'seconds': 300, 'warmup': 30, 'spawn_rate': 10}
        self.assertEqual(runner.steady_window(settings, 1000.0, 1400.0), (1045.0, 1385.0))  # ramp 10 s + warmup 30 s + 5 s; minus the 15 s drain
        self.assertEqual(runner.outbox_pending({'pendingCore': 3, 'pendingClinic': 0, 'appointments': []}), {'core': 3, 'clinic': 0})
        self.assertEqual(runner.outbox_pending({}), {'core': None, 'clinic': None})


class PoolEvidenceInAMember(unittest.TestCase):
    """run_pcn on a fake stack: the new options reach NativeStack, and the sampler, the pool timeouts and the outbox land in the manifest."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        # A repo copy with the exact harness bytes, so the integrity check passes.
        (self.root / 'empty').mkdir()
        with patch.object(runner, 'NativeStack', side_effect=RuntimeError('stack-not-needed')):
            runner.run_pcn(self.root / 'empty', self.root / 'probe', mode='smoke', progress=lambda text: None, locustfile=bs.LOCUSTFILE)
        self.repo = self.root / 'repo'
        for name in json.loads((self.root / 'probe/manifest.json').read_text())['harness_mismatch']:
            (self.repo / name).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / name).write_bytes((REPO / name).read_bytes())

    def run_member(self, label, sampler_start=None, **options):
        private = self.root / ('private-' + label)
        (private / 'pgdata').mkdir(parents=True)
        (private / 'pgdata/postmaster.pid').write_text('123\n')
        (private / 'nginx.pid').write_text('456\n')
        (private / 'pcn-created.jsonl').write_text('')
        (private / 'core.log').write_text('listening\nPrismaClientKnownRequestError code P2024\nP2024 again\n')
        stack = MagicMock()
        stack.__enter__.return_value = stack
        stack.private, stack.run, stack.db_pool_limit, stack.processes = private, 'run-1', options.get('db_pool_limit', 4), []
        stack.fixture = {'baseUrl': 'http://127.0.0.1:1', 'gateway': {'topology': 'direct', 'coreLayout': options.get('core_layout', 'workers'), 'dbPoolLimit': 4},
                         'dataset': {}, 'dbCrossConnectDenied': 6, 'processes': [{'name': 'core', 'pid': 1}], 'accounts': []}
        stack.control.side_effect = [{'pendingCore': 3, 'pendingClinic': 1}, {'pendingCore': 7, 'pendingClinic': 0}]
        sampler = MagicMock()
        sampler.start.return_value = sampler
        sampler.start.side_effect = sampler_start
        sampler.stop.return_value = {'status': 'COMPLETE', 'samples': 7}
        stack.pg_sampler.return_value = sampler
        output = self.root / ('out-' + label)

        def locust(*args, **kwargs):  # the generator "runs": it leaves the evidence files and has already ended
            (output / 'load-final.json').write_text(json.dumps({'requests': 10, 'failures': 2, 'measured_seconds': 5.0}))
            (output / 'http.csv').write_text('status,failed\n' + '200,False\n' * 8 + '503,True\n' * 2)
            (output / 'generator.json').write_text(json.dumps({'user_errors': 0}))
            child = MagicMock()
            child.poll.return_value, child.returncode, child.pid = 0, 0, 99
            return child
        clock = []
        def now():
            clock.append(1)
            return 1000.0 if len(clock) == 1 else 1100.0
        fake_time = types.SimpleNamespace(time=now, monotonic=runner.time.monotonic, sleep=runner.time.sleep)
        with patch.object(runner, 'NativeStack', return_value=stack) as native, patch.object(runner, 'Client', return_value=types.SimpleNamespace(
                actors=[{'token': 't', 'pets': [{'id': 'p', 'qrToken': 'q'}]}])), patch.object(runner.subprocess, 'Popen', side_effect=locust), \
                patch.object(runner, 'reconcile', return_value={'status': 'PASS_IN_SCOPE'}), patch.object(runner, 'verdict', return_value={}), \
                patch.object(runner, 'time', fake_time):
            runner.run_pcn(self.repo, output, mode='smoke', progress=lambda text: None, locustfile=bs.LOCUSTFILE, **options)
        return json.loads((output / 'manifest.json').read_text()), native, stack, sampler, private

    def test_the_sampler_the_pool_timeouts_and_the_outbox_are_recorded_when_asked_for(self):
        manifest, native, stack, sampler, private = self.run_member('on', pg_sampler=True, core_layout='phase2', db_pool_limit=8)
        self.assertEqual(manifest['status'], 'COMPLETE', manifest)
        self.assertEqual((native.call_args.kwargs['core_layout'], native.call_args.kwargs['db_pool_limit']), ('phase2', 8))
        self.assertEqual(manifest['gateway'], stack.fixture['gateway'])  # ready.json.gateway: topology, layout and pool of the member
        self.assertTrue(manifest['pg_sampler'])
        stack.pg_sampler.assert_called_once_with(private / 'pg-activity.txt')
        sampler.start.assert_called_once()
        pool_limit, since, until = sampler.stop.call_args.args
        self.assertEqual(pool_limit, 8)
        self.assertAlmostEqual(since, 1000.0 + 2 / 10 + 2 + 5)  # the smoke settings: 2 users, spawn 10, warmup 2
        self.assertEqual(until, 1100.0 - 15)
        sampler.stop.assert_called_once()  # the load's own stop; the final clean-up does not stop it twice
        self.assertEqual(manifest['pg_activity'], {'status': 'COMPLETE', 'samples': 7})
        self.assertEqual(manifest['pool_timeouts'], {'p2024_log_lines': 2, 'by_log': {'core.log': 2}, 'http_503': 2})
        self.assertEqual(manifest['outbox'], {'pending_before': {'core': 3, 'clinic': 1}, 'pending_after': {'core': 7, 'clinic': 0}})

    def test_without_the_flag_no_sampler_runs_and_the_stack_keeps_its_defaults(self):
        manifest, native, stack, sampler, private = self.run_member('off')
        self.assertEqual(manifest['status'], 'COMPLETE', manifest)
        self.assertNotIn('core_layout', native.call_args.kwargs)
        self.assertNotIn('db_pool_limit', native.call_args.kwargs)
        for key in ('pg_sampler', 'pg_activity', 'pool_timeouts'):
            self.assertNotIn(key, manifest)
        stack.pg_sampler.assert_not_called()
        sampler.start.assert_not_called()
        self.assertEqual(manifest['outbox']['pending_after'], {'core': 7, 'clinic': 0})  # free to read, so always recorded
        import inspect
        for function in (runner.run_pcn,):
            self.assertIs(inspect.signature(function).parameters['pg_sampler'].default, False)

    def test_a_sampler_that_cannot_start_does_not_fail_the_member(self):
        manifest, native, stack, sampler, private = self.run_member('broken', sampler_start=FileNotFoundError('psql'), pg_sampler=True)
        self.assertEqual(manifest['status'], 'COMPLETE', manifest)
        self.assertEqual(manifest['pg_activity'], {'status': 'NOT_STARTED', 'error_type': 'FileNotFoundError'})
        sampler.stop.assert_not_called()
        self.assertEqual(manifest['pool_timeouts']['http_503'], 2)  # the 503 count still stands


class MonolithSampling(unittest.TestCase):
    text = (HERE / 'bridge_monolith.py').read_text(encoding='utf-8')

    def module(self):
        with patch.dict(sys.modules, {'pcn_runner': runner}):  # the phase-2 runner, whatever else is called pcn_runner
            return importlib.import_module('bridge_monolith')

    def test_only_the_api_names_its_connections_m_api(self):
        self.assertIn("api_env = {**self.env, 'DATABASE_URL': self.env['DATABASE_URL'] + '&application_name=m-api'}", self.text)
        api = self.text[self.text.index("'node', 'backend/dist/src/index.js'"):]
        self.assertTrue(api.startswith("'node', 'backend/dist/src/index.js'], cwd=self.root, env=api_env,"))
        self.assertEqual(self.text.count('application_name'), 1)  # only the API's environment: the setup commands (migrate, seed) keep self.env
        self.assertIn('?schema=public', self.text)  # the URL the name is appended to already has a query

    def test_the_monolith_member_samples_its_own_cluster_only_when_asked(self):
        import inspect
        module = self.module()
        self.assertIs(inspect.signature(module.run_monolith).parameters['pg_sampler'].default, False)
        app = module.Monolith.__new__(module.Monolith)
        app.private, app.port = Path(tempfile.gettempdir()) / 'bridge-m-x', 5455
        sampler = app.pg_sampler('activity.txt')
        self.assertEqual((sampler.command[sampler.command.index('-h') + 1], sampler.command[sampler.command.index('-p') + 1]), (str(app.private), '5455'))
        # The M pool is Prisma's default, so no pool limit is given; the window is the one of the H members.
        self.assertIn('sampler.stop(None, *steady_window(settings, started_epoch, time.time()))', self.text)
        self.assertLess(self.text.index('start_pg_sampler(app.pg_sampler('), self.text.index("subprocess.Popen([*taskset_prefix(pinning), sys.executable"))


class HarnessIntegrity(unittest.TestCase):
    """run_pcn executes the repo's own stack.mjs and locust files; they must be the hashed harness bytes."""

    def run_member(self, repo, output):
        with patch.object(runner, 'NativeStack', side_effect=RuntimeError('stack-not-needed')) as stack:
            result = runner.run_pcn(repo, output, mode='smoke', progress=lambda text: None, locustfile=bs.LOCUSTFILE)
        manifest = json.loads((Path(output) / 'manifest.json').read_text())
        return result, manifest, stack

    def test_a_repo_copy_that_differs_fails_the_member_before_any_stack_starts(self):
        with tempfile.TemporaryDirectory() as temporary:
            temporary = Path(temporary)
            (temporary / 'empty').mkdir()
            result, manifest, stack = self.run_member(temporary / 'empty', temporary / 'out1')
            self.assertEqual((manifest['status'], manifest['failed_stage']), ('FAILED', 'harness-integrity'))
            names = manifest['harness_mismatch']
            self.assertIn('benchmarks/phase2/kaggle/stack.mjs', names)
            self.assertIn(bs.LOCUSTFILE, names)
            self.assertIn('benchmarks/phase2/dataset.mjs', names)
            stack.assert_not_called()
            self.assertEqual(result['load_status'], 'FAIL')
            # A faithful copy passes the check (the stack then fails for its own, injected reason); one changed file does not.
            copy = temporary / 'copy'
            for name in names:
                (copy / name).parent.mkdir(parents=True, exist_ok=True)
                (copy / name).write_bytes((REPO / name).read_bytes())
            result, manifest, stack = self.run_member(copy, temporary / 'out2')
            self.assertEqual((manifest['harness_mismatch'], manifest['failed_stage']), ([], 'startup'))
            stack.assert_called_once()
            (copy / 'benchmarks/phase2/kaggle/stack.mjs').write_bytes(b'// edited\n')
            result, manifest, stack = self.run_member(copy, temporary / 'out3')
            self.assertEqual((manifest['harness_mismatch'], manifest['failed_stage']), (['benchmarks/phase2/kaggle/stack.mjs'], 'harness-integrity'))
            stack.assert_not_called()


class VmArchive(unittest.TestCase):
    def test_trees_share_one_harness_and_v1_list_is_untouched(self):
        harness = {'benchmarks/kaggle/pcn_checks.mjs': b'seed-new', 'benchmarks/phase2/kaggle/stack.mjs': b'stack-new'}
        payload = nb.assemble_vm({'backend/a.ts': b'm'}, {'backend/a.ts': b'h0', 'benchmarks/phase2/kaggle/stack.mjs': b'stack-old'},
                                 {'backend/a.ts': b'h1'}, harness)
        self.assertEqual(payload['H0/benchmarks/phase2/kaggle/stack.mjs'], b'stack-new')
        self.assertEqual(payload['H1/benchmarks/phase2/kaggle/stack.mjs'], b'stack-new')
        self.assertEqual(payload['H0/backend/a.ts'], b'h0')
        self.assertEqual(payload['M/benchmarks/kaggle/pcn_checks.mjs'], b'seed-new')
        self.assertEqual(payload['M/backend/a.ts'], b'm')
        with self.assertRaises(ValueError):
            nb.assemble_vm({'benchmarks/kaggle/pcn_checks.mjs': b'x'}, {}, {}, harness)
        self.assertNotIn('benchmarks/phase2/kaggle/vm_run.sh', nb.HARNESS)
        self.assertIn('benchmarks/phase2/kaggle/vm_run.sh', nb.VM_HARNESS)
        self.assertEqual(nb.STUDY, 'bridge-m-h-kaggle-v1')
        self.assertEqual(nb.FORMAT, 'bridge-m-h-source-1')

    def test_vm_bundle_groups_and_format_are_checked(self):
        files = {'M/backend/a.ts': b'a', 'H0/services/b.ts': b'b', 'H1/services/b.ts': b'c'}
        listing = [{'path': k, 'bytes': len(v), 'sha256': hashlib.sha256(v).hexdigest()} for k, v in sorted(files.items())]

        def bundle(fmt, items):
            manifest = {'format': fmt, 'files': listing, 'treeSha256': hashlib.sha256(json.dumps(listing, separators=(',', ':')).encode()).hexdigest()}
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, 'w') as z:
                z.writestr('bundle-manifest.json', json.dumps(manifest))
                for k, v in items.items():
                    z.writestr(k, v)
            return buffer.getvalue()
        raw = bundle(nb.VM_FORMAT, files)
        sha = hashlib.sha256(raw).hexdigest()
        manifest, values = nb.verified_members(raw, sha, nb.VM_GROUPS, nb.VM_FORMAT)
        self.assertEqual(set(values), set(files))
        with self.assertRaises(ValueError):
            nb.verified_members(raw, sha)  # v1 validator: wrong format and unknown groups
        raw_v1 = bundle(nb.FORMAT, files)
        with self.assertRaises(ValueError):
            nb.verified_members(raw_v1, hashlib.sha256(raw_v1).hexdigest(), nb.VM_GROUPS, nb.VM_FORMAT)

    def test_scripts_are_lf_in_every_tree_whatever_the_checkout_did(self):
        script = 'benchmarks/phase2/kaggle/vm_run.sh'
        payload = nb.assemble_vm({'backend/a.sh': b'a\r\nb\r\n'}, {script: b'old\r\n'}, {script: b'old\r\n'}, {script: b'#!/bin/bash\r\necho x\r\n', 'benchmarks/kaggle/pcn_checks.mjs': b'x\r\n'})
        self.assertEqual(payload['H0/' + script], b'#!/bin/bash\necho x\n')
        self.assertEqual(payload['H1/' + script], b'#!/bin/bash\necho x\n')
        self.assertEqual(payload['M/backend/a.sh'], b'a\nb\n')
        self.assertEqual(payload['M/benchmarks/kaggle/pcn_checks.mjs'], b'x\r\n')  # only shell scripts are touched
        self.assertFalse(any(b'\r' in v for k, v in payload.items() if k.endswith('.sh')))

    def test_the_packed_bundle_holds_vm_run_sh_without_carriage_returns(self):
        try:
            raw, manifest = nb.pack_vm('HEAD', worktree_harness=True)
        except (ValueError, OSError, nb.subprocess.CalledProcessError) as error:
            self.skipTest('cannot pack here: ' + str(error)[:80])
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            for group in ('H0', 'H1'):
                script = archive.read(f'{group}/benchmarks/phase2/kaggle/vm_run.sh')
                self.assertTrue(script.startswith(b'#!/usr/bin/env bash\n'))
                self.assertNotIn(b'\r', script)
        self.assertEqual(manifest['format'], nb.VM_FORMAT)

    def test_extracted_tree_is_verified_file_by_file(self):
        files = {'M/backend/a.ts': b'a', 'H0/services/b.ts': b'b', 'H1/services/b.ts': b'c'}
        listing = [{'path': k, 'bytes': len(v), 'sha256': hashlib.sha256(v).hexdigest()} for k, v in sorted(files.items())]
        manifest = {'format': nb.VM_FORMAT, 'files': listing, 'h0Commit': 'h0', 'h1Commit': 'h1',
                    'treeSha256': hashlib.sha256(json.dumps(listing, separators=(',', ':')).encode()).hexdigest()}

        def extract(directory, items=files, header=manifest):
            root = Path(directory)
            (root / 'bundle-manifest.json').write_text(json.dumps(header))
            for name, value in items.items():
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_bytes(value)
            return root
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(nb.verify_tree(extract(directory))['h1Commit'], 'h1')
        for label, items, header in (('tampered file', {**files, 'H1/services/b.ts': b'x'}, manifest),
                                     ('extra file', {**files, 'H1/services/extra.js': b'x'}, manifest),
                                     ('missing file', {k: v for k, v in files.items() if k != 'M/backend/a.ts'}, manifest),
                                     ('wrong format', files, {**manifest, 'format': nb.FORMAT}),
                                     ('listing edited', files, {**manifest, 'files': listing[:2]})):
            with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError, msg=label):
                nb.verify_tree(extract(directory, items, header))
        unsafe = {'M/backend/a.ts': b'a', 'H0/.env': b'secret'}
        listing_unsafe = [{'path': k, 'bytes': len(v), 'sha256': hashlib.sha256(v).hexdigest()} for k, v in sorted(unsafe.items())]
        header = {**manifest, 'files': listing_unsafe, 'treeSha256': hashlib.sha256(json.dumps(listing_unsafe, separators=(',', ':')).encode()).hexdigest()}
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            nb.verify_tree(extract(directory, unsafe, header))

    def test_v1_notebook_is_pinned_to_the_revision_it_measured(self):
        import inspect
        self.assertEqual(nb.V1_H_COMMIT, 'e0e8937712d486bb0e4993541cca0255b4993e1e')
        for function in (nb.build, nb.pack):
            self.assertEqual(inspect.signature(function).parameters['h_commit'].default, nb.V1_H_COMMIT)
        try:
            newer = nb.git('rev-parse', 'HEAD').decode().strip()
        except (OSError, nb.subprocess.CalledProcessError):
            self.skipTest('no git here')
        with tempfile.TemporaryDirectory() as directory:
            for h_commit, worktree in ((newer, False), (nb.M_COMMIT, False), (nb.V1_H_COMMIT, True)):
                if h_commit == nb.V1_H_COMMIT and not worktree:
                    continue
                with self.assertRaisesRegex(ValueError, 'BRIDGE_V1_PINNED'):
                    nb.build(Path(directory) / 'x.ipynb', h_commit, worktree)
            self.assertEqual(list(Path(directory).iterdir()), [])


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
