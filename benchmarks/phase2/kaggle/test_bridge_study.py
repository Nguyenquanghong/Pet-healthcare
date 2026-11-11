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
import shutil
import subprocess
import sys
import tempfile
import time
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


class Clock:
    """A stand-in for the time module: one second per sleep, and the epoch 1.7e9 s ahead of the monotonic clock."""

    def __init__(self):
        self.t = 1000.0

    def monotonic(self):
        return self.t

    def time(self):
        return 1_700_000_000.0 + self.t

    def sleep(self, seconds):
        self.t += seconds


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


class BridgeWindow(unittest.TestCase):
    """bridge_locust.py hands the controller the moment the measurement window opens, and only when asked to (PCN_WINDOW)."""

    def load(self, **environment):
        class Stub:
            def appointment(self):
                pass

            def rescue(self):
                pass

            def on_start(self):
                pass
            tasks = [appointment, rescue]
        legacy = types.SimpleNamespace(PcnUser=Stub, USERS=[{}], STATE={'start': None})
        listeners, spawned = [], []
        events = types.SimpleNamespace(test_start=types.SimpleNamespace(add_listener=lambda function: listeners.append(function) or function))
        gevent = types.SimpleNamespace(spawn=lambda *args: spawned.append(args), sleep=lambda seconds: None)
        modules = {'pcn_locust': types.SimpleNamespace(legacy=legacy), 'locust': types.SimpleNamespace(events=events), 'gevent': gevent}
        clean = {key: value for key, value in os.environ.items() if key != 'PCN_WINDOW'}
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {**clean, **environment}, clear=True):
            spec = importlib.util.spec_from_file_location('bridge_locust_window', HERE / 'bridge_locust.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        return module, legacy, listeners, spawned, gevent

    def test_without_the_variable_nothing_is_registered_and_locust_is_not_even_imported(self):
        module, legacy, listeners, spawned, gevent = self.load()
        self.assertIsNone(module.WINDOW)
        self.assertEqual((listeners, spawned), ([], []))
        self.assertFalse(hasattr(module, 'watch_window'))
        text = (HERE / 'bridge_locust.py').read_text(encoding='utf-8')
        self.assertIn("WINDOW = os.environ.get('PCN_WINDOW')", text)
        self.assertLess(text.index('if WINDOW:'), text.index('import gevent'))  # both imports sit under the condition
        self.assertLess(text.index('if WINDOW:'), text.index('from locust import events'))

    def test_with_the_variable_one_test_start_listener_publishes_the_window_of_the_phase_1_state(self):
        module, legacy, listeners, spawned, gevent = self.load(PCN_WINDOW='/tmp/window.json')
        self.assertEqual(module.WINDOW, '/tmp/window.json')
        self.assertEqual(len(listeners), 1)
        self.assertIs(listeners[0], module.watch_window)
        self.assertEqual(spawned, [])  # nothing runs until locust starts the test
        module.watch_window(environment=None)
        self.assertEqual(spawned, [(module.publish_window, '/tmp/window.json', legacy.STATE, gevent.sleep)])  # the very dict pcn_locustfile.measure sets 'start' in

    def test_the_window_is_written_once_atomically_when_the_start_is_set(self):
        module = self.load()[0]
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'window.json')
            state, sleeps = {'start': None}, []

            def sleep(seconds):
                sleeps.append(seconds)
                if len(sleeps) == 3:
                    state['start'] = 12345.678
            record = module.publish_window(path, state, sleep, monotonic=lambda: 12346.0, epoch=lambda: 1_700_012_346.0)
            self.assertEqual(len(sleeps), 3)  # polled until the phase-1 file set its start
            self.assertEqual(record, {'start_monotonic': 12345.678, 'seen_monotonic': 12346.0, 'seen_epoch': 1_700_012_346.0})
            self.assertEqual(json.loads(Path(path).read_text(encoding='utf-8')), record)
            self.assertEqual([p.name for p in Path(directory).iterdir()], ['window.json'])  # the temporary file is gone: a reader never sees half a file
            # A start that is already there is written without waiting.
            module.publish_window(path, {'start': 5.0}, lambda seconds: self.fail('slept'), monotonic=lambda: 6.0, epoch=lambda: 7.0)
            self.assertEqual(json.loads(Path(path).read_text(encoding='utf-8'))['start_monotonic'], 5.0)


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
                                 "'clinic-worker'", "'billing-worker'"])  # the Notification workers pass `name` (notificationWorker(i)): see their own test
        self.assertEqual(self.text.count('DATABASE_URL:context.urls.'), len(calls) + 1)  # every one of them, and the Notification workers, is given a database URL to name
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
        self.assertEqual(self.text.count('upstream clinic { ${clinicServers} }'), 2)
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
        self.assertNotIn('keepalive', self.text[self.text.index("const retryHeaders='"):self.text.index('const coreServers=')])
        self.assertIn("SERVICE_INSTANCE_ID:coreReplicas===1?'p8-core':'p8-core-'+i", self.text)
        self.assertIn("...(coreReplicas>1?{HASH_CONCURRENCY:'1'}:{})", self.text)
        self.assertIn('const coreReplicas=context.coreReplicas??1;', self.text)
        self.assertIn('assert.equal(coreReplicas,1);assert.ok(!coreProxy);', self.text)  # the CQRS studies keep one, direct Core
        self.assertIn('the 28/10 handoff plan; resilience.test.mjs itself uses 2 per instance', self.text)

    def test_no_location_retries_on_another_instance_when_core_is_proxied(self):
        retry = re.search(r"const retryHeaders='([^']*)';", self.text).group(1)
        self.assertEqual(retry, 'proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Request-ID $request_id; '
                                'proxy_connect_timeout 1s; proxy_read_timeout 15s; proxy_next_upstream error timeout http_502 http_503 http_504;')
        needle = "retryHeaders.replace('proxy_next_upstream error timeout http_502 http_503 http_504;','proxy_next_upstream off;')"
        # K9 S2: one policy for every proxied location, for Core and for Clinic, whether there is one instance or two; only coreProxy changes it.
        self.assertIn('const headers=coreProxy?' + needle + ':retryHeaders;', self.text)
        self.assertIn('const coreGateway=headers;', self.text)
        self.assertIn('proxy_next_upstream error timeout http_502 http_503 http_504;', retry)  # the replace really finds its text
        replaced = retry.replace('proxy_next_upstream error timeout http_502 http_503 http_504;', 'proxy_next_upstream off;')
        self.assertEqual(replaced.count('proxy_next_upstream'), 1)  # one directive per location: nginx rejects a duplicate
        self.assertTrue(replaced.endswith('proxy_next_upstream off;'))
        self.assertEqual(self.text.count('const headers='), 1)
        self.assertEqual(self.text.count('const retryHeaders='), 1)
        # Every location of the gateway and of the Clinic listener names headers or coreGateway, so the two definitions cover them: the Core location of each template, the Clinic
        # and Notification locations of the direct one and the Clinic edge server of each.
        self.assertEqual(self.text.count(self.CORE_LOCATION), 2)
        self.assertEqual(self.text.count('${coreGateway}'), 2)  # the Core location of each template, nowhere else
        self.assertEqual(self.text.count('location / { ${headers} '), 2)  # the Clinic edge server of each template
        self.assertEqual(self.text.count('/api/(appointments|medical-records|dashboard/clinic)(/|$) { ${headers} '), 1)  # direct only
        self.assertEqual(self.text.count('/api/notifications(/|$) { ${headers} '), 1)  # direct only

    def test_clinic_servers_are_never_put_aside_when_core_is_proxied(self):
        self.assertIn("const clinicServers=clinicPorts.map(p=>'server 127.0.0.1:'+p+(coreProxy?' max_fails=0':'')+';').join(' ');", self.text)
        # Defined next to the Core servers, before the first template that names it; nothing else builds an `upstream clinic`.
        self.assertLess(self.text.index('const coreServers='), self.text.index('const clinicServers='))
        self.assertLess(self.text.index('const clinicServers='), self.text.index('const coreEdge='))
        self.assertEqual(self.text.count('upstream clinic'), 2)
        self.assertEqual(self.text.count('${clinicServers}'), 2)
        self.assertEqual(self.text.count('clinicPorts.map'), 1)  # the definition above
        self.assertIn("clinicUpstream:{servers:clinicPorts.length,maxFails:coreProxy?0:null,proxyNextUpstream:coreProxy?'off':'error timeout http_502 http_503 http_504'}", self.text)

    def test_the_two_gateway_servers_name_only_what_the_routing_rule_lists(self):
        # tools/phase2/gateway-routing.mjs trusts these names without reading the JS that builds them (ROUTING_PLACES interp): the gateway server of each template may name nothing
        # else, so the retry policy and the Clinic upstream above change what the names hold and leave the gateway servers of the templates as they were.
        direct, ingress = self.template('directConfig'), self.template('coreIngressConfig')
        for config, used in ((direct, {'ports.gateway', 'headers', 'coreGateway', 'origins.notification'}), (ingress, {'ports.gateway', 'coreGateway'})):
            server = config[config.index('server { listen 127.0.0.1:${ports.gateway};'):]
            self.assertTrue(server.startswith('server { listen 127.0.0.1:${ports.gateway}; location ~ ^/(internal|metrics|health) { return 404; } '))
            self.assertTrue(server.endswith(' location / { return 404; } } }'))
            self.assertEqual(set(re.findall(r'\$\{([^}]*)\}', server)), used)
        rule = REPO / 'tools/phase2/gateway-routing.mjs'
        if rule.is_file():
            text = rule.read_text(encoding='utf-8')
            self.assertIn("interp:[{expr:'ports.gateway'},{expr:'headers',as:''},{expr:'coreGateway',as:''},{expr:'origins.notification'}]", text)
            self.assertIn("interp:[{expr:'ports.gateway'},{expr:'headers',as:''},{expr:'coreGateway',as:''}]", text)

    def test_notification_workers_are_one_or_two_and_never_with_cqrs(self):
        self.assertIn('const notificationWorkers=context.notificationWorkers??1;', self.text)  # absent in every older context: one
        self.assertIn('assert.ok([1,2].includes(notificationWorkers),', self.text)
        self.assertLess(self.text.index('const notificationWorkers='), self.text.index('const clients='))  # refused before any database is touched
        cqrs = re.search(r'if\(cqrsMode!==undefined&&cqrsMode!==null\)\{(.*?)cqrsTools=await import', self.text, re.S).group(1)
        self.assertIn('assert.equal(notificationWorkers,1);', cqrs)

    def test_each_notification_worker_has_its_own_name_log_and_instance_id(self):
        self.assertIn("const name=notificationWorkers===1?'notification-worker':'notification-worker-'+i;", self.text)
        self.assertIn("return child(name,'services/notification/dist/worker.js',{...workerBase,DATABASE_URL:context.urls.notification,SERVICE_INSTANCE_ID:'p8-'+name});", self.text)
        self.assertIn('for(let i=0;i<notificationWorkers;i++)started.push(await notificationWorker(i));', self.text)
        self.assertEqual(self.text.count('services/notification/dist/worker.js'), 1)
        # application_name follows the process name (child), so the pg_stat_activity sampler reads p8-notification-worker or p8-notification-worker-0/1.
        self.assertIn('if(env.DATABASE_URL)env.DATABASE_URL=withApplicationName(env.DATABASE_URL,name);', self.text)
        # The same naming as the other instances: core or core-0/1, and clinic-0/1.
        self.assertIn("coreReplicas===1?'core':'core-'+i", self.text)

    def test_pause_and_resume_act_on_every_notification_worker_and_can_repeat(self):
        self.assertIn("else if(command.action==='pause-notification'){for(const worker of consumers)await stop(worker);response={paused:true};}", self.text)
        self.assertIn("else if(command.action==='resume-notification'){assert.ok(consumers.every(worker=>worker.child.exitCode!==null||worker.child.signalCode!==null),", self.text)
        self.assertIn('consumers=await startNotificationWorkers();response={resumed:true};}', self.text)
        self.assertEqual(self.text.count('startNotificationWorkers'), 3)  # the definition, the first start and the resume
        self.assertIn('let consumers=await startNotificationWorkers();', self.text)  # `let`: a resume replaces the handles
        self.assertNotRegex(self.text, r'\blet consumer\b|\bstop\(consumer\)|\bconsumer=')  # no single-handle variable is left
        # stop() of a worker that already ended does nothing, so a second pause is harmless.
        self.assertIn('if(handle.child.exitCode!==null){if(handle.child.exitCode!==0)failed=true;return;}', self.text)

    def test_ready_json_records_the_process_layout_of_the_member(self):
        self.assertIn(r"clinicInstances:handles.filter(h=>/^clinic-\d+$/.test(h.name)).map(h=>h.name),notificationWorkers,clinicWorkers:1,", self.text)
        self.assertIn('clinicReplicas:context.replicas,coreReplicas,', self.text)
        # The gateway entry is what the manifest keeps (pcn_runner: manifest['gateway']).
        self.assertLess(self.text.index('clinicWorkers:1,'), self.text.index('gateway:{topology:gatewayTopology,'))
        self.assertLess(self.text.index('clinicUpstream:{servers:'), self.text.index('dbCrossConnectDenied:6'))

    def test_the_three_burst_actions_exist_and_a_burst_is_one_per_stack_pcn_only_and_bounded(self):
        for action in ('notification-burst', 'burst-observe', 'burst-report'):
            self.assertEqual(self.text.count(f"else if(command.action==='{action}')"), 1, action)
        self.assertIn("else if(command.action==='notification-burst')response=await fireBurst(command.count);", self.text)
        self.assertIn("assert.ok(profile==='pcn'&&!cqrsTools,", self.text)  # no CQRS configuration, no other profile
        # 9000 at most: the product degrades /health/ready at 10000 unpublished outbox events (OUTBOX_SOFT_LIMIT, packages/runtime/src/http.ts) and refuses at 20000.
        self.assertIn("assert.ok(Number.isInteger(count)&&count>=1&&count<=9000,'notification-burst count must be an integer from 1 to 9000');", self.text)
        self.assertNotIn('20000', self.text)
        self.assertIn("assert.equal(burst,undefined,'one notification burst per stack');", self.text)
        self.assertIn("assert.ok(burst,'burst-report before notification-burst');", self.text)
        self.assertEqual(len(re.findall(r'(?<![\w.])burst=\{', self.text)), 1)  # one place sets it

    def test_the_burst_is_clinic_outbox_rows_committed_once_in_the_shape_of_a_new_appointment_notification(self):
        self.assertIn('await db.clinic.$transaction(pieces(rows,1000).map(data=>db.clinic.outboxEvent.createMany({data})));', self.text)
        self.assertEqual(self.text.count('$transaction('), 1)  # one commit for all the rows
        self.assertIn('const pieces=(list,size)=>', self.text)
        self.assertLess(self.text.index('parseEnvelope(JSON.stringify(event));'), self.text.index('$transaction('))  # every envelope is checked before any row is written
        self.assertLess(self.text.index('$transaction('), self.text.index('const committedAtMs=Date.now()'))
        self.assertIn("burst={count,ids,pieces:pieces(ids,1000),occurred,committedAtMs,insertMs:committedAtMs-began,applied:0,done:false};", self.text)
        self.assertIn('return {count,committedAtMs,insertMs:burst.insertMs,unexpectedExit:failed};', self.text)
        self.assertIn("const {parseEnvelope}=await import('../../../packages/contracts/dist/index.js');", self.text)  # the dist path, not the package name (the H1 tree predates the package)
        # The envelope is the one writeNotification writes, with the recipient and the related ids of a new appointment's notification for the admins.
        for needle in ("eventType:'notification.requested.v1',", 'schemaVersion:1,', "producer:'clinic',", "aggregateType:'notification',", 'aggregateVersion:1,',
                       "recipientRole:'admin',recipientOwnerId:null,type:'appointment_created',", 'relatedPetId:null,relatedAppointmentId:null,relatedBookingId:null,'):
            self.assertIn(needle, self.text)
        source = REPO / 'services/clinic/src/infrastructure/messaging/notificationOutbox.ts'
        if source.is_file():
            written = source.read_text(encoding='utf-8')
            for needle in ("eventType: 'notification.requested.v1',", 'schemaVersion: 1,', "producer: 'clinic',", "aggregateType: 'notification',", 'aggregateVersion: 1,',
                           'parseEnvelope(JSON.stringify(event));'):
                self.assertIn(needle, written)
        booked = REPO / 'services/clinic/src/application/services/appointments.ts'
        if booked.is_file():
            self.assertIn("recipientRole: 'admin',\n        type: 'appointment_created',", booked.read_text(encoding='utf-8').replace('\r\n', '\n'))

    def test_queue_names_and_the_inbox_consumer_come_from_the_product_not_from_a_guess(self):
        self.assertIn("const queueNames=async()=>burstNames??=(await import('../../../packages/messaging/dist/index.js')).topology(common.BROKER_PREFIX);", self.text)
        self.assertIn("BROKER_PREFIX:'p8.'+context.run", self.text)  # the prefix the services run with: the topology is asked for the same one
        self.assertIn("names.notification+'.dlq'", self.text)
        topology = REPO / 'packages/messaging/src/topology.ts'
        index = REPO / 'packages/messaging/src/index.ts'
        if topology.is_file() and index.is_file():
            written = topology.read_text(encoding='utf-8')
            self.assertIn('notification: `${prefix}.notification`,', written)
            self.assertIn('`${t[consumer]}.dlq`', written)  # how the dead-letter queue of a consumer is named
            self.assertRegex(index.read_text(encoding='utf-8'), r"export \{[^}]*\btopology\b[^}]*\} from './topology\.js'")
        inbox = REPO / 'services/notification/src/inbox.ts'
        self.assertIn("const INBOX='notification-v1';", self.text)
        if inbox.is_file():
            self.assertIn("VALUES ('notification-v1',", inbox.read_text(encoding='utf-8'))

    def test_amqplib_the_contracts_and_the_topology_are_imported_only_when_a_burst_action_needs_them(self):
        header = self.text[:self.text.index('const context=')]  # the static imports
        for name in ('amqplib', 'packages/contracts', 'packages/messaging'):
            self.assertNotIn(name, header)
        self.assertNotRegex(self.text, r"(?m)^import .* from 'amqplib'")
        self.assertEqual(self.text.count("import('amqplib')"), 1)
        self.assertEqual(self.text.count("import('../../../packages/contracts/dist/index.js')"), 1)
        self.assertEqual(self.text.count("import('../../../packages/messaging/dist/index.js')"), 1)
        self.assertIn("let failed=false,stopping=false,nginx,probe;", self.text)
        self.assertIn('if(probe){await probe.connection.close().catch(()=>{});probe=undefined;}', self.text)  # cleanup closes the probe's connection

    def test_burst_observe_reads_the_queue_the_dead_letter_queue_the_outbox_and_the_inbox_without_the_management_plugin(self):
        for needle in ('probe.channel.checkQueue(names.notification)', "checkQueue(names.notification+'.dlq')",
                       'messageCount:queue.messageCount,consumerCount:queue.consumerCount', 'observed.dlq={messageCount:dlq.messageCount}',
                       'observed.clinicOutboxPending=await db.clinic.outboxEvent.count({where:{publishedAt:null}});',
                       'db.notification.inboxEvent.count({where:{consumerName:INBOX,eventId:{in:ids}}})', 'observed.burstApplied=burst.applied;', 'observed.unexpectedExit=failed;'):
            self.assertIn(needle, self.text)
        for forbidden in ('rabbitmqctl', '15672', 'rabbitmq_management', '/api/queues'):
            self.assertNotIn(forbidden, self.text)
        # A queue that is not there closes the channel: the probe is dropped and the answer says so instead of failing the control action.
        self.assertIn('observed.queue=null;observed.dlq=null;observed.probeError=true;', self.text)

    def test_burst_report_returns_raw_timestamps_and_latencies_for_the_runner_to_summarise(self):
        for needle in ('FROM "InboxEvent" WHERE "consumerName"=${INBOX}', 'now()::timestamp-"createdAt"', 'extract(epoch FROM now())',
                       '_count:{publishedAt:true},_max:{publishedAt:true}', "envelope->>'eventType'='notification.requested.v1'", 'for(const source of [db.clinic,db.core])',
                       'latencyMs:applied.map(r=>r.at-burst.occurred.get(r.id))', 'background:{pairs,unmatched}', 'relay:{published,lastPublishedAtMs}'):
            self.assertIn(needle, self.text)
        # The inbox instant is read as an age against the database clock: InboxEvent.createdAt is now() in a timestamp column, local time when the server is not on UTC.
        self.assertEqual(self.text.count('"createdAt"'), 1)
        self.assertLess(self.text.index('async function reportBurst'), self.text.index('FROM "InboxEvent"'))

    def test_a_failed_burst_action_leaves_its_name_and_error_class_in_the_application_log_and_an_opaque_answer(self):
        self.assertIn("process.stderr.write('BURST_ACTION_FAILED: '+command.action+' '+(error?.name??'Error')+'\\n')", self.text)
        self.assertIn("dump(command.id+'.json',{error:'control-action-failed'});", self.text)
        self.assertNotIn('error.message', self.text.replace('error?.message??', ''))  # a message can carry a connection string: only the class is logged

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

    def test_a_pool_above_4_is_only_for_one_core_one_clinic_and_one_notification_worker(self):
        for pool in (5, 8):
            built = self.stack(accounts=2, dataset_profile='pcn', core_proxy=True, db_pool_limit=pool)
            self.assertEqual((built.db_pool_limit, built.core_replicas, built.replicas, built.notification_workers), (pool, 1, 1, 1))
            self.stack(accounts=2, dataset_profile='pcn', core_proxy=True, db_pool_limit=pool, gateway_topology='core-ingress')   # the gateway adds no pool
            for extra in ({'core_replicas': 2}, {'replicas': 2}, {'notification_workers': 2}, {'core_replicas': 2, 'replicas': 2, 'notification_workers': 2}):
                with self.assertRaisesRegex(ValueError, 'db_pool_limit above 4 only with one Core, one Clinic and one Notification worker', msg=(pool, extra)):
                    self.stack(accounts=2, dataset_profile='pcn', core_proxy=True, db_pool_limit=pool, **extra)
        # The default pool takes every instance count: H3x2cl2 and the burst configurations run at 4.
        built = self.stack(accounts=2, dataset_profile='pcn', core_proxy=True, core_replicas=2, replicas=2, notification_workers=2, db_pool_limit=4)
        self.assertEqual((built.db_pool_limit, built.core_replicas, built.replicas, built.notification_workers), (4, 2, 2, 2))
        # The configurations of the study agree with the rule.
        for config, plan in bs.VM2_CONFIGS.items():
            if config != 'M':
                self.stack(accounts=2, dataset_profile='pcn', core_proxy=True, core_replicas=plan['core'], replicas=plan['clinic'], notification_workers=plan['nw'],
                           db_pool_limit=plan['pool'], core_layout=plan['layout'], gateway_topology=plan['topology'])

    def test_notification_workers_and_the_gateway_topology_default_to_today_and_are_validated(self):
        plain = self.stack(accounts=2, dataset_profile='pcn')
        self.assertEqual((plain.notification_workers, plain.gateway_topology), (1, 'direct'))
        for workers, topology in ((2, 'direct'), (1, 'core-ingress'), (2, 'core-ingress')):
            built = self.stack(accounts=2, dataset_profile='pcn', core_proxy=True, replicas=2, notification_workers=workers, gateway_topology=topology)
            self.assertEqual((built.notification_workers, built.gateway_topology), (workers, topology))
        for kwargs in ({'notification_workers': 3}, {'notification_workers': 0}, {'notification_workers': True}, {'notification_workers': 2.0},
                       {'notification_workers': '2'}, {'notification_workers': None}, {'gateway_topology': 'other'}, {'gateway_topology': None},
                       {'gateway_topology': 'Direct'}):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                self.stack(**{'accounts': 2, 'dataset_profile': 'pcn', **kwargs})
        # Only the bridge study (pcn profile, no CQRS configuration) leaves the defaults; the CQRS studies run one worker behind the direct gateway.
        for kwargs in ({'dataset_profile': 'pcn', 'cqrs_configuration': 'O', 'notification_workers': 2},
                       {'dataset_profile': 'pcn', 'cqrs_configuration': 'F', 'gateway_topology': 'core-ingress'},
                       {'dataset_profile': 'deep', 'notification_workers': 2}, {'dataset_profile': 'deep', 'gateway_topology': 'core-ingress'},
                       {'dataset_profile': 'query-heavy', 'accounts': 100, 'notification_workers': 2}):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                self.stack(**{'accounts': 2, **kwargs})
        self.stack(accounts=2, dataset_profile='pcn', cqrs_configuration='O', notification_workers=1, gateway_topology='direct')
        self.assertEqual(native_stack.NOTIFICATION_WORKERS, (1, 2))
        self.assertEqual(native_stack.GATEWAY_TOPOLOGIES, ('direct', 'core-ingress'))

    def test_the_context_stack_mjs_reads_carries_both(self):
        import inspect
        start = inspect.getsource(native_stack.NativeStack.start)
        self.assertIn("'coreLayout': self.core_layout, 'dbPoolLimit': self.db_pool_limit", start)
        self.assertIn("'notificationWorkers': self.notification_workers, 'gatewayTopology': self.gateway_topology", start)

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

    def test_stop_pg_sampler_gives_a_status_instead_of_failing(self):
        working = MagicMock()
        working.stop.return_value = {'status': 'COMPLETE', 'samples': 3}
        self.assertEqual(native_stack.stop_pg_sampler(working, 4, 1.0, 2.0), {'status': 'COMPLETE', 'samples': 3})
        working.stop.assert_called_once_with(4, 1.0, 2.0)
        for error in (RuntimeError('pg sampler is not running'), OSError('broken pipe'), ValueError('x')):
            broken = MagicMock()
            broken.stop.side_effect = error
            self.assertEqual(native_stack.stop_pg_sampler(broken), {'status': 'STOP_FAILED', 'error_type': type(error).__name__})
        sampler = native_stack.PgSampler('/tmp', 1, '/tmp/x.txt')
        self.assertEqual(native_stack.stop_pg_sampler(sampler), {'status': 'STOP_FAILED', 'error_type': 'RuntimeError'})   # never started, or stopped already

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
        stop_error = options.pop('stop_error', None)
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
        sampler.stop.side_effect = stop_error
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

    def test_the_scale_out_axes_reach_the_stack_only_off_the_default_and_every_manifest_records_them(self):
        manifest, native, stack, sampler, private = self.run_member('axes', replicas=2, notification_workers=2, gateway_topology='core-ingress')
        self.assertEqual(manifest['status'], 'COMPLETE', manifest)
        kwargs = native.call_args.kwargs
        self.assertEqual((kwargs['replicas'], kwargs['notification_workers'], kwargs['gateway_topology']), (2, 2, 'core-ingress'))
        self.assertEqual((manifest['clinic_replicas'], manifest['notification_workers'], manifest['gateway_topology']), (2, 2, 'core-ingress'))
        manifest, native, stack, sampler, private = self.run_member('axes-default')
        for key in ('notification_workers', 'gateway_topology'):
            self.assertNotIn(key, native.call_args.kwargs)  # a context without the keys is the context of every older member
        self.assertEqual((manifest['clinic_replicas'], manifest['notification_workers'], manifest['gateway_topology']), (1, 1, 'direct'))
        import inspect
        parameters = inspect.signature(runner.run_pcn).parameters
        self.assertEqual((parameters['notification_workers'].default, parameters['gateway_topology'].default), (1, 'direct'))

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

    def test_a_sampler_that_cannot_be_stopped_is_written_down_and_the_manifest_is_still_written(self):
        manifest, native, stack, sampler, private = self.run_member('stuck', pg_sampler=True, stop_error=RuntimeError('pg sampler is not running'))
        self.assertEqual(manifest['status'], 'COMPLETE', manifest)   # the manifest was written, and the member is not failed for its sampler
        self.assertEqual(manifest['pg_activity'], {'status': 'STOP_FAILED', 'error_type': 'RuntimeError'})
        sampler.stop.assert_called_once()   # the clean-up after the load did not try a second time
        self.assertEqual(manifest['pool_timeouts']['http_503'], 2)
        self.assertTrue(bs.pool_evidence(manifest)['available'] is False)   # the pool reading is unknown, the 503 count stands

    def test_a_sampler_that_cannot_start_does_not_fail_the_member(self):
        manifest, native, stack, sampler, private = self.run_member('broken', sampler_start=FileNotFoundError('psql'), pg_sampler=True)
        self.assertEqual(manifest['status'], 'COMPLETE', manifest)
        self.assertEqual(manifest['pg_activity'], {'status': 'NOT_STARTED', 'error_type': 'FileNotFoundError'})
        sampler.stop.assert_not_called()
        self.assertEqual(manifest['pool_timeouts']['http_503'], 2)  # the 503 count still stands

    def run_burst_member(self, label, *, burst, observe, report, polls=4, fire_fails=False, **options):
        """run_pcn on a fake stack with a fake clock (1 s per sleep). The generator "starts" at clock 1000 and writes the window file when it is given one; the load loop turns
        `polls` times. `observe(applied)` and `report(committed_ms)` build the burst-observe and burst-report answers."""
        private = self.root / ('private-' + label)
        (private / 'pgdata').mkdir(parents=True)
        (private / 'pgdata/postmaster.pid').write_text('123\n')
        (private / 'nginx.pid').write_text('456\n')
        (private / 'pcn-created.jsonl').write_text('')
        clock, calls, state, environments = Clock(), [], {'applied': 0, 'committed': None}, []
        stack = MagicMock()
        stack.__enter__.return_value = stack
        stack.private, stack.run, stack.db_pool_limit, stack.processes = private, 'run-1', 4, []
        stack.fixture = {'baseUrl': 'http://127.0.0.1:1', 'gateway': {'topology': 'direct'}, 'dataset': {}, 'dbCrossConnectDenied': 6,
                         'processes': [{'name': 'core', 'pid': 1}], 'accounts': []}

        def control(action, **extra):
            calls.append((action, extra, clock.t))
            if action == 'inspect':
                return {'pendingCore': 0, 'pendingClinic': 0}
            if action == 'notification-burst':
                if fire_fails:
                    raise RuntimeError('Stack control failed: control-action-failed')
                state['applied'], state['committed'] = extra['count'], clock.time() * 1000 + 40
                return {'count': extra['count'], 'committedAtMs': state['committed'], 'insertMs': 700.0, 'unexpectedExit': False}
            if action == 'burst-observe':
                return observe(state['applied'])
            if action == 'burst-report':
                return report(state['committed'])
            raise AssertionError(action)
        stack.control.side_effect = control
        output = self.root / ('out-' + label)

        def locust(*args, **kwargs):
            environments.append(kwargs['env'])
            (output / 'load-final.json').write_text(json.dumps({'requests': 10, 'failures': 0, 'measured_seconds': 5.0}))
            (output / 'http.csv').write_text('status,failed\n' + '200,False\n' * 10)
            (output / 'generator.json').write_text(json.dumps({'user_errors': 0}))
            if 'PCN_WINDOW' in kwargs['env']:  # what bridge_locust.py does once the measurement window opens
                Path(kwargs['env']['PCN_WINDOW']).write_text(json.dumps({'start_monotonic': clock.monotonic(), 'seen_monotonic': clock.monotonic(), 'seen_epoch': clock.time()}))
            child = MagicMock()
            child.poll.side_effect = [None] * polls + [0] * 1000
            child.returncode, child.pid = 0, 99
            return child
        with patch.object(runner, 'NativeStack', return_value=stack) as native, patch.object(runner, 'Client', return_value=types.SimpleNamespace(
                actors=[{'token': 't', 'pets': [{'id': 'p', 'qrToken': 'q'}]}])), patch.object(runner.subprocess, 'Popen', side_effect=locust), \
                patch.object(runner, 'reconcile', return_value={'status': 'PASS_IN_SCOPE'}), patch.object(runner, 'verdict', return_value={}), \
                patch.object(runner, 'resource_sample', return_value=[]), patch.object(runner, 'time', clock):
            runner.run_pcn(self.repo, output, mode='smoke', progress=lambda text: None, locustfile=bs.LOCUSTFILE, burst=burst, **options)
        manifest = json.loads((output / 'manifest.json').read_text())
        return manifest, output, calls, environments, private, native

    @staticmethod
    def burst_observation(applied):
        return {'atMs': 1.0, 'fired': applied > 0, 'queue': {'messageCount': 4, 'consumerCount': 1}, 'dlq': {'messageCount': 0}, 'clinicOutboxPending': 2,
                **({'burstApplied': applied} if applied else {}), 'unexpectedExit': False}

    @staticmethod
    def burst_report(committed):
        return {'count': 6, 'notificationWorkers': 1, 'committedAtMs': committed, 'insertMs': 700.0,
                'inbox': {'applied': 6, 'firstAtMs': committed + 500, 'lastAtMs': committed + 4000}, 'relay': {'published': 6, 'lastPublishedAtMs': committed + 1500},
                'latencyMs': [900.0, 1000.0, 1100.0, 1200.0, 1300.0, 4100.0],
                'background': {'pairs': [[committed - 2040 - 5000, 7.0], [committed - 1000, 25.0], [committed + 1000, 900.0]], 'unmatched': 0},
                'unexpectedExit': False}

    def test_a_burst_is_fired_in_the_window_sampled_every_second_drained_and_reported_after_the_reconciliation(self):
        manifest, output, calls, environments, private, native = self.run_burst_member(
            'burst', burst={'count': 6, 'at_s': 2}, observe=self.burst_observation, report=self.burst_report)
        self.assertEqual(manifest['status'], 'COMPLETE', manifest)
        self.assertEqual(environments[0]['PCN_WINDOW'], str(private / 'pcn-window.json'))
        # Window opened at clock 1000, so the burst is due at 1002: fired once by the third tick, before the 'after' snapshot; the drain wait and the report come after it.
        self.assertEqual([(action, clock) for action, _, clock in calls],
                         [('inspect', 1000.0), ('burst-observe', 1000.0), ('burst-observe', 1001.0), ('notification-burst', 1002.0), ('burst-observe', 1002.0),
                          ('burst-observe', 1003.0), ('inspect', 1004.0), ('burst-observe', 1004.0), ('burst-report', 1004.0)])
        self.assertEqual(next(extra for action, extra, _ in calls if action == 'notification-burst'), {'count': 6})
        result = json.loads((output / 'burst.json').read_text(encoding='utf-8'))
        self.assertEqual((result['status'], result['valid'], result['reasons']), ('COMPLETE', True, []))
        self.assertEqual((result['count'], result['at_s'], result['workers'], result['fired_s']), (6, 2, 1, 2.0))
        self.assertAlmostEqual(result['committed_s'], 2.04)
        self.assertEqual((result['drained'], result['drain_s'], result['relay_drain_s'], result['drain_reading']), (True, 4.0, 1.5, 'đã xả xong'))
        self.assertEqual(result['latency_ms'], {'n': 6, 'p50_ms': 1100.0, 'p95_ms': 4100.0, 'max_ms': 4100.0})
        self.assertEqual({name: part['n'] for name, part in result['background_latency_ms'].items()}, {'before': 1, 'during': 1, 'after': 0})  # the event before the window is not counted
        self.assertEqual(result['observations'], 5)
        self.assertEqual(len((output / 'burst.jsonl').read_text().splitlines()), 5)  # one per tick of the load (four) and one while waiting for the drain
        self.assertEqual(manifest['burst'], {'count': 6, 'at_s': 2, 'status': 'COMPLETE', 'valid': True})

    def test_a_burst_the_window_never_reaches_is_reported_as_not_fired(self):
        manifest, output, calls, environments, private, native = self.run_burst_member(
            'late', burst={'count': 6, 'at_s': 10}, observe=self.burst_observation, report=self.burst_report)
        self.assertEqual(manifest['status'], 'COMPLETE', manifest)
        self.assertNotIn('notification-burst', [action for action, _, _ in calls])
        self.assertNotIn('burst-report', [action for action, _, _ in calls])
        result = json.loads((output / 'burst.json').read_text(encoding='utf-8'))
        self.assertEqual((result['status'], result['valid'], result['window_opened']), ('NOT_FIRED', False, True))
        self.assertEqual(manifest['burst'], {'count': 6, 'at_s': 10, 'status': 'NOT_FIRED', 'valid': False})

    def test_a_burst_that_cannot_be_fired_is_written_down_and_the_member_still_completes(self):
        manifest, output, calls, environments, private, native = self.run_burst_member(
            'unfired', burst={'count': 6, 'at_s': 2}, observe=self.burst_observation, report=self.burst_report, fire_fails=True)
        self.assertEqual(manifest['status'], 'COMPLETE', manifest)   # a side measurement does not take the member, and the session, down
        self.assertEqual(manifest['burst'], {'count': 6, 'at_s': 2, 'status': 'FIRE_FAILED', 'valid': False})
        result = json.loads((output / 'burst.json').read_text(encoding='utf-8'))
        self.assertEqual((result['status'], result['valid'], result['window_opened']), ('FIRE_FAILED', False, True))
        self.assertEqual(result['reasons'], ['the burst could not be fired: RuntimeError: Stack control failed: control-action-failed'])
        actions = [action for action, _, _ in calls]
        self.assertEqual(actions.count('notification-burst'), 1)   # not fired again on the next ticks
        self.assertNotIn('burst-report', actions)
        self.assertGreaterEqual(actions.count('burst-observe'), 3)   # the sampling went on
        self.assertTrue((output / 'burst.jsonl').exists())
        self.assertTrue((output / 'pcn-report.json').exists())

    def test_a_burst_report_that_cannot_be_read_is_written_down_and_the_member_still_completes(self):
        def broken(committed):
            raise RuntimeError('Stack control timeout')
        manifest, output, calls, environments, private, native = self.run_burst_member(
            'unreported', burst={'count': 6, 'at_s': 2}, observe=self.burst_observation, report=broken)
        self.assertEqual(manifest['status'], 'COMPLETE', manifest)
        self.assertEqual(manifest['burst'], {'count': 6, 'at_s': 2, 'status': 'REPORT_FAILED', 'valid': False})
        result = json.loads((output / 'burst.json').read_text(encoding='utf-8'))
        self.assertEqual((result['status'], result['valid'], result['count']), ('REPORT_FAILED', False, 6))
        self.assertEqual([action for action, _, _ in calls].count('burst-report'), 1)

    def test_a_burst_needs_the_locustfile_that_writes_the_window_and_is_refused_before_anything_starts_otherwise(self):
        self.assertEqual(runner.BURST_LOCUSTFILE, 'bridge_locust.py')
        self.assertEqual(Path(bs.LOCUSTFILE).name, runner.BURST_LOCUSTFILE)   # what VmStudy2 passes
        for options in ({}, {'locustfile': 'benchmarks/phase2/kaggle/pcn_locust.py'}, {'locustfile': 'benchmarks/kaggle/pcn_locustfile.py'},
                        {'locustfile': 'benchmarks/phase2/kaggle/bridge_locust.py.bak'}):
            with patch.object(runner, 'NativeStack') as native, self.assertRaisesRegex(ValueError, 'bridge_locust.py'):
                runner.run_pcn(self.repo, self.root / 'refused-locust', mode='smoke', progress=lambda text: None, burst={'count': 6, 'at_s': 2}, **options)
            native.assert_not_called()
            self.assertFalse((self.root / 'refused-locust').exists())
        # Without a burst any locustfile is fine, as ever; with one the bridge file passes (every burst test above runs it).
        with patch.object(runner, 'NativeStack', side_effect=RuntimeError('stack-not-needed')):
            runner.run_pcn(self.repo, self.root / 'no-burst', mode='smoke', progress=lambda text: None)
        self.assertEqual(json.loads((self.root / 'no-burst/manifest.json').read_text())['failed_stage'], 'startup')

    def test_a_member_without_a_burst_sets_no_window_variable_and_writes_no_burst_file(self):
        manifest, output, calls, environments, private, native = self.run_burst_member(
            'none', burst=None, observe=self.burst_observation, report=self.burst_report)
        self.assertEqual(manifest['status'], 'COMPLETE', manifest)
        self.assertNotIn('PCN_WINDOW', environments[0])
        self.assertNotIn('burst', manifest)
        self.assertEqual([action for action, _, _ in calls], ['inspect', 'inspect'])
        self.assertFalse((output / 'burst.json').exists() or (output / 'burst.jsonl').exists())
        import inspect
        self.assertIsNone(inspect.signature(runner.run_pcn).parameters['burst'].default)

    def test_a_burst_is_refused_before_anything_starts_when_it_is_malformed_or_the_member_has_a_cqrs_configuration(self):
        for burst, options in (({'count': 6}, {}), ({'count': 0, 'at_s': 2}, {}), ({'count': 6, 'at_s': 15}, {}), ({'count': 6, 'at_s': 2}, {'cqrs_configuration': 'O'})):
            with patch.object(runner, 'NativeStack') as native, self.assertRaises(ValueError, msg=str(burst)):
                runner.run_pcn(self.repo, self.root / 'refused', mode='smoke', progress=lambda text: None, locustfile=bs.LOCUSTFILE, burst=burst, **options)
            native.assert_not_called()
            self.assertFalse((self.root / 'refused').exists())  # not even the output directory


WINDOW_MS = (1000.0 + 1_700_000_000.0) * 1000  # the window of the burst tests: opened at monotonic 1000 s, epoch = monotonic + 1.7e9 s


def burst_report(**changes):
    """A burst-report answer for 10 events fired 120 s into the window, drained 8 s later; `changes` replace whole keys."""
    committed = WINDOW_MS + 120_000
    report = {'count': 10, 'notificationWorkers': 2, 'committedAtMs': committed, 'insertMs': 850.0,
              'inbox': {'applied': 10, 'firstAtMs': committed + 500, 'lastAtMs': committed + 8000},
              'relay': {'published': 10, 'lastPublishedAtMs': committed + 3500},
              'latencyMs': [1000.0 * k for k in range(1, 11)],
              'background': {'pairs': [[WINDOW_MS - 5000, 900.0],        # before the window: not counted
                                       [WINDOW_MS + 10_000, 30.0], [committed - 1, 40.0],           # before the burst
                                       [committed, 2000.0], [committed + 5000, 6000.0], [committed + 7999, 7000.0],  # during: from the commit up to the last event applied
                                       [committed + 8000, 50.0], [committed + 80_000, 60.0]],       # after
                             'unmatched': 3},
              'unexpectedExit': False}
    return {**report, **changes}


def burst_samples(consumers=2):
    """Four burst-observe samples around the burst of burst_report (committed at second 1120, drained at 1128): two that read the queue (one just before the burst, one just after),
    one the broker did not answer and one whose control call failed."""
    row = {'queue': {'messageCount': 0, 'consumerCount': consumers}, 'dlq': {'messageCount': 0}, 'clinicOutboxPending': 0, 'unexpectedExit': False}
    return [{'monotonic_s': 1119.0, **row},
            {'monotonic_s': 1121.0, **row, 'queue': {'messageCount': 5800, 'consumerCount': consumers}, 'clinicOutboxPending': 12},
            {'monotonic_s': 1122.0, 'queue': None, 'dlq': None, 'probeError': True, 'clinicOutboxPending': 3, 'unexpectedExit': False},
            {'monotonic_s': 1123.0, 'error': 'control-failed'}]


class BurstArithmetic(unittest.TestCase):
    """The pure part of the notification burst: when it is due, how its latencies are cut and what burst.json says."""

    def test_the_burst_is_due_once_the_window_has_reached_its_moment(self):
        self.assertFalse(runner.burst_due(None, 5000.0, 120))        # the window has not opened
        self.assertFalse(runner.burst_due(1000.0, 1119.9, 120))
        self.assertTrue(runner.burst_due(1000.0, 1120.0, 120))
        self.assertTrue(runner.burst_due(1000.0, 1500.0, 120))       # a tick that came late still fires
        self.assertFalse(runner.burst_due(1000.0, 1500.0, 120, fired=True))
        self.assertTrue(runner.burst_due(0.0, 0.0, 0))

    def test_a_burst_is_a_count_and_a_moment_inside_the_window(self):
        settings = {'seconds': 300}
        self.assertEqual(runner.burst_spec({'count': 6000, 'at_s': 120}, settings), {'count': 6000, 'at_s': 120})
        self.assertEqual(runner.burst_spec({'count': 1, 'at_s': 0}, settings), {'count': 1, 'at_s': 0})
        self.assertEqual(runner.burst_spec({'count': 9000, 'at_s': 299.5}, settings), {'count': 9000, 'at_s': 299.5})
        self.assertEqual((runner.BURST_MAX, runner.OUTBOX_SOFT_LIMIT), (9000, 10000))
        self.assertLess(runner.BURST_MAX, runner.OUTBOX_SOFT_LIMIT)
        self.assertLess(bs.BURST_FULL['count'], runner.BURST_MAX)
        for burst in ({'count': 6000}, {'at_s': 120}, {'count': 6000, 'at_s': 120, 'extra': 1}, {'count': 0, 'at_s': 120}, {'count': 9001, 'at_s': 120}, {'count': 20000, 'at_s': 120},
                      {'count': 6000.0, 'at_s': 120}, {'count': True, 'at_s': 120}, {'count': '6000', 'at_s': 120}, {'count': 6000, 'at_s': -1},
                      {'count': 6000, 'at_s': 300}, {'count': 6000, 'at_s': True}, {'count': 6000, 'at_s': '120'}, None, [6000, 120], 6000):
            with self.assertRaises(ValueError, msg=str(burst)):
                runner.burst_spec(burst, settings)
        with self.assertRaises(ValueError):
            runner.burst_spec({'count': 6000, 'at_s': 120}, settings, cqrs_configuration='F')

    def test_latencies_are_cut_before_during_and_after_by_the_burst_and_its_drain(self):
        points = [(0.0, 10.0), (99.9, 30.0), (100.0, 100.0), (150.0, 400.0), (199.9, 700.0), (200.0, 5.0), (900.0, 9.0)]
        stats = runner.segment_stats(points, (100.0, 200.0))
        self.assertEqual(stats['before'], {'n': 2, 'p50_ms': 10.0, 'p95_ms': 30.0, 'max_ms': 30.0})  # [0, 100): the burst moment itself is `during`
        self.assertEqual(stats['during'], {'n': 3, 'p50_ms': 400.0, 'p95_ms': 700.0, 'max_ms': 700.0})  # [100, 200): the drained moment itself is `after`
        self.assertEqual(stats['after'], {'n': 2, 'p50_ms': 5.0, 'p95_ms': 9.0, 'max_ms': 9.0})
        # Nearest rank, as pcn_contract.percentile: 20 values, p95 is the 19th.
        twenty = runner.latency_stats(range(1, 21))
        self.assertEqual((twenty['p50_ms'], twenty['p95_ms'], twenty['max_ms'], twenty['n']), (10, 19, 20, 20))
        # A burst that never drained: everything from the burst on is `during`; a segment with nothing in it says so.
        open_ended = runner.segment_stats(points, (100.0, math.inf))
        self.assertEqual((open_ended['during']['n'], open_ended['after']), (5, {'n': 0, 'p50_ms': None, 'p95_ms': None, 'max_ms': None}))
        self.assertEqual(runner.segment_stats([], (1.0, 2.0))['before']['n'], 0)
        self.assertEqual(runner.segment_stats(points, (100.0, 100.0))['during']['n'], 0)  # a burst drained at the instant it was fired
        # A drained moment before the burst moment (clocks that disagree) is taken as the burst moment: nothing is `during`, and it is not an error.
        clamped = runner.segment_stats(points, (200.0, 100.0))
        self.assertEqual(clamped, runner.segment_stats(points, (200.0, 200.0)))
        self.assertEqual((clamped['before']['n'], clamped['during']['n'], clamped['after']['n']), (5, 0, 2))

    def test_a_drained_burst_with_one_consumer_per_worker_is_valid_and_every_figure_is_in_window_seconds(self):
        result = runner.burst_summary(burst_report(), burst_samples(2), workers=2, start_monotonic=1000.0, epoch_offset=1_700_000_000.0)
        self.assertTrue(result['valid'], result['reasons'])
        self.assertEqual(result['reasons'], [])
        self.assertEqual((result['count'], result['workers'], result['committed_s'], result['insert_ms']), (10, 2, 120.0, 850.0))
        self.assertEqual((result['drained'], result['drain_s'], result['drain_reading'], result['relay_drain_s']), (True, 8.0, 'đã xả xong', 3.5))
        self.assertEqual(result['latency_ms'], {'n': 10, 'p50_ms': 5000.0, 'p95_ms': 10000.0, 'max_ms': 10000.0})
        background = result['background_latency_ms']
        self.assertEqual(background['before'], {'n': 2, 'p50_ms': 30.0, 'p95_ms': 40.0, 'max_ms': 40.0})  # the one before the window is left out
        self.assertEqual(background['during'], {'n': 3, 'p50_ms': 6000.0, 'p95_ms': 7000.0, 'max_ms': 7000.0})  # from the commit to the last burst event applied
        self.assertEqual(background['after'], {'n': 2, 'p50_ms': 50.0, 'p95_ms': 60.0, 'max_ms': 60.0})
        self.assertEqual(result['background_unmatched'], 3)
        self.assertEqual(result['queue'], {'samples': 2, 'consumer_counts': [2], 'ready_max': 5800, 'dlq_max': 0, 'probe_errors': 1,
                                           'clinic_outbox_pending_max': 12, 'control_errors': 1})
        json.dumps(result)  # burst.json

    def test_the_consumer_count_must_be_the_number_of_workers_in_every_sample(self):
        for consumers, workers in ((1, 2), (2, 1), (0, 1)):
            result = runner.burst_summary(burst_report(), burst_samples(consumers), workers=workers, start_monotonic=1000.0, epoch_offset=1_700_000_000.0)
            self.assertFalse(result['valid'])
            self.assertEqual(len(result['reasons']), 1)
            self.assertIn(f'consumerCount [{consumers}], not {workers}', result['reasons'][0])
        mixed = burst_samples(2) + [{**burst_samples(2)[0], 'queue': {'messageCount': 0, 'consumerCount': 1}}]  # a worker that dropped out for a moment
        self.assertIn('consumerCount [1, 2]', runner.burst_summary(burst_report(), mixed, workers=2, start_monotonic=1000.0, epoch_offset=1_700_000_000.0)['reasons'][0])
        # No sample could read the queue at all: the count is unknown, not assumed.
        blind = [{'monotonic_s': 1100.0, 'queue': None, 'dlq': None, 'probeError': True}]
        self.assertIn('never', runner.burst_summary(burst_report(), blind, workers=2, start_monotonic=1000.0, epoch_offset=1_700_000_000.0)['reasons'][0])

    def test_a_message_in_the_dead_letter_queue_or_a_process_that_exited_makes_the_burst_invalid(self):
        dead = burst_samples(2)
        dead[1] = {**dead[1], 'dlq': {'messageCount': 3}}
        result = runner.burst_summary(burst_report(), dead, workers=2, start_monotonic=1000.0, epoch_offset=1_700_000_000.0)
        self.assertEqual((result['valid'], result['queue']['dlq_max']), (False, 3))
        self.assertEqual(result['reasons'], ['the dead-letter queue held up to 3 message(s)'])
        exited = runner.burst_summary(burst_report(unexpectedExit=True), burst_samples(2), workers=2, start_monotonic=1000.0, epoch_offset=1_700_000_000.0)
        self.assertEqual(exited['reasons'], ['a process of the stack exited unexpectedly'])
        sampled = burst_samples(2)
        sampled[0] = {**sampled[0], 'unexpectedExit': True}
        self.assertFalse(runner.burst_summary(burst_report(), sampled, workers=2, start_monotonic=1000.0, epoch_offset=1_700_000_000.0)['valid'])

    def test_a_dead_letter_in_the_middle_of_the_series_counts_even_when_the_last_sample_is_empty(self):
        base = burst_samples(2)
        for series in ([base[0], {**base[1], 'dlq': {'messageCount': 3}}, {**base[0], 'monotonic_s': 1124.0}],     # 0, 3, 0: the last reading is empty
                       [{**base[0], 'dlq': {'messageCount': 1}}, base[1], {**base[0], 'monotonic_s': 1124.0}],     # 1, 0, 0: the first only
                       [base[0], {**base[1], 'dlq': {'messageCount': 2}}, {**base[1], 'monotonic_s': 1124.0}, {**base[0], 'monotonic_s': 1125.0}]):   # 0, 2, 0, 0
            result = runner.burst_summary(burst_report(), series, workers=2, start_monotonic=1000.0, epoch_offset=1_700_000_000.0)
            self.assertFalse(result['valid'], series)
            self.assertEqual(len(result['reasons']), 1)
            self.assertRegex(result['reasons'][0], r'the dead-letter queue held up to [123] message\(s\)')
        # Every reading empty: valid.
        self.assertTrue(runner.burst_summary(burst_report(), base + [{**base[0], 'monotonic_s': 1124.0}], workers=2, start_monotonic=1000.0, epoch_offset=1_700_000_000.0)['valid'])

    def test_the_burst_needs_a_sample_that_read_the_queue_between_the_burst_and_its_drain(self):
        readable = lambda moment, **more: {'monotonic_s': moment, 'queue': {'messageCount': 0, 'consumerCount': 2}, 'dlq': {'messageCount': 0}, 'clinicOutboxPending': 0,
                                           'unexpectedExit': False, **more}
        summary = lambda samples, report=None: runner.burst_summary(report or burst_report(), samples, workers=2, start_monotonic=1000.0, epoch_offset=1_700_000_000.0)
        reason = 'no sample read the queue between the burst and its drain, so the consumer count is not known for the burst itself'
        # Committed at 1120.0, last event applied at 1128.0, a sample may come up to 2 s after that.
        self.assertEqual(runner.BURST_SAMPLE_GRACE_S, 2.0)
        for samples in ([readable(1100.0), readable(1119.9)],                                          # only before the burst
                        [readable(1130.1)],                                                            # only after the drain and the grace
                        [readable(1121.0, queue=None, probeError=True)],                               # the broker did not answer
                        [readable(1125.0, queue=None, dlq=None, probeError=True), {'monotonic_s': 1126.0, 'error': 'control-failed'}],
                        [readable(1100.0), {'monotonic_s': 1126.0, 'error': 'control-failed'}]):
            result = summary(samples)
            self.assertFalse(result['valid'], samples)
            self.assertIn(reason, result['reasons'])
        for samples in ([readable(1120.01)], [readable(1129.99)], [readable(1100.0), readable(1124.0)]):   # just inside the two edges; one sample is enough
            self.assertEqual(summary(samples)['reasons'], [], samples)
        # A burst that never drained has no end: a sample at any later moment is one of the burst.
        committed = WINDOW_MS + 120_000
        open_ended = burst_report(inbox={'applied': 9, 'firstAtMs': committed + 500, 'lastAtMs': committed + 170_000})
        self.assertNotIn(reason, summary([readable(1290.0)], open_ended)['reasons'])
        self.assertIn(reason, summary([readable(1119.0)], open_ended)['reasons'])

    def test_a_clinic_outbox_at_the_soft_limit_of_the_product_makes_the_burst_invalid(self):
        for pending, valid in ((9999, True), (10000, False), (12345, False)):
            samples = burst_samples(2)
            samples[1] = {**samples[1], 'clinicOutboxPending': pending}
            result = runner.burst_summary(burst_report(), samples, workers=2, start_monotonic=1000.0, epoch_offset=1_700_000_000.0)
            self.assertEqual(result['valid'], valid, pending)
            self.assertEqual(result['queue']['clinic_outbox_pending_max'], pending)
            if not valid:
                self.assertEqual(result['reasons'], [f'the Clinic outbox held {pending} unpublished events, at or above the 10000 at which the product reports itself degraded'])

    def test_clocks_that_disagree_clamp_the_drain_and_say_so_instead_of_failing(self):
        committed = WINDOW_MS + 120_000
        report = burst_report(inbox={'applied': 10, 'firstAtMs': committed - 500, 'lastAtMs': committed - 100})   # the last event "applied" 100 ms before the commit
        result = runner.burst_summary(report, burst_samples(2), workers=2, start_monotonic=1000.0, epoch_offset=1_700_000_000.0)
        self.assertFalse(result['valid'])
        self.assertEqual(result['reasons'], ['the last event was applied before the burst was committed (the clocks of the databases and of the controller disagree): the drain time is taken as 0'])
        self.assertEqual((result['drained'], result['drain_s']), (True, 0.0))
        self.assertEqual(result['background_latency_ms']['during']['n'], 0)
        json.dumps(result)

    def test_a_burst_that_is_not_drained_has_no_drain_time_and_is_not_valid(self):
        committed = WINDOW_MS + 120_000
        report = burst_report(inbox={'applied': 9, 'firstAtMs': committed + 500, 'lastAtMs': committed + 170_000}, relay={'published': 10, 'lastPublishedAtMs': committed + 3500})
        result = runner.burst_summary(report, burst_samples(2), workers=2, start_monotonic=1000.0, epoch_offset=1_700_000_000.0)
        self.assertFalse(result['valid'])
        self.assertEqual(result['reasons'], ['the notification inbox holds 9 of the 10 events'])
        self.assertEqual((result['drained'], result['drain_s'], result['drain_reading']), (False, None, 'không đọc được'))
        self.assertEqual(result['relay_drain_s'], 3.5)  # the relay did finish; only the workers did not
        # Nothing is `after` a drain that never came.
        self.assertEqual(result['background_latency_ms']['after']['n'], 0)
        self.assertEqual(result['background_latency_ms']['during']['n'], 5)
        slow_relay = burst_report(relay={'published': 7, 'lastPublishedAtMs': committed + 3500}, inbox={'applied': 10, 'firstAtMs': committed, 'lastAtMs': committed + 9000})
        self.assertIsNone(runner.burst_summary(slow_relay, burst_samples(2), workers=2, start_monotonic=1000.0, epoch_offset=1_700_000_000.0)['relay_drain_s'])
        self.assertIsNone(runner.burst_summary(burst_report(inbox={'applied': 0, 'firstAtMs': None, 'lastAtMs': None}), burst_samples(2), workers=2,
                                               start_monotonic=1000.0, epoch_offset=1_700_000_000.0)['drain_s'])


class BurstControl(unittest.TestCase):
    """BurstRun against a fake stack: it fires once when the window has reached the burst moment, samples every tick and waits for the drain with a bound."""

    class FakeStack:
        def __init__(self, **answers):
            self.calls, self.answers = [], answers

        def control(self, action, **extra):
            self.calls.append((action, extra))
            answer = self.answers[action]
            if isinstance(answer, Exception):
                raise answer
            return answer(self) if callable(answer) else dict(answer)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.window, self.log = Path(self.directory.name) / 'window.json', Path(self.directory.name) / 'burst.jsonl'

    def run_of(self, stack, count=5, at_s=10):
        run = runner.BurstRun(stack, {'count': count, 'at_s': at_s}, 1, self.window, self.log)
        self.addCleanup(run.close)
        return run

    def test_it_waits_for_the_window_fires_once_and_samples_every_tick(self):
        stack = self.FakeStack(**{'burst-observe': {'queue': {'messageCount': 0, 'consumerCount': 1}}, 'notification-burst': {'count': 5, 'committedAtMs': 1.0}})
        run = self.run_of(stack)
        run.tick(100.0)  # the generator has not written the window yet
        self.assertEqual((run.start, run.fired, [action for action, _ in stack.calls]), (None, None, ['burst-observe']))
        self.window.write_text(json.dumps({'start_monotonic': 100.0, 'seen_monotonic': 100.1, 'seen_epoch': 1.7e9}))
        run.tick(109.9)
        self.assertEqual((run.start, run.fired), (100.0, None))
        run.tick(110.0)
        self.assertEqual(run.fired['monotonic_s'], 110.0)
        self.assertAlmostEqual(run.fired['epoch_offset_s'], time.time() - time.monotonic(), delta=1.0)
        self.assertEqual(run.fired['response']['count'], 5)
        run.tick(111.0)
        run.tick(500.0)
        self.assertEqual([action for action, _ in stack.calls].count('notification-burst'), 1)  # once, however late the next ticks are
        self.assertEqual(next(extra for action, extra in stack.calls if action == 'notification-burst'), {'count': 5})
        self.assertEqual([action for action, _ in stack.calls][-3:], ['burst-observe', 'burst-observe', 'burst-observe'])
        self.assertEqual(len(run.observations), 5)  # one per tick, the burst or not
        written = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual([row['monotonic_s'] for row in written], [100.0, 109.9, 110.0, 111.0, 500.0])  # the file is flushed as it goes, so it is complete even if the run dies

    def test_a_window_file_that_is_missing_cut_off_or_wrong_is_not_a_start(self):
        run = self.run_of(self.FakeStack())
        self.assertIsNone(run.window_start())  # no file
        for text in ('', '{', '{"start_monotonic"', '[]', '{}', '{"start_monotonic": "100"}', '{"start_monotonic": true}', '{"start_monotonic": null}'):
            self.window.write_text(text)
            self.assertIsNone(run.window_start(), text)
        self.window.write_text('{"start_monotonic": 100}')
        self.assertEqual(run.window_start(), 100)

    def test_a_sample_that_fails_is_recorded_and_a_burst_that_fails_is_marked_for_burst_json_and_never_fired_again(self):
        stack = self.FakeStack(**{'burst-observe': RuntimeError('Stack control timeout'), 'notification-burst': RuntimeError('Stack control failed: control-action-failed')})
        run = self.run_of(stack)
        run.tick(100.0)
        self.assertEqual(run.observations, [{'monotonic_s': 100.0, 'error': 'control-failed'}])
        self.window.write_text('{"start_monotonic": 100.0}')
        run.tick(110.0)  # the load goes on: a side measurement does not take a six-hour run down
        self.assertIsNone(run.fired)
        self.assertEqual(run.failure, {'monotonic_s': 110.0, 'error_type': 'RuntimeError', 'error': 'Stack control failed: control-action-failed'})
        run.tick(111.0)
        run.tick(500.0)
        actions = [action for action, _ in stack.calls]
        self.assertEqual(actions.count('notification-burst'), 1)  # one attempt, never a retry
        self.assertEqual(len(run.observations), 4)  # the samples go on
        result = run.finish(progress=lambda text: None)
        self.assertEqual((result['status'], result['valid'], result['window_opened'], result['fired_s'], result['observations']), ('FIRE_FAILED', False, True, 10.0, 4))
        self.assertEqual(result['reasons'], ['the burst could not be fired: RuntimeError: Stack control failed: control-action-failed'])
        self.assertEqual((result['count'], result['at_s']), (5, 10))
        self.assertNotIn('burst-report', [action for action, _ in stack.calls])  # nothing to report, no drain to wait for
        json.dumps(result)

    def test_a_report_that_cannot_be_read_is_marked_and_not_raised(self):
        observed = lambda s: {'queue': {'messageCount': 0, 'consumerCount': 1}, 'dlq': {'messageCount': 0}, 'burstApplied': 5}
        for report, name in ((RuntimeError('Stack control timeout'), 'RuntimeError'), ({}, 'KeyError'), (OSError('pipe'), 'OSError')):
            stack = self.FakeStack(**{'burst-observe': observed, 'burst-report': report})
            run = self.run_of(stack)
            run.start, run.fired = 1000.0, {'monotonic_s': 1120.0, 'epoch_offset_s': 1_700_000_000.0, 'response': {}}
            with patch.object(runner, 'time', Clock()):
                result = run.finish(progress=lambda text: None)
            self.assertEqual((result['status'], result['valid'], result['fired_s']), ('REPORT_FAILED', False, 120.0), name)
            self.assertTrue(result['reasons'][0].startswith(f'the burst report could not be read: {name}'), result['reasons'])
            self.assertEqual((result['count'], result['at_s'], result['observations']), (5, 10, 1))
            json.dumps(result)

    def test_finish_waits_for_the_inbox_to_hold_the_burst_then_reads_the_report(self):
        applied = iter([2, 4, 5])
        stack = self.FakeStack(**{'burst-observe': lambda s: {'queue': {'messageCount': 0, 'consumerCount': 1}, 'dlq': {'messageCount': 0}, 'burstApplied': next(applied)},
                                  'burst-report': lambda s: burst_report(count=5, inbox={'applied': 5, 'firstAtMs': WINDOW_MS + 121_000, 'lastAtMs': WINDOW_MS + 124_000},
                                                                         relay={'published': 5, 'lastPublishedAtMs': WINDOW_MS + 122_000}, latencyMs=[1.0] * 5)})
        run = self.run_of(stack)
        run.start, run.fired = 1000.0, {'monotonic_s': 1120.0, 'epoch_offset_s': 1_700_000_000.0, 'response': {}}
        clock = Clock()
        clock.t = 1121.0  # just after the commit at 1120 s
        with patch.object(runner, 'time', clock):
            result = run.finish(progress=lambda text: None)
        self.assertEqual([action for action, _ in stack.calls], ['burst-observe'] * 3 + ['burst-report'])
        self.assertEqual(clock.t, 1123.0)  # one second between samples, none after the last
        self.assertEqual((result['status'], result['valid'], result['drain_s'], result['fired_s'], result['observations']), ('COMPLETE', True, 4.0, 120.0, 3))
        self.assertEqual((result['count'], result['at_s'], result['start_monotonic']), (5, 10, 1000.0))

    def test_finish_gives_up_after_the_drain_wait_and_reports_what_it_has(self):
        stack = self.FakeStack(**{'burst-observe': {'queue': {'messageCount': 900, 'consumerCount': 1}, 'dlq': {'messageCount': 0}, 'burstApplied': 3},
                                  'burst-report': lambda s: burst_report(count=5, inbox={'applied': 3, 'firstAtMs': WINDOW_MS + 121_000, 'lastAtMs': WINDOW_MS + 130_000},
                                                                         relay={'published': 5, 'lastPublishedAtMs': WINDOW_MS + 122_000}, latencyMs=[1.0] * 3)})
        run = self.run_of(stack)
        run.start, run.fired = 1000.0, {'monotonic_s': 1120.0, 'epoch_offset_s': 1_700_000_000.0, 'response': {}}
        clock = Clock()
        with patch.object(runner, 'time', clock):
            result = run.finish(progress=lambda text: None)
        self.assertEqual(runner.BURST_DRAIN_WAIT_S, 180)
        self.assertEqual(clock.t, 1000.0 + 180)  # sampled once a second until the 180 s were over
        self.assertEqual([action for action, _ in stack.calls].count('burst-observe'), 181)
        self.assertEqual((result['status'], result['valid'], result['drained'], result['drain_s'], result['drain_reading']), ('COMPLETE', False, False, None, 'không đọc được'))

    def test_finish_without_a_burst_fired_says_so_and_asks_for_no_report(self):
        stack = self.FakeStack()
        run = self.run_of(stack, count=7, at_s=300)
        self.assertEqual(run.finish(progress=lambda text: None), {'status': 'NOT_FIRED', 'valid': False, 'window_opened': False, 'count': 7, 'at_s': 300,
                                                                   'reasons': ['the measurement window never reached the burst moment']})
        self.assertEqual(stack.calls, [])


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
        self.assertIn('stopping, sampler = sampler, None', self.text)
        self.assertIn('stop_pg_sampler(stopping, None, *steady_window(settings, started_epoch, time.time()))', self.text)
        self.assertLess(self.text.index('stopping, sampler = sampler, None'), self.text.index('stop_pg_sampler(stopping, None'))   # forgotten before it is stopped
        self.assertIn('            stop_pg_sampler(sampler)\n        (output / \'manifest.json\')', self.text.replace('\r\n', '\n'))   # the clean-up before the manifest cannot raise
        self.assertNotIn('.stop(', self.text.replace('stop_pg_sampler(', ''))
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


# ---- bridge-m-h-vm-v2 (K9 C3) ----------------------------------------------------------------------------------------------------------
def v2m(config='H3', *, rps=100.0, read=50.0, read_ok=None, p95=80.0, cpu=10.0, cores=1.0, failures=0, requests=1000, generator=0.3, components=None, rate_429=0.0, shares=None,
        p2024=0, http_503=0, available=True, valid=True, burst=None, segments=None):
    """The metrics a v2 member has, without the files: what the analysis reads."""
    components = {'core': 0.4, 'clinic-0': 0.3, 'postgres': 0.8} if components is None else components
    ops = {name: {'p95_ms': p95, 'p50_ms': p95 / 2, 'mean_response_bytes': 100} for name in ('GET pets', 'POST appointment')}
    return {'valid': valid, 'reasons': [] if valid else ['x'], 'operations': ops, 'requests': requests, 'failures': failures, 'success_rps': rps, 'read_p95_ms': read,
            'read_p95_ok_ms': read if read_ok is None else read_ok,
            'p95_ms': p95, 'p50_ms': p95 / 2, 'cpu_ms_per_success': cpu, 'server_cores': cores, 'server_rss_mb': 300.0, 'generator_cores': generator, 'components': components,
            'groups': bs.component_groups(components), 'http': {'http_429': int(rate_429 * requests), 'rate_429': rate_429, 'rate_503': 0.0},
            'pool': {'available': available, 'at_pool_limit_share': shares or {}, 'p2024_log_lines': p2024, 'http_503': http_503}, 'outbox': None, 'burst': burst,
            'read_p95_segments': segments or {'before': {'n': 90, 'p95_ms': read}, 'after': {'n': 60, 'p95_ms': read}}, 'config': config}


class World:
    """A synthetic host for the v2 study. A closed-loop member of `config` with `users` asks for 0.9 x users requests per second and is served at most its capacity; its read p95 is
    40 ms until it is within 5% of the capacity and 900 ms from there; it fails 3% of its requests when it is asked for 1.5x its capacity. Core, Clinic and Postgres use CPU in
    proportion to what is served (Core one core at 300 requests per second and instance, Clinic half of that). The host slows by `drift` per position in the run."""
    CAPACITY = {'M': 900.0, 'H1': 300.0, 'H3': 300.0, 'H3c': 270.0, 'H3x2': 520.0, 'H3p8': 300.0, 'H3cl2': 300.0, 'H3x2cl2': 520.0, 'H3b': 300.0, 'H3bnw2': 300.0}

    def __init__(self, drift=1.0, capacity=None, generator=None, rate_429=None, pool_full=()):
        self.drift, self.capacity, self.generator = drift, {**self.CAPACITY, **(capacity or {})}, generator or {}
        self.rate_429, self.pool_full = rate_429 or {}, tuple(pool_full)

    def components(self, config, served, slow):
        plan = bs.VM2_CONFIGS[config]
        if config == 'M':
            return {'api': min(1.0, served / 900.0) * slow, 'postgres': served / 150.0 * slow}
        cores, clinics = plan['core'], plan['clinic']
        out = {('core' if cores == 1 else f'core-{i}'): min(1.0, served / 300.0 / cores) * slow for i in range(cores)}
        out.update({f'clinic-{i}': min(1.0, served / 600.0 / clinics) * slow for i in range(clinics)})
        out['postgres'] = served / 150.0 * slow
        return out

    def metrics(self, config, users, position, *, errors_invalidate=True, burst=False, **unused):
        slow = self.drift ** position
        capacity = self.capacity[config]
        demand = 0.9 * users
        served = min(demand, capacity) / slow
        read = (40.0 if demand < 0.95 * capacity else 900.0) * slow
        failures = 30 if demand >= 1.5 * capacity else 0
        components = self.components(config, min(demand, capacity), slow)
        generator = self.generator.get((config, users), 0.1 + 0.0004 * served)
        full = {'p8-core': 0.8, 'p8-core-0': 0.8, 'p8-clinic-0': 0.1} if demand >= 0.95 * capacity and config in self.pool_full else {'p8-core': 0.1, 'p8-clinic-0': 0.05}
        valid = not (errors_invalidate and failures)
        value = v2m(config, rps=served, read=read, p95=read * 1.2, cpu=sum(components.values()) * 1000 / served, cores=sum(components.values()), failures=failures, generator=generator,
                    components=components, rate_429=self.rate_429.get((config, users), 0.0), shares=full, valid=valid,
                    burst={'drain_s': 20.0 / plan_nw(config) * slow, 'relay_drain_s': 4.0 * slow} if bs.VM2_CONFIGS[config].get('burst') else None)
        if not valid:
            value['reasons'] = ['error rate above 1%']
        return value


def plan_nw(config):
    return bs.VM2_CONFIGS[config].get('nw', 1)


def records_of(world, blocks):
    """Records of a complete run of `blocks` (bs.block_spec dicts) in a synthetic world, as VmStudy2.run_member would write them."""
    records = []
    for block in blocks:
        for config in block['order']:
            index = len(records)
            metrics = world.metrics(config, block['settings']['users'], index, errors_invalidate=block['errors_invalidate'])
            records.append({'index': index, 'name': bs.member_name(index, block['settings']['users'], config), 'block': block['name'], 'kind': block['kind'],
                            'users': block['settings']['users'], 'config': config, 'planned_order': list(block['order']), 'metrics': metrics})
    return records


class PairIndicesGeneral(unittest.TestCase):
    def test_every_order_of_the_study_is_a_palindrome_with_each_configuration_twice(self):
        for order in (bs.PART1_ORDER, bs.BURST_ORDER, bs.TIER_ORDER, bs.TOP_ORDER, bs.POOL_ORDER, bs.VM_ORDER):
            self.assertEqual(order, order[::-1])
            self.assertTrue(all(order.count(c) == 2 for c in order), order)
        self.assertEqual(len(bs.TOP_ORDER), 10)
        self.assertEqual(bs.TOP_ORDER, ('M', 'H3', 'H3cl2', 'H3x2', 'H3x2cl2', 'H3x2cl2', 'H3x2', 'H3cl2', 'H3', 'M'))

    def test_the_k_th_base_goes_with_the_k_th_other_whether_they_are_adjacent_or_two_places_apart(self):
        top = bs.TOP_ORDER
        self.assertEqual(bs.pair_indices(top, 'H3', 'H3cl2'), [(1, 2), (8, 7)])
        self.assertEqual(bs.pair_indices(top, 'H3', 'H3x2'), [(1, 3), (8, 6)])
        self.assertEqual(bs.pair_indices(top, 'H3x2', 'H3x2cl2'), [(3, 4), (6, 5)])
        self.assertEqual(bs.pair_indices(top, 'H3cl2', 'H3x2cl2'), [(2, 4), (7, 5)])
        self.assertEqual(bs.pair_indices(top, 'M', 'H3'), [(0, 1), (9, 8)])
        self.assertEqual(bs.pair_indices(bs.PART1_ORDER, 'M', 'H3'), [(0, 2), (7, 5)])
        self.assertEqual(bs.pair_indices(bs.PART1_ORDER, 'H1', 'H3'), [(1, 2), (6, 5)])
        self.assertEqual(bs.pair_indices(bs.PART1_ORDER, 'H3', 'H3c'), [(2, 3), (5, 4)])
        self.assertEqual(bs.pair_indices(bs.BURST_ORDER, 'H3b', 'H3bnw2'), [(0, 1), (3, 2)])
        # The v1 order still reads as before.
        self.assertEqual(bs.pair_indices(bs.VM_ORDER, 'H0', 'H1'), [(1, 2), (6, 5)])

    def test_a_multiplicative_drift_cancels_exactly_in_every_pair_of_every_order(self):
        for order in (bs.PART1_ORDER, bs.TIER_ORDER, bs.TOP_ORDER, bs.POOL_ORDER):
            truth = {c: 10.0 * (i + 1) for i, c in enumerate(dict.fromkeys(order))}
            for drift in (1.0, 1.07, 0.93):
                values = [truth[c] * drift ** position for position, c in enumerate(order)]
                for base in truth:
                    for other in truth:
                        if base != other:
                            pairs = [({'v': values[a]}, {'v': values[b]}) for a, b in bs.pair_indices(order, base, other)]
                            self.assertAlmostEqual(bs.balanced(pairs, lambda m: m['v'])[0], truth[other] / truth[base], places=9, msg=(order, base, other, drift))

    def test_an_order_that_is_not_symmetric_or_not_twice_each_or_names_an_unknown_configuration_is_refused(self):
        for order, base, other in (
                (('M', 'H1', 'H3', 'M'), 'M', 'H1'),                         # not a palindrome
                (('M', 'H1', 'H1', 'M', 'H3', 'H3'), 'M', 'H1'),             # not a palindrome
                (('M', 'H1', 'H3', 'H3', 'H1', 'M', 'M'), 'M', 'H1'),        # not a palindrome
                (('M', 'H1', 'H1', 'M'), 'M', 'H3'),                         # H3 is not in the order
                (('M', 'H1', 'H1', 'M'), 'M', 'M'),                          # a configuration against itself
                (('M', 'H1', 'M'), 'M', 'H1'),                               # H1 once
                (('M', 'H1', 'H1', 'H1', 'H1', 'M'), 'M', 'H1'),             # H1 four times
                (('M', 'M', 'M', 'M'), 'M', 'H1')):
            with self.assertRaisesRegex(ValueError, 'BRIDGE_ORDER_NOT_BALANCED', msg=(order, base, other)):
                bs.pair_indices(order, base, other)

    def test_balanced_gives_up_on_a_non_positive_value_instead_of_taking_its_logarithm(self):
        self.assertEqual(bs.balanced([({'v': 1.0}, {'v': 0.0}), ({'v': 1.0}, {'v': 2.0})], lambda m: m['v']), (None, []))
        self.assertEqual(bs.balanced([({'v': 1.0}, {'v': None})], lambda m: m['v']), (None, []))
        self.assertAlmostEqual(bs.balanced([({'v': 1.0}, {'v': 2.0}), ({'v': 2.0}, {'v': 1.0})], lambda m: m['v'])[0], 1.0)


class VmV2Plan(unittest.TestCase):
    def test_configurations_are_the_ten_of_the_design_and_each_names_its_tree_and_axes(self):
        self.assertEqual(set(bs.VM2_CONFIGS), {'M', 'H1', 'H3', 'H3c', 'H3x2', 'H3p8', 'H3cl2', 'H3x2cl2', 'H3b', 'H3bnw2'})
        self.assertEqual(bs.VM2_GROUPS, ('M', 'H1', 'H3'))
        axes = lambda c: tuple(bs.VM2_CONFIGS[c][k] for k in ('tree', 'core', 'clinic', 'pool', 'topology', 'layout', 'nw'))
        self.assertEqual(axes('H1'), ('H1', 1, 1, 4, 'direct', 'phase2', 1))          # 2841d1b: the phase2 worker layout, the standard topology
        self.assertEqual(axes('H3'), ('H3', 1, 1, 4, 'direct', 'workers', 1))         # HEAD
        self.assertEqual(axes('H3c'), ('H3', 1, 1, 4, 'core-ingress', 'workers', 1))
        self.assertEqual(axes('H3x2'), ('H3', 2, 1, 4, 'direct', 'workers', 1))
        self.assertEqual(axes('H3p8'), ('H3', 1, 1, 8, 'direct', 'workers', 1))
        self.assertEqual(axes('H3cl2'), ('H3', 1, 2, 4, 'direct', 'workers', 1))
        self.assertEqual(axes('H3x2cl2'), ('H3', 2, 2, 4, 'direct', 'workers', 1))
        self.assertEqual((axes('H3b'), axes('H3bnw2')), (('H3', 1, 1, 4, 'direct', 'workers', 1), ('H3', 1, 1, 4, 'direct', 'workers', 2)))
        self.assertEqual({c for c, v in bs.VM2_CONFIGS.items() if v.get('burst')}, {'H3b', 'H3bnw2'})
        self.assertEqual(bs.VM2_CONFIGS['M'], {'tree': 'M'})
        for config, plan in bs.VM2_CONFIGS.items():
            self.assertIn(plan['tree'], bs.VM2_GROUPS)
            if config != 'M':
                self.assertIn(plan['layout'], native_stack.CORE_LAYOUTS)
                self.assertTrue(native_stack.DB_POOL_LIMITS[0] <= plan['pool'] <= native_stack.DB_POOL_LIMITS[1])
        # v1's table is untouched.
        self.assertEqual(set(bs.VM_CONFIGS), {'M', 'H0', 'H1', 'H2'})

    def test_orders_steps_and_the_smoke_are_the_ones_the_design_and_the_appendix_fix(self):
        self.assertEqual(bs.PART1_ORDER, ('M', 'H1', 'H3', 'H3c', 'H3c', 'H3', 'H1', 'M'))
        self.assertEqual(bs.BURST_ORDER, ('H3b', 'H3bnw2', 'H3bnw2', 'H3b'))
        self.assertEqual(bs.TIER_ORDER, ('M', 'H3', 'H3x2', 'H3x2', 'H3', 'M'))
        self.assertEqual(bs.POOL_ORDER, ('H3', 'H3p8', 'H3p8', 'H3'))
        self.assertEqual(bs.VM2_SMOKE_ORDER, ('M', 'H1', 'H3', 'H3c', 'H3x2', 'H3p8', 'H3cl2', 'H3x2cl2', 'H3bnw2'))   # every configuration but H3b
        self.assertEqual((bs.STEPS, bs.TOP_FALLBACK), ((200, 400, 800), 600))
        self.assertEqual((bs.BURST_FULL, bs.BURST_SMOKE), ({'count': 6000, 'at_s': 120}, {'count': 200, 'at_s': 5}))
        for order in (bs.PART1_ORDER, bs.BURST_ORDER, bs.TIER_ORDER, bs.TOP_ORDER, bs.POOL_ORDER):
            self.assertTrue(set(order) <= set(bs.VM2_CONFIGS))
        self.assertTrue(set(bs.VM2_SMOKE_ORDER) <= set(bs.VM2_CONFIGS))

    def test_part_1_keeps_the_settings_of_v1_and_each_step_has_a_spawn_rate_of_users_over_ten(self):
        self.assertEqual(bs.load_settings(100), bs.FULL)
        self.assertEqual(bs.load_settings(100), {'users': 100, 'seconds': 300, 'warmup': 30, 'spawn_rate': 10})
        for users in (200, 400, 600, 800):
            settings = bs.load_settings(users)
            self.assertEqual((settings['spawn_rate'], settings['seconds'], settings['warmup']), (users // 10, 300, 30))
            self.assertEqual(settings['users'] / settings['spawn_rate'], 10.0)   # the ramp stays 10 s
        self.assertEqual(bs.load_settings(200, bs.LOCAL_WINDOW), {'users': 200, 'seconds': 60, 'warmup': 10, 'spawn_rate': 20})

    def test_the_full_plan_runs_part_1_the_burst_block_and_the_three_steps_with_the_clinic_block_at_the_highest(self):
        blocks = bs.vm2_blocks('full')
        self.assertEqual([(b['name'], b['kind'], b['users'], b['order']) for b in blocks],
                         [('part1', 'part1', 100, bs.PART1_ORDER), ('burst', 'burst', 100, bs.BURST_ORDER), ('tier-200', 'tier', 200, bs.TIER_ORDER),
                          ('tier-400', 'tier', 400, bs.TIER_ORDER), ('tier-800', 'tier', 800, bs.TOP_ORDER)])
        self.assertEqual(sum(len(b['order']) for b in blocks), 8 + 4 + 6 + 6 + 10)
        self.assertEqual(blocks[0]['settings'], bs.FULL)
        self.assertEqual(blocks[1]['burst'], {'count': 6000, 'at_s': 120})
        self.assertEqual(blocks[1]['settings'], bs.FULL)   # the background of the burst: 100 users, the window of Part 1
        self.assertEqual([(b['name'], b['pg_sampler'], b['errors_invalidate'], b['top'], b['burst']) for b in blocks],
                         [('part1', False, True, False, None), ('burst', False, True, False, bs.BURST_FULL), ('tier-200', True, False, False, None),
                          ('tier-400', True, False, False, None), ('tier-800', True, False, True, None)])
        self.assertEqual(bs.vm2_blocks('smoke'), [])
        self.assertEqual(bs.pool_block(400)['order'], bs.POOL_ORDER)
        self.assertEqual((bs.pool_block(400)['name'], bs.pool_block(400)['pg_sampler'], bs.pool_block(400)['errors_invalidate']), ('pool-400', True, False))
        self.assertEqual((bs.top_block(600)['name'], bs.top_block(600)['top'], bs.top_block(600)['settings']['spawn_rate']), ('tier-600', False, 60))

    def test_the_local_plan_is_a_reduced_dry_run_of_every_kind_of_block(self):
        blocks = bs.vm2_blocks('local')
        self.assertEqual([(b['name'], b['kind'], b['order']) for b in blocks],
                         [('tier-200', 'tier', bs.TIER_ORDER), ('probe-800', 'probe', ('M', 'H3x2cl2')), ('probe-100', 'probe', ('H3b', 'H3bnw2'))])   # M@800 opens the probe as it opens the full step (K10)
        for block in blocks:
            self.assertEqual((block['settings']['seconds'], block['settings']['warmup']), (60, 10))
        self.assertEqual(blocks[2]['burst'], {'count': 2000, 'at_s': 20})
        self.assertLess(blocks[2]['burst']['at_s'], blocks[2]['settings']['seconds'])
        self.assertEqual((blocks[1]['settings']['users'], blocks[1]['pg_sampler'], blocks[1]['top']), (800, True, True))

    def test_the_cuts_for_a_run_over_six_hours_drop_the_h3x2_pair_of_the_200_step_and_shorten_the_burst_block(self):
        cut = bs.vm2_blocks('full', ('x2-200',))
        self.assertEqual(cut[2]['order'], ('M', 'H3', 'H3', 'M'))
        self.assertEqual(sum(len(b['order']) for b in cut), 8 + 4 + 4 + 6 + 10)
        short = bs.vm2_blocks('full', ('burst-short',))[1]
        self.assertEqual((short['settings']['seconds'], short['burst']), (180, {'count': 6000, 'at_s': 60}))
        self.assertEqual((bs.burst_moment(), bs.burst_moment(('x2-200',)), bs.burst_moment(('burst-short',))), (120, 120, 60))
        for mode, cuts in (('local', ('x2-200',)), ('full', ('nothing',)), ('smoke', ('x2-200',))):
            with self.assertRaises(ValueError):
                bs.vm2_blocks(mode, cuts)

    def test_a_measured_member_is_named_after_its_position_its_users_and_its_configuration(self):
        self.assertEqual(bs.member_name(7, 400, 'H3x2cl2'), 'full-7-400-H3x2cl2')

    def test_the_estimate_is_calibrated_on_the_real_vm_v1_run_and_the_cuts_still_take_what_s9_says_off(self):
        # Measured (VM v1, 28/10): a member of 100 users ran 355.4-356.6 s (H) and 345.1 s (M) for 340 s of ramp, warmup and window; a smoke member 21-36 s; a local member 84.5-98.2 s.
        self.assertAlmostEqual(bs.member_minutes(bs.FULL) * 60, 356, delta=1)
        self.assertAlmostEqual(bs.member_minutes(bs.SMOKE) * 60, 33, delta=3)
        self.assertAlmostEqual(bs.member_minutes(bs.load_settings(100, bs.LOCAL_WINDOW)) * 60, 96, delta=2)
        self.assertEqual(bs.member_minutes(bs.load_settings(100)), bs.member_minutes(bs.FULL))
        # Estimated: the time per user above the 100 of the measurement (800 users have never been run), the setup, the wait for a burst to drain.
        self.assertAlmostEqual(bs.member_minutes(bs.load_settings(800)) - bs.member_minutes(bs.FULL), bs.SETUP_S_PER_USER * 700 / 60)
        self.assertGreater(bs.member_minutes(bs.load_settings(100), True), bs.member_minutes(bs.load_settings(100)))
        full = bs.estimate_minutes('full')
        self.assertTrue(3.2 <= full['members'] / 60 <= 4.0, full['members'] / 60)       # 34 members of 5.9 to 7.1 min
        self.assertTrue(4.0 <= full['vm_on'] / 60 <= 4.5, full['vm_on'] / 60)           # with the setup, the smoke and the local dry run before it
        self.assertEqual(round(full['pool_block']), 26)                                  # only if H3 is saturated by its pool
        self.assertLess(full['vm_on'], bs.VM_ON_LIMIT_MIN)                               # the real member time puts the run well under the 6 h of S9
        first, both = bs.estimate_minutes('full', cuts=('x2-200',)), bs.estimate_minutes('full', cuts=bs.CUTS)
        self.assertAlmostEqual(full['members'] - first['members'], 12.2, delta=1.0)      # the H3x2 pair of the 200 step: two members of 6.1 min
        self.assertAlmostEqual(first['members'] - both['members'], 8.0, delta=1.0)       # four members, 2 min of window each
        local, smoke = bs.estimate_minutes('local'), bs.estimate_minutes('smoke')
        self.assertTrue(15 <= local['members'] <= 25 and 4 <= smoke['smoke'] <= 7, (local['members'], smoke['smoke']))
        self.assertEqual(smoke['run'], smoke['setup'] + smoke['smoke'])
        self.assertEqual(bs.estimate_minutes('full', install=False)['setup'], 0.0)
        # The estimate is the sum over the plan, member by member; the dry run adds the smoke and the local members.
        self.assertAlmostEqual(full['members'], sum(bs.member_minutes(b['settings'], bool(b['burst'] and bs.VM2_CONFIGS[c].get('burst'))) for b in bs.vm2_blocks('full') for c in b['order']))
        self.assertAlmostEqual(full['dry_run'], full['smoke'] + local['members'])
        self.assertAlmostEqual(full['vm_on'], full['run'] + full['dry_run'])

    def test_every_constant_of_the_estimate_says_whether_it_was_measured_or_estimated(self):
        source = (HERE / 'bridge_study.py').read_text(encoding='utf-8')
        comment = source[source.index('# The estimate of the time the VM is on'):source.index('SETUP_MIN, MEMBER_OVERHEAD_MIN')]
        for needle in ('MEASURED', 'ESTIMATED', 'MEMBER_OVERHEAD_MIN', 'SETUP_MIN', 'SETUP_S_PER_USER', 'BURST_WAIT_MIN', 'bridge vm-v1', '355.4-356.6', '345.1', '800 users have never been run'):
            self.assertIn(needle, comment)
        self.assertFalse(hasattr(bs, 'DRAIN_S'))   # the drain is part of the measured overhead

    def test_the_estimate_is_printed_when_the_study_starts_with_the_dry_run_the_pool_block_and_the_cuts(self):
        text = bs.estimate_text('full')
        for needle in ('estimated time of the full run', '3.8 h', 'local dry run', 'about 4.2 h', 'pool block adds 26 min', 'calibrated on the VM v1 run', bs.CUT_ADVICE):
            self.assertIn(needle, text)
        self.assertEqual(bs.CUT_ADVICE, 'quyết định --cut theo thời gian thật của lượt local')
        self.assertNotIn('over 6 h', text)   # 4.2 h: no cut is advised by the estimate
        with patch.object(bs, 'VM_ON_LIMIT_MIN', 240):   # a limit under the estimate brings the advice back: each cut with the time it leaves
            advised = bs.estimate_text('full')
        for needle in ('over 4 h: pass --cut x2-200: 4.0 h', 'with --cut burst-short as well: 3.9 h', bs.CUT_ADVICE):
            self.assertIn(needle, advised)
        self.assertIn('cuts applied: x2-200', bs.estimate_text('full', cuts=('x2-200',)))
        self.assertIn(bs.CUT_ADVICE, bs.estimate_text('full', cuts=('x2-200',)))
        self.assertNotIn('over 6 h', bs.estimate_text('full', cuts=('x2-200',)))
        self.assertNotIn(bs.CUT_ADVICE, bs.estimate_text('local'))   # the advice is for the full run
        self.assertNotIn('dry run', bs.estimate_text('smoke'))
        lines = []
        study = bs.VmStudy2('/nowhere', '/nowhere/private', '/nowhere/results', 'run-1', mode='full', progress=lines.append)
        with patch.object(bs.Study, 'execute', return_value={'status': 'x'}) as execute:
            study.execute(install=False)
        execute.assert_called_once_with(install=False)
        self.assertEqual(lines, [bs.estimate_text('full', False)])


class VmV2Member(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / 'src'
        self.root.mkdir()
        self.private = Path(self.directory.name) / 'private'
        self.private.mkdir()
        self.study = bs.VmStudy2(self.root, self.private, Path(self.directory.name) / 'results', 'run-1', mode='full', progress=lambda text: None)
        self.study.pinning = {'generator': [0], 'server': [1, 2]}

    def run_members(self, *calls):
        monolith, pcn = MagicMock(), MagicMock()
        with patch.dict(sys.modules, {'bridge_monolith': types.SimpleNamespace(run_monolith=monolith), 'pcn_runner': types.SimpleNamespace(run_pcn=pcn)}):
            for index, (configuration, settings, label, options) in enumerate(calls):
                self.study.member(index, configuration, settings, label, **options)
        return monolith, pcn

    def test_each_configuration_runs_its_tree_with_its_instances_pool_layout_topology_and_workers(self):
        every = [(c, bs.SMOKE, 'smoke', {'burst': bs.BURST_SMOKE} if bs.VM2_CONFIGS[c].get('burst') else {}) for c in bs.VM2_SMOKE_ORDER]
        monolith, pcn = self.run_members(*every)
        self.assertEqual(monolith.call_count, 1)
        self.assertEqual(monolith.call_args.args[:2], (self.root / 'M', self.root / 'H3'))   # the monolith runs the locustfile of the H3 tree
        self.assertEqual((monolith.call_args.kwargs['pinning'], monolith.call_args.kwargs['pg_sampler']), (self.study.pinning, False))
        seen = [(c.args[0].name, c.kwargs['core_replicas'], c.kwargs['replicas'], c.kwargs['db_pool_limit'], c.kwargs['core_layout'], c.kwargs['gateway_topology'],
                 c.kwargs['notification_workers'], c.kwargs['burst']) for c in pcn.call_args_list]
        self.assertEqual(seen, [('H1', 1, 1, 4, 'phase2', 'direct', 1, None), ('H3', 1, 1, 4, 'workers', 'direct', 1, None), ('H3', 1, 1, 4, 'workers', 'core-ingress', 1, None),
                                ('H3', 2, 1, 4, 'workers', 'direct', 1, None), ('H3', 1, 1, 8, 'workers', 'direct', 1, None), ('H3', 1, 2, 4, 'workers', 'direct', 1, None),
                                ('H3', 2, 2, 4, 'workers', 'direct', 1, None), ('H3', 1, 1, 4, 'workers', 'direct', 2, bs.BURST_SMOKE)])
        for call in pcn.call_args_list:
            self.assertEqual((call.kwargs['service_env'], call.kwargs['pinning'], call.kwargs['vm'], call.kwargs['core_proxy'], call.kwargs['locustfile'], call.kwargs['mode']),
                             (bs.H_LIMITS, self.study.pinning, True, True, bs.LOCUSTFILE, 'smoke'))
            self.assertFalse(call.kwargs['pg_sampler'])
        self.assertEqual([s['stage'] for s in self.study.stages], [f'smoke-{i}-{c}' for i, c in enumerate(bs.VM2_SMOKE_ORDER)])

    def test_a_measured_member_is_named_by_position_users_and_configuration_and_runs_the_sampler_only_when_asked(self):
        settings = bs.load_settings(400)
        monolith, pcn = self.run_members(('M', settings, 'full', {'pg_sampler': True}), ('H3x2', settings, 'full', {'pg_sampler': True}), ('H3', bs.FULL, 'full', {}),
                                         ('H3b', bs.FULL, 'full', {'burst': bs.BURST_FULL}))
        self.assertEqual([s['stage'] for s in self.study.stages], ['full-0-400-M', 'full-1-400-H3x2', 'full-2-100-H3', 'full-3-100-H3b'])
        self.assertTrue(monolith.call_args.kwargs['pg_sampler'])
        self.assertEqual(monolith.call_args.kwargs['settings'], settings)
        self.assertEqual([(c.kwargs['pg_sampler'], c.kwargs['mode'], c.kwargs['settings']['users']) for c in pcn.call_args_list],
                         [(True, 'full', 400), (False, 'full', 100), (False, 'full', 100)])
        self.assertEqual(pcn.call_args_list[2].kwargs['burst'], bs.BURST_FULL)
        self.assertEqual(self.study.pcn_dirs if hasattr(self.study, 'pcn_dirs') else None, None)
        self.assertEqual(pcn.call_args_list[0].args[1], self.private / 'members' / 'full-1-400-H3x2')

    def test_only_a_burst_configuration_takes_a_burst_and_it_must_have_one(self):
        for configuration, options in (('H3', {'burst': bs.BURST_FULL}), ('M', {'burst': bs.BURST_FULL}), ('H3b', {}), ('H3bnw2', {'burst': None})):
            with self.assertRaisesRegex(ValueError, 'BRIDGE_BURST'):
                self.run_members((configuration, bs.FULL, 'full', options))
        self.assertEqual(self.study.stages, [])

    def test_the_study_uses_three_trees_builds_each_and_takes_the_modes_and_cuts_it_knows(self):
        self.assertEqual(self.study.trees, {name: self.root / name for name in ('M', 'H1', 'H3')})
        self.assertEqual((self.study.study_name, self.study.smoke_order, self.study.mode), (bs.VM2_STUDY, bs.VM2_SMOKE_ORDER, 'full'))
        self.assertEqual(self.study.h_root, self.root / 'H3')
        commands = []
        with patch.object(self.study, 'command', side_effect=lambda args, cwd=None, **kw: commands.append((args[:3], cwd.name))):
            self.study.build()
        self.assertEqual(commands, [(['npm', 'ci', '--no-audit'], 'M'), (['npm', 'run', 'build'], 'M'), (['npm', 'ci', '--no-audit'], 'H1'), (['npm', 'run', 'phase2:build'], 'H1'),
                                    (['npm', 'ci', '--no-audit'], 'H3'), (['npm', 'run', 'phase2:build'], 'H3')])
        with self.assertRaises(ValueError):
            bs.VmStudy2(self.root, self.private, self.private, 'r', mode='local', cuts=('x2-200',))
        with self.assertRaises(ValueError):
            bs.VmStudy2(self.root, self.private, self.private, 'r', mode='nope')
        self.assertEqual(bs.VmStudy2(self.root, self.private, self.private, 'r', mode='full', cuts=('burst-short',)).cuts, ('burst-short',))


class V2Files:
    """The files of one member directory as run_pcn writes them, for member_metrics(v2=...)."""

    SETTINGS = {'users': 2, 'seconds': 30, 'warmup': 2, 'spawn_rate': 10}

    def write(self, directory, config='H3', *, status='COMPLETE', error_rate=0.0, generator=0.4, burst=None, manifest=None, http=None, read_ms=None, seconds=200, resources=True,
              sampler=None, read_failed=None):
        d = Path(directory)
        plan = bs.VM2_CONFIGS[config]
        base = {'status': status, 'process_sample_errors': 0, 'configuration': 'M' if config == 'M' else 'O', 'failed_stage': 'load'}
        if config != 'M':
            base.update(core_replicas=plan['core'], clinic_replicas=plan['clinic'], notification_workers=plan['nw'], gateway_topology=plan['topology'],
                        gateway={'topology': plan['topology'], 'coreLayout': plan['layout'], 'dbPoolLimit': plan['pool'],
                                 'coreInstances': ['core'] if plan['core'] == 1 else ['core-0', 'core-1'], 'clinicUpstream': {'servers': plan['clinic']}},
                        outbox={'pending_before': {'core': 0, 'clinic': 0}, 'pending_after': {'core': 7, 'clinic': 0}})
        if sampler is not None:
            base.update(pg_sampler=True, pg_activity=sampler, pool_timeouts={'p2024_log_lines': 0, 'by_log': {}, 'http_503': 2})
        base.update(manifest or {})
        (d / 'manifest.json').write_text(json.dumps(base))
        (d / 'pcn-report.json').write_text(json.dumps({'raw_counts_match': True, 'success_rps': 90.0, 'load_status': 'PASS_IN_SCOPE'}))
        (d / 'load-final.json').write_text(json.dumps({'completed': True, 'observed_user_min': 2, 'error_rate': error_rate}))
        (d / 'reconciliation.json').write_text(json.dumps({'missing_success_ids': 0, 'duplicate_active_slots': 0, 'duplicate_response_ids': 0, 'unexpected_child_exit': False,
                                                           'writes_without_success_response': 0}))
        read_ms = read_ms or (lambda second: 100.0)
        rows = []
        for second in range(1, seconds + 1):
            rows.append({'started_seconds': float(second), 'name': 'GET pets', 'response_time_ms': read_ms(second), 'failed': bool(read_failed and read_failed(second)), 'response_bytes': 50})
            rows.append({'started_seconds': float(second), 'name': 'POST appointment', 'response_time_ms': 9000.0, 'failed': False, 'response_bytes': 50})
        (d / 'requests.jsonl').write_text('\n'.join(json.dumps(r) for r in rows) + '\n')
        if http is not False:
            (d / 'http-summary.json').write_text(json.dumps({'requests': 1000, 'failures': 0, 'statuses': {}, 'http_429': 0, 'http_503': 2, 'transport_errors': 0, **(http or {})}))
        if burst is not None:
            (d / 'burst.json').write_text(json.dumps(burst))
        if not resources:
            (d / 'resources.jsonl').write_text('')
        else:
            samples = []
            for t in range(60):
                for component, cpu in (('core', 40.0), ('clinic-0', 30.0), ('postgres', 100.0), ('generator', generator * 100), ('controller', 5.0)):
                    samples.append({'component': component, 'monotonic_s': float(t), 'cpu_percent_one_core': None if t == 0 else cpu, 'rss_bytes_sum': 2**20})
            (d / 'resources.jsonl').write_text('\n'.join(json.dumps(s) for s in samples) + '\n')
        return self.SETTINGS


class VmV2MemberMetrics(unittest.TestCase):
    def member(self, config='H3', *, v2=None, require_cpu=True, **kwargs):
        with tempfile.TemporaryDirectory() as directory:
            settings = V2Files().write(directory, config, **kwargs)
            v2 = {'config': config, 'errors_invalidate': True, 'burst': False, 'pg_sampler': False, **(v2 or {})}
            return bs.member_metrics(directory, settings, require_cpu=require_cpu, v2=v2)

    def test_v1_metrics_are_untouched_by_the_extension(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = V2Files().write(directory)
            plain = bs.member_metrics(directory, settings)
        for key in ('read_p95_ms', 'generator_cores', 'components', 'http', 'pool', 'burst', 'config', 'read_p95_segments'):
            self.assertNotIn(key, plain)
        extended = self.member()
        self.assertEqual({k: v for k, v in extended.items() if k in plain}, plain)

    def test_the_read_p95_counts_the_reads_only_and_is_cut_around_the_burst_second(self):
        m = self.member(read_ms=lambda second: 100.0 + (400.0 if 120 < second <= 180 else 0.0))
        self.assertEqual((m['valid'], m['reasons']), (True, []))
        self.assertEqual(m['read_requests'], 200)
        self.assertEqual(m['read_p95_ms'], 500.0)                       # the 9000 ms writes do not count
        self.assertEqual(m['p95_ms'], 9000.0)                           # the overall p95 does
        self.assertEqual(m['read_p95_segments'], {'before': {'n': 90, 'p95_ms': 100.0}, 'after': {'n': 60, 'p95_ms': 500.0}})   # [30,120) and (120,180]
        self.assertEqual(bs.read_ratio(m), 5.0)
        # A burst at another second moves both segments with it.
        m = self.member(v2={'burst_at': 60}, read_ms=lambda second: 100.0 + (400.0 if 60 < second <= 120 else 0.0))
        self.assertEqual(m['read_p95_segments'], {'before': {'n': 30, 'p95_ms': 100.0}, 'after': {'n': 60, 'p95_ms': 500.0}})
        # A window that is too short for the segments has none.
        short = self.member(seconds=20)
        self.assertEqual(short['read_p95_segments'], {'before': {'n': 0, 'p95_ms': None}, 'after': {'n': 0, 'p95_ms': None}})
        self.assertIsNone(bs.read_ratio(short))

    def test_the_read_p95_of_the_successful_reads_is_reported_next_to_the_one_of_all_reads(self):
        # The last 20 of 200 reads failed and were slow (1000 ms), the 180 that succeeded took 100 ms: the p95 of all reads is the failures', the one of the successful ones is not.
        m = self.member(read_ms=lambda second: 1000.0 if second > 180 else 100.0, read_failed=lambda second: second > 180)
        self.assertEqual((m['read_p95_ms'], m['read_p95_ok_ms']), (1000.0, 100.0))
        # A failed read can also be fast (a 429 or a 503 refused at once) and pull the p95 of all reads down: 100 fast failures (5 ms), and among the 100 that succeeded 90 took
        # 100 ms and 10 took 1000 ms. The slow ones are 5% of all reads (the p95 falls on a 100 ms one) and 10% of the successful ones (their p95 is 1000 ms).
        m = self.member(read_ms=lambda second: 1000.0 if 91 <= second <= 100 else 5.0 if second > 100 else 100.0, read_failed=lambda second: second > 100)
        self.assertEqual((m['read_p95_ms'], m['read_p95_ok_ms']), (100.0, 1000.0))
        # Nothing succeeded: no figure rather than a wrong one.
        m = self.member(read_failed=lambda second: True)
        self.assertEqual((m['read_p95_ms'], m['read_p95_ok_ms']), (100.0, None))

    def test_cpu_is_kept_per_process_and_per_group_and_the_generator_is_not_a_server(self):
        m = self.member('H3x2cl2')
        self.assertEqual(m['valid'], True, m['reasons'])
        self.assertEqual(sorted(m['components']), ['clinic-0', 'core', 'postgres'])   # no generator, no controller among the servers
        self.assertAlmostEqual(m['components']['core'], 0.4)
        self.assertAlmostEqual(m['components']['postgres'], 1.0)
        self.assertAlmostEqual(m['server_cores'], 0.4 + 0.3 + 1.0)
        self.assertAlmostEqual(m['generator_cores'], 0.4)
        self.assertEqual(sorted(m['groups']), ['clinic', 'core', 'postgres'])
        self.assertEqual(bs.component_groups({'core': 0.5, 'core-0': 0.2, 'core-1': 0.3, 'core-outbox': 0.1, 'clinic-0': 0.1, 'clinic-1': 0.2, 'clinic-worker': 0.05,
                                              'notification-worker': 0.1, 'notification-worker-1': 0.2, 'notification': 0.3, 'billing-worker': 0.01, 'postgres': 2.0, 'api': 1.0}),
                         {'core': 1.0, 'core-outbox': 0.1, 'clinic': 0.30000000000000004, 'clinic-worker': 0.05, 'notification_worker': 0.30000000000000004, 'notification': 0.3,
                          'billing-worker': 0.01, 'postgres': 2.0, 'api': 1.0})
        self.assertEqual([bs.component_group(n) for n in ('core', 'core-1', 'core-outbox', 'clinic-0', 'clinic-worker', 'notification-worker', 'notification-worker-0', 'notification')],
                         ['core', 'core', 'core-outbox', 'clinic', 'clinic-worker', 'notification_worker', 'notification_worker', 'notification'])

    def test_a_generator_above_0_80_core_makes_the_member_invalid_and_one_at_0_80_does_not(self):
        hot = self.member(generator=0.81)
        self.assertFalse(hot['valid'])
        self.assertEqual(hot['reasons'], ['generator above 0.80 core (0.81)'])
        self.assertTrue(self.member(generator=0.80)['valid'])
        self.assertTrue(self.member(generator=0.95, require_cpu=False)['valid'])   # the smoke has no steady part to read the generator in
        self.assertEqual(self.member(resources=False)['reasons'], ['no steady CPU samples', 'no generator CPU samples'])
        self.assertEqual((bs.GENERATOR_MAX, bs.GENERATOR_SHIFT), (0.80, 0.70))

    def test_429_and_503_come_from_the_http_summary_which_must_exist(self):
        m = self.member(http={'http_429': 25, 'http_503': 4})
        self.assertEqual((m['http']['rate_429'], m['http']['rate_503'], m['http']['requests']), (0.025, 0.004, 1000))
        self.assertTrue(m['valid'])   # a 429 rate is read by the step, not by the member
        self.assertFalse(bs.rate_429_ok([m]))
        self.assertTrue(bs.rate_429_ok([self.member(http={'http_429': 10})]))   # exactly 1% is not above 1%
        missing = self.member(http=False)
        self.assertEqual(missing['reasons'], ['http-summary.json missing'])
        self.assertIsNone(missing['http'])

    def test_errors_above_one_percent_invalidate_a_member_only_where_they_are_not_a_sign_of_saturation(self):
        self.assertEqual(self.member(error_rate=0.05)['reasons'], ['error rate above 1%'])
        saturated = self.member(error_rate=0.05, v2={'errors_invalidate': False})
        self.assertEqual((saturated['valid'], saturated['reasons'], saturated['error_rate']), (True, [], 0.05))

    def test_the_manifest_must_be_the_configuration_asked_for(self):
        for config, change, reason in (
                ('H3x2', {'core_replicas': 1}, "core replicas is 1, expected 2"),
                ('H3', {'clinic_replicas': 2}, 'clinic replicas is 2, expected 1'),
                ('H3bnw2', {'notification_workers': 1}, 'notification workers is 1, expected 2'),
                ('H3c', {'gateway_topology': 'direct'}, "gateway topology is 'direct', expected 'core-ingress'"),
                ('H3', {'gateway': {'topology': 'core-ingress', 'coreLayout': 'workers', 'dbPoolLimit': 4, 'coreInstances': ['core'], 'clinicUpstream': {'servers': 1}}},
                 "gateway.topology is 'core-ingress', expected 'direct'"),
                ('H1', {'gateway': {'topology': 'direct', 'coreLayout': 'workers', 'dbPoolLimit': 4, 'coreInstances': ['core'], 'clinicUpstream': {'servers': 1}}},
                 "gateway.coreLayout is 'workers', expected 'phase2'"),
                ('H3p8', {'gateway': {'topology': 'direct', 'coreLayout': 'workers', 'dbPoolLimit': 4, 'coreInstances': ['core'], 'clinicUpstream': {'servers': 1}}},
                 'gateway.dbPoolLimit is 4, expected 8'),
                ('H3x2', {'gateway': {'topology': 'direct', 'coreLayout': 'workers', 'dbPoolLimit': 4, 'coreInstances': ['core'], 'clinicUpstream': {'servers': 1}}},
                 'gateway core instances is 1, expected 2'),
                ('H3cl2', {'gateway': {'topology': 'direct', 'coreLayout': 'workers', 'dbPoolLimit': 4, 'coreInstances': ['core'], 'clinicUpstream': {'servers': 1}}},
                 'gateway clinic upstream servers is 1, expected 2'),
                ('H3', {'gateway': None}, 'manifest has no gateway block'),
                ('M', {'configuration': 'O'}, "manifest configuration is 'O', expected 'M'")):
            m = self.member(config, manifest=change, **({'burst': {'valid': True}} if 'bnw' in config else {}), v2={'burst': 'bnw' in config})
            self.assertFalse(m['valid'], (config, change))
            self.assertIn(reason, m['reasons'], (config, change))
        for config in bs.VM2_CONFIGS:
            burst = bool(bs.VM2_CONFIGS[config].get('burst'))
            m = self.member(config, **({'burst': {'valid': True}} if burst else {}), v2={'burst': burst})
            self.assertEqual((m['valid'], m['reasons']), (True, []), config)   # a manifest as run_pcn writes it for each configuration passes

    def test_the_sampler_pool_evidence_reads_the_api_processes_only_and_needs_a_complete_reading(self):
        activity = {'status': 'COMPLETE', 'samples': 900, 'applications': {
            'p8-core': {'at_pool_limit_share': 0.7, 'busy_max': 4}, 'p8-clinic-0': {'at_pool_limit_share': 0.2}, 'p8-notification': {'at_pool_limit_share': 0.0},
            'p8-core-outbox': {'at_pool_limit_share': 1.0}, 'p8-billing-worker': {'at_pool_limit_share': 1.0}, 'p8-clinic-worker': {'at_pool_limit_share': 1.0}}}
        m = self.member(v2={'pg_sampler': True}, sampler=activity)
        self.assertEqual(m['pool'], {'available': True, 'status': 'COMPLETE', 'at_pool_limit_share': {'p8-core': 0.7, 'p8-clinic-0': 0.2, 'p8-notification': 0.0},
                                     'p2024_log_lines': 0, 'http_503': 2})
        for status in ('EXITED_EARLY', 'NO_SAMPLES', 'NOT_STARTED'):
            m = self.member(v2={'pg_sampler': True}, sampler={**activity, 'status': status})
            self.assertEqual((m['valid'], m['pool']['available'], m['pool']['at_pool_limit_share']), (True, False, {}), status)   # not invalid: the load is fine, the pool reading is unknown
        self.assertEqual(self.member(v2={'pg_sampler': True})['reasons'], ['the pg_stat_activity sampler was asked for and the manifest does not record it'])
        self.assertEqual(self.member()['pool'], {'available': False, 'status': None, 'at_pool_limit_share': {}, 'p2024_log_lines': None, 'http_503': None})
        self.assertEqual(self.member()['outbox'], {'pending_before': {'core': 0, 'clinic': 0}, 'pending_after': {'core': 7, 'clinic': 0}})

    def test_a_burst_member_needs_a_valid_burst_json_and_a_member_without_a_burst_has_none(self):
        good = {'valid': True, 'status': 'COMPLETE', 'drain_s': 12.5, 'reasons': []}
        m = self.member('H3b', burst=good, v2={'burst': True})
        self.assertEqual((m['valid'], m['burst']['drain_s']), (True, 12.5))
        self.assertEqual(self.member('H3b', v2={'burst': True})['reasons'], ['burst.json missing'])
        bad = self.member('H3b', burst={'valid': False, 'status': 'COMPLETE', 'reasons': ['the dead-letter queue held up to 3 message(s)']}, v2={'burst': True})
        self.assertEqual(bad['reasons'], ['burst: the dead-letter queue held up to 3 message(s)'])
        self.assertEqual(self.member('H3b', burst={'valid': False, 'status': 'NOT_FIRED'}, v2={'burst': True})['reasons'], ['burst: NOT_FIRED'])
        self.assertEqual(self.member('H3', burst=good)['reasons'], ['burst.json present although no burst was asked for'])
        self.assertIsNone(self.member()['burst'])

    def test_a_member_that_did_not_complete_is_marked_failed_for_the_study_to_stop_on(self):
        failed = self.member(status='FAILED')
        self.assertEqual((failed['valid'], failed['failed']), (False, True))
        self.assertEqual(failed['reasons'], ['member FAILED at load'])
        with tempfile.TemporaryDirectory() as directory:
            settings = V2Files().write(directory, status='FAILED')
            self.assertNotIn('failed', bs.member_metrics(directory, settings))   # v1 reads it as before


def block_of(kind, users, order, **kwargs):
    return bs.block_spec(kind, users, order, **kwargs)


def point_of(**kwargs):
    """A config_point of two members with the same figures."""
    return bs.config_point([v2m(**kwargs), v2m(**kwargs)])


class VmV2Ratios(unittest.TestCase):
    TRUTH = {'M': 100.0, 'H1': 90.0, 'H3': 80.0, 'H3c': 70.0, 'H3x2': 120.0, 'H3p8': 85.0, 'H3cl2': 88.0, 'H3x2cl2': 150.0}

    def test_each_ratio_is_the_geometric_mean_of_the_forward_and_the_reverse_pair_in_every_block(self):
        for order in (bs.PART1_ORDER, bs.TIER_ORDER, bs.TOP_ORDER, bs.POOL_ORDER):
            for drift in (1.0, 1.07):
                members = []
                for position, config in enumerate(order):
                    # The true figures of a configuration are fixed numbers; only the drift moves them.
                    slow = drift ** position
                    members.append(v2m(config, rps=self.TRUTH[config] / slow, read=self.TRUTH[config] * slow, p95=self.TRUTH[config] * 2 * slow, cpu=self.TRUTH[config] * slow))
                for base in dict.fromkeys(order):
                    for other in dict.fromkeys(order):
                        if base == other:
                            continue
                        entry = bs.ratio_entry(members, order, base, other)
                        truth = self.TRUTH[other] / self.TRUTH[base]
                        self.assertTrue(entry['readable'])
                        for key in ('success_rps', 'read_p95_ms', 'p95_ms', 'cpu_ms_per_success'):
                            self.assertAlmostEqual(entry['ratios'][key], truth, places=9, msg=(order, drift, base, other, key))

    def test_the_read_p95_of_the_successful_reads_has_its_own_ratio_and_the_configuration_point_carries_it(self):
        self.assertIn('read_p95_ok_ms', bs.RATIO_KEYS)
        order = bs.TIER_ORDER
        members = [v2m(c, read=100.0, read_ok=40.0 if c == 'H3x2' else 80.0) for c in order]
        entry = bs.ratio_entry(members, order, 'H3', 'H3x2')
        self.assertAlmostEqual(entry['ratios']['read_p95_ok_ms'], 0.5)
        self.assertAlmostEqual(entry['ratios']['read_p95_ms'], 1.0)
        self.assertEqual(bs.config_point([v2m(read=100.0, read_ok=40.0), v2m(read=300.0, read_ok=60.0)])['read_p95_ok_ms'], 50.0)

    def test_a_ratio_names_its_pairs_and_reads_throughput_with_the_gain_bands_and_the_latencies_with_the_v1_bands(self):
        order = bs.TIER_ORDER
        members = [v2m(c, rps=r, read=p, p95=p * 2, cpu=10.0 * (1 + r / 1000)) for c, r, p in zip(order, (100.0, 100.0, 120.0, 130.0, 100.0, 100.0), (50.0, 100.0, 50.0, 50.0, 100.0, 50.0))]
        entry = bs.ratio_entry(members, order, 'H3', 'H3x2')
        self.assertEqual((entry['base'], entry['other'], entry['positions']), ('H3', 'H3x2', [[1, 2], [4, 3]]))
        self.assertEqual(entry['pair_ratios']['success_rps'], [1.2, 1.3])
        self.assertAlmostEqual(entry['ratios']['success_rps'], math.sqrt(1.2 * 1.3))
        self.assertEqual((entry['throughput_reading'], entry['read_p95_reading']), ('có lợi', 'H3x2 nhanh hơn'))
        self.assertEqual([bs.gain_reading(r) for r in (None, 0.89, 0.9, 1.0, 1.09, 1.1, 1.5)], ['không đọc được', 'hại', 'hại', 'không đổi', 'không đổi', 'có lợi', 'có lợi'])
        self.assertEqual(entry['cpu_per_success_reading'], band_of(entry['ratios']['cpu_ms_per_success'], 'H3x2'))

    def test_a_ratio_is_not_readable_when_a_member_of_a_pair_is_invalid_or_the_step_is_not(self):
        order = bs.TIER_ORDER
        members = [v2m(c) for c in order]
        members[2] = v2m('H3x2', valid=False)
        entry = bs.ratio_entry(members, order, 'H3', 'H3x2')
        self.assertEqual((entry['readable'], entry['ratios'], entry['reading']), (False, None, 'không đọc được'))
        self.assertTrue(bs.ratio_entry(members, order, 'M', 'H3')['readable'])   # a pair without the invalid member still reads
        self.assertFalse(bs.ratio_entry([v2m(c) for c in order], order, 'H3', 'H3x2', readable=False)['readable'])

    def test_part_1_ratios_carry_the_p95_of_every_operation_like_v1(self):
        order = bs.PART1_ORDER
        members = [v2m(c, p95=40.0 * (1 + position / 10)) for position, c in enumerate(order)]
        entry = bs.ratio_entry(members, order, 'M', 'H3', operations=True)
        self.assertEqual(sorted(entry['operations']), ['GET pets', 'POST appointment'])
        self.assertEqual(entry['operations']['GET pets']['p95_ms'], {'base': [40.0, 40.0 * 1.7], 'other': [40.0 * 1.2, 40.0 * 1.5]})
        self.assertEqual(len(entry['operations']['GET pets']['p95_pair_ratios']), 2)
        self.assertNotIn('operations', bs.ratio_entry(members, order, 'M', 'H3'))

    def test_the_429_rate_makes_a_step_not_readable_above_one_percent(self):
        self.assertTrue(bs.rate_429_ok([v2m(rate_429=0.01), v2m()]))
        self.assertFalse(bs.rate_429_ok([v2m(rate_429=0.011), v2m()]))
        self.assertEqual(bs.RATE_429_MAX, 0.01)


def band_of(ratio, subject):
    return bs.band(ratio, subject)


class VmV2Saturation(unittest.TestCase):
    def points(self, rows, users_by_level=None):
        """{users: {config: point}} from {users: {config: kwargs of v2m}}."""
        return {users: {config: point_of(config=config, **kwargs) for config, kwargs in configs.items()} for users, configs in rows.items()}

    def test_the_three_signs_throughput_below_1_5x_a_read_p95_above_750_ms_and_errors_above_1_percent(self):
        for kwargs, signs in (({'rps': 150.0}, []), ({'rps': 149.9}, ['throughput']), ({'rps': 200.0, 'read': 751.0}, ['read_p95']), ({'rps': 200.0, 'read': 750.0}, []),
                              ({'rps': 200.0, 'failures': 11}, ['errors']), ({'rps': 200.0, 'failures': 10}, []), ({'rps': 100.0, 'read': 900.0, 'failures': 50}, ['throughput', 'read_p95', 'errors'])):
            points = self.points({100: {'H3': {'rps': 100.0}}, 200: {'H3': kwargs}})
            series = bs.saturation(points, {100: True, 200: True})['configs']['H3']['series']
            entry = series[1]
            self.assertEqual((entry['readable'], entry.get('signs'), entry['saturated']), (True, signs, bool(signs)), kwargs)
        self.assertEqual((bs.SATURATION_GROWTH, bs.SATURATION_READ_P95_MS, bs.SATURATION_ERROR), (1.5, 750.0, 0.01))

    def test_the_read_sign_keeps_the_p95_of_all_reads_and_the_report_adds_the_one_of_the_successful_reads(self):
        points = self.points({100: {'H3': {'rps': 90.0}}, 200: {'H3': {'rps': 180.0, 'read': 751.0, 'read_ok': 100.0}}, 400: {'H3': {'rps': 360.0, 'read': 700.0, 'read_ok': 900.0}}})
        series = bs.saturation(points, {100: True, 200: True, 400: True})['configs']['H3']['series']
        self.assertEqual((series[1]['signs'], series[1]['read_p95_ms'], series[1]['read_p95_ok_ms']), (['read_p95'], 751.0, 100.0))   # the threshold is the p95 of all reads
        self.assertEqual((series[2]['signs'], series[2]['read_p95_ms'], series[2]['read_p95_ok_ms']), ([], 700.0, 900.0))             # a slow served read alone is not the sign

    def test_growth_is_compared_with_the_step_before_and_scaled_for_a_step_that_is_not_double(self):
        self.assertEqual(bs.required_growth(200, 100), 1.5)
        self.assertEqual(bs.required_growth(800, 400), 1.5)
        self.assertAlmostEqual(bs.required_growth(600, 400), 1.5 ** math.log2(1.5))
        self.assertAlmostEqual(bs.required_growth(600, 400), 1.268, places=3)
        points = self.points({400: {'H3': {'rps': 300.0}}, 600: {'H3': {'rps': 300.0 * 1.27}}, })
        series = bs.saturation(points, {400: True, 600: True})['configs']['H3']['series']
        self.assertEqual((series[1]['saturated'], series[1]['previous_users']), (False, 400))
        points = self.points({400: {'H3': {'rps': 300.0}}, 600: {'H3': {'rps': 300.0 * 1.26}}, })
        self.assertEqual(bs.saturation(points, {400: True, 600: True})['configs']['H3']['series'][1]['signs'], ['throughput'])

    def test_h3x2_has_no_100_user_step_so_its_first_step_has_no_growth_sign_and_the_next_compares_with_it(self):
        points = self.points({100: {'M': {'rps': 90.0}, 'H3': {'rps': 90.0}}, 200: {'M': {'rps': 180.0}, 'H3': {'rps': 180.0}, 'H3x2': {'rps': 100.0}},
                              400: {'M': {'rps': 360.0}, 'H3': {'rps': 250.0}, 'H3x2': {'rps': 360.0}}})
        report = bs.saturation(points, {100: True, 200: True, 400: True})['configs']
        first = report['H3x2']['series'][0]
        self.assertEqual((first['users'], first['previous_users'], first['growth'], first['signs'], first['saturated']), (200, None, None, [], False))   # 100 rps at 200 users is no sign: no step to compare
        self.assertEqual((report['H3x2']['series'][1]['growth'], report['H3x2']['series'][1]['saturated']), (3.6, False))
        self.assertEqual((report['M']['first_saturated_users'], report['H3']['first_saturated_users'], report['H3x2']['first_saturated_users']), (None, 400, None))
        self.assertEqual(report['H3']['series'][2]['growth'], 250.0 / 180.0)

    def test_a_step_that_cannot_be_read_says_so_and_leaves_the_next_without_a_growth_to_compare(self):
        points = self.points({100: {'H3': {'rps': 90.0}}, 200: {'H3': {'rps': 180.0, 'valid': False}}, 400: {'H3': {'rps': 200.0}}, 800: {'H3': {'rps': 200.0}}})
        report = bs.saturation(points, {100: True, 200: True, 400: True, 800: True})['configs']['H3']
        self.assertEqual(report['series'][1], {'users': 200, 'readable': False, 'saturated': None, 'reading': 'không đọc được'})
        self.assertEqual((report['series'][2]['growth'], report['series'][2]['saturated']), (None, False))   # 200 -> 400 has no readable 200
        self.assertEqual((report['series'][3]['signs'], report['first_saturated_users']), (['throughput'], 800))
        # 429 above 1% in a step: the whole step is not readable, whatever its members are.
        points = self.points({100: {'H3': {'rps': 90.0}}, 200: {'H3': {'rps': 90.0}}})
        report = bs.saturation(points, {100: True, 200: False})['configs']['H3']
        self.assertEqual((report['series'][1]['readable'], report['first_saturated_users']), (False, None))

    def test_the_first_process_to_use_0_85_core_says_whether_core_or_clinic_saturates_first(self):
        hot_core = {'core': 0.9, 'clinic-0': 0.3, 'postgres': 1.0}
        hot_both = {'core': 0.95, 'clinic-0': 0.88, 'postgres': 1.5}
        cool = {'core': 0.4, 'clinic-0': 0.2, 'postgres': 0.5}
        for rows, expected in (({100: cool, 200: hot_core, 400: hot_both}, ({'core': 200, 'clinic': 400}, 'core')),
                               ({100: cool, 200: cool, 400: hot_both}, ({'core': 400, 'clinic': 400}, 'cùng bậc: clinic, core')),
                               ({100: cool, 200: {'core': 0.3, 'clinic-0': 0.86, 'postgres': 1.0}, 400: hot_both}, ({'clinic': 200, 'core': 400}, 'clinic')),
                               ({100: cool, 200: cool}, ({}, None))):
            points = self.points({users: {'H3': {'rps': 100.0 * users / 100, 'components': components}} for users, components in rows.items()})
            first = bs.saturation(points, {users: True for users in rows})['first_hot']
            self.assertEqual((first['users_by_group'], first['first']), expected)
        self.assertEqual(point_of(components={'core': 0.85, 'clinic-0': 0.8499, 'core-outbox': 0.99, 'postgres': 3.0})['hot'], ['core'])   # 0.85 counts; workers and Postgres are not API processes


class VmV2Bottleneck(unittest.TestCase):
    def test_pool_when_a_process_has_its_whole_pool_busy_in_half_the_samples_or_a_p2024_was_logged(self):
        pool = lambda **kw: bs.bottleneck(point_of(**kw))
        self.assertEqual(pool(shares={'p8-core': 0.5, 'p8-clinic-0': 0.1})['pool'], True)
        self.assertEqual(pool(shares={'p8-core': 0.49})['pool'], False)
        self.assertEqual(pool(shares={'p8-core': 0.1}, p2024=1)['pool'], True)
        self.assertEqual(pool(available=False)['pool'], None)                      # no sampler reading and no P2024: unknown
        self.assertEqual(pool(available=False, p2024=2)['pool'], True)             # P2024 is a lower bound that stands alone
        self.assertEqual(bs.pool_point([v2m(shares={'p8-core': 0.7}), v2m(shares={'p8-core': 0.3})])['share_max'], 0.5)   # the mean over the members: half of all the samples
        self.assertEqual(bs.pool_point([v2m(shares={'p8-core': 0.7}), v2m(shares={'p8-core': 0.3}, p2024=3, http_503=5)])['p2024_log_lines'], 3)
        self.assertEqual(bs.pool_point([v2m(shares={'p8-core': 0.7}), v2m(available=False)])['available'], False)

    def test_m_has_no_pool_limit_to_compare_with_so_its_pool_is_not_readable_and_never_not_pool_or_cpu(self):
        # M: the sampler read (available) but m-api has no pool_limit, so there is no share: unknown, not False.
        m_point = point_of(config='M', components={'api': 0.5, 'postgres': 2.0}, shares={}, available=True)
        self.assertEqual((m_point['pool']['available'], m_point['pool']['share_max'], m_point['pool']['bound']), (True, None, None))
        verdict = bs.bottleneck(m_point)
        self.assertIsNone(verdict['pool'])
        self.assertTrue(verdict['label'].startswith('không đọc được'))
        self.assertIn('M dùng pool mặc định của Prisma', verdict['label'])
        self.assertNotIn('không phải pool hay CPU', verdict['label'])
        # A hot m-api is CPU; a P2024 or a share still decide for the processes that have a limit.
        self.assertEqual(bs.bottleneck(point_of(config='M', components={'api': 0.9, 'postgres': 2.0}, shares={}, available=True))['label'], 'CPU')
        self.assertEqual(bs.bottleneck(point_of(config='M', components={'api': 0.5}, shares={}, available=True, p2024=1))['pool'], True)
        # H3 with the sampler and a share below half is still "not pool"; with no share at all (no p8- connection read) it is unknown too.
        self.assertEqual(bs.bottleneck(point_of(shares={'p8-core': 0.2}, available=True))['pool'], False)
        self.assertIsNone(bs.bottleneck(point_of(shares={}, available=True))['pool'])
        # The step of M in the saturation report says so too, and the pool block is never triggered by it.
        points = {100: {'M': point_of(config='M', rps=90.0, shares={}, available=True)}, 200: {'M': point_of(config='M', rps=100.0, shares={}, available=True)}}
        entry = bs.saturation(points, {100: True, 200: True})['configs']['M']['series'][1]
        self.assertEqual((entry['saturated'], entry['bottleneck']['pool']), (True, None))
        self.assertNotIn('không phải pool hay CPU', entry['bottleneck']['label'])

    def test_cpu_when_a_node_api_process_uses_0_85_core_and_the_label_tells_which(self):
        hot, cool = {'core': 0.9, 'postgres': 2.0}, {'core': 0.5, 'postgres': 2.0}
        full = {'p8-core': 0.9}
        self.assertEqual(bs.bottleneck(point_of(components=hot, shares={'p8-core': 0.1}))['label'], 'CPU')
        self.assertEqual(bs.bottleneck(point_of(components=cool, shares=full))['label'], 'pool')
        self.assertEqual(bs.bottleneck(point_of(components=hot, shares=full))['label'], 'pool + CPU')
        self.assertTrue(bs.bottleneck(point_of(components=cool, shares={'p8-core': 0.1}))['label'].startswith('không phải pool hay CPU của Node'))
        self.assertTrue(bs.bottleneck(point_of(components=cool, available=False))['label'].startswith('không đọc được'))
        self.assertEqual(bs.bottleneck(point_of(components=hot, shares={'p8-core': 0.1}))['hot'], ['core'])

    def test_the_busier_of_two_instances_is_flagged_when_it_uses_more_than_20_percent_more_cpu(self):
        flags = bs.balance_flags(point_of(components={'core-0': 0.6, 'core-1': 0.5, 'clinic-0': 0.2, 'clinic-1': 0.3, 'postgres': 2.0}))
        self.assertEqual((flags['core']['instances'], flags['core']['uneven']), (2, False))        # 0.6 / 0.5 = 1.20: not above 20%
        self.assertEqual((flags['clinic']['instances'], flags['clinic']['uneven']), (2, True))      # 0.3 / 0.2 = 1.5
        self.assertAlmostEqual(flags['clinic']['busy_over_idle'], 1.5)
        self.assertTrue(bs.balance_flags(point_of(components={'core-0': 0.61, 'core-1': 0.5}))['core']['uneven'])
        self.assertEqual(bs.balance_flags(point_of(components={'core': 0.6, 'clinic-0': 0.3, 'postgres': 1.0})), {})   # one instance has nothing to balance
        self.assertEqual(bs.balance_flags(point_of(components={'core-0': 0.0, 'core-1': 0.0})), {})
        self.assertEqual(bs.IMBALANCE, 0.20)


class VmV2PoolTrigger(unittest.TestCase):
    def records(self, **world):
        blocks = [block_of('part1', 100, bs.PART1_ORDER, errors_invalidate=True), block_of('tier', 200, bs.TIER_ORDER, pg_sampler=True),
                  block_of('tier', 400, bs.TIER_ORDER, pg_sampler=True)]
        return records_of(World(**world), blocks)

    def test_the_block_runs_at_the_first_readable_step_where_h3_is_saturated_and_its_pool_is_full(self):
        records = self.records(pool_full=('H3',))
        self.assertIsNone(bs.pool_trigger(records, 200))     # 180 requests per second at 200 users: below capacity, not saturated
        self.assertEqual(bs.pool_trigger(records, 400), 400)  # 300 of 360 asked: at capacity, read p95 900 ms, pool 80% full

    def test_not_when_the_pool_is_not_full_or_the_step_is_not_readable_or_h3_is_not_saturated(self):
        self.assertIsNone(bs.pool_trigger(self.records(), 400))                                          # saturated, pool idle: CPU, not the pool
        self.assertIsNone(bs.pool_trigger(self.records(pool_full=('H3',), rate_429={('H3', 400): 0.05}), 400))   # a 429 rate of 5% makes the step unreadable
        self.assertIsNone(bs.pool_trigger(self.records(pool_full=('H3',), capacity={'H3': 5000.0}), 400))  # far from saturation
        self.assertIsNone(bs.pool_trigger(self.records(pool_full=('H3',)), 800))                          # no such step yet

    def test_an_unreadable_part_1_does_not_hide_a_pool_saturation_it_only_removes_the_growth_sign(self):
        records = self.records(pool_full=('H3',))
        for record in records:
            if record['block'] == 'part1':
                record['metrics'] = {**record['metrics'], 'valid': False}
        self.assertEqual(bs.pool_trigger(records, 400), 400)   # the read p95 and the pool still read at 400 (200 -> 400 grew by 1.67x)


class VmV2ScaleOut(unittest.TestCase):
    """The conclusions of the highest step (AC, A, B, C, G, then D, E, F) from the throughput of the five configurations, in the order of the rule: AC (Core and Clinic both
    help), C (Clinic helps), B / A (Core helps, with or without Clinic helping after it), G (only the combination helps), then F, D, E when nothing helps. `harmful` is a side flag."""
    CALM = {'core': 0.4, 'clinic-0': 0.2, 'postgres': 0.8}

    def conclusion(self, rps, components=None, server_cpus=7, order=bs.TOP_ORDER, saturated=None):
        components = components or {}
        members = [v2m(c, rps=rps[c], components=components.get(c, self.CALM), cores=sum(components.get(c, {'x': 2.0}).values())) for c in order]
        entries = {label: bs.ratio_entry(members, order, base, other) for label, base, other in bs.SCALE_OUT_COMPARISONS}
        points = {c: bs.config_point([m for m, cfg in zip(members, order) if cfg == c]) for c in dict.fromkeys(order)}
        return bs.scale_out_conclusion(entries, points, server_cpus, saturated)

    def throughput(self, c=1.0, x=1.0, xc=1.0):
        """Throughput of the five configurations from the ratios to H3 (300 requests per second): H3cl2/H3 = c, H3x2/H3 = x, H3x2cl2/H3 = xc."""
        return {'M': 500.0, 'H3': 300.0, 'H3cl2': 300.0 * c, 'H3x2': 300.0 * x, 'H3x2cl2': 300.0 * xc}

    def test_a_core_is_the_bottleneck_and_clinic_does_not_help(self):
        got = self.conclusion({'M': 500.0, 'H3': 300.0, 'H3cl2': 300.0, 'H3x2': 420.0, 'H3x2cl2': 430.0})
        self.assertEqual(got['code'], 'A')
        self.assertIn('Core là nút cổ chai', got['reading'])
        self.assertEqual(sorted(got['ratios']), sorted(bs.SCALE_OUT_LABELS))
        self.assertAlmostEqual(got['ratios']['H3x2/H3'], 1.4)
        self.assertEqual(got['harmful'], [])

    def test_a_with_a_harmful_ratio_keeps_the_conclusion_and_flags_the_ratio(self):
        # The case the review tried: x = 1.40, H3x2cl2/H3 = 1.30, H3x2cl2/H3cl2 = 1.48, c = 0.88. Core helps, H3x2cl2/H3x2 = 0.93 does not: A, and F is a flag.
        got = self.conclusion(self.throughput(c=0.88, x=1.40, xc=1.30))
        self.assertEqual(got['code'], 'A')
        self.assertEqual(got['harmful'], ['H3cl2/H3'])
        self.assertAlmostEqual(got['ratios']['H3x2cl2/H3cl2'], 1.30 / 0.88)
        self.assertAlmostEqual(got['ratios']['H3x2cl2/H3x2'], 1.30 / 1.40)
        # The flag does not change B or C either.
        got = self.conclusion(self.throughput(c=1.0, x=1.30, xc=1.50))
        self.assertEqual((got['code'], got['harmful']), ('B', []))
        got = self.conclusion(self.throughput(c=1.5, x=0.9, xc=1.6))
        self.assertEqual((got['code'], got['harmful']), ('C', ['H3x2/H3']))

    def test_ac_core_and_clinic_both_help(self):
        got = self.conclusion(self.throughput(c=1.11, x=1.50, xc=1.60))
        self.assertEqual((got['code'], got['harmful']), ('AC', []))
        self.assertIn('Nhân Core và nhân Clinic đều có lợi', got['reading'])
        self.assertEqual(self.conclusion(self.throughput(c=1.10, x=1.10, xc=1.2))['code'], 'AC')   # the bands are closed at 1.1
        # c alone is not enough, and neither is x alone: those are C and A (B when Clinic helps once Core is doubled).
        self.assertEqual(self.conclusion(self.throughput(c=1.11, x=1.09, xc=1.2))['code'], 'C')
        self.assertEqual(self.conclusion(self.throughput(c=1.09, x=1.50, xc=1.60))['code'], 'A')   # H3x2cl2/H3x2 = 1.07 is below the band
        self.assertEqual(self.conclusion(self.throughput(c=1.09, x=1.50, xc=1.70))['code'], 'B')   # 1.13

    def test_b_core_helps_and_then_clinic_is_the_next_bottleneck(self):
        got = self.conclusion({'M': 500.0, 'H3': 300.0, 'H3cl2': 305.0, 'H3x2': 400.0, 'H3x2cl2': 480.0})
        self.assertEqual((got['code'], round(got['ratios']['H3x2cl2/H3x2'], 2)), ('B', 1.2))
        self.assertIn('nhân thêm Clinic còn có lợi', got['reading'])
        # B needs Core to help first: Clinic helping once Core is doubled while Core alone does not is G, not B.
        self.assertEqual(self.conclusion(self.throughput(c=1.0, x=1.0, xc=1.2))['code'], 'G')

    def test_c_clinic_is_hot_first(self):
        got = self.conclusion({'M': 500.0, 'H3': 300.0, 'H3cl2': 345.0, 'H3x2': 300.0, 'H3x2cl2': 350.0})
        self.assertEqual(got['code'], 'C')
        self.assertEqual(self.conclusion({'M': 500.0, 'H3': 300.0, 'H3cl2': 345.0, 'H3x2': 400.0, 'H3x2cl2': 500.0})['code'], 'AC')   # both help: not C any more

    def test_g_only_the_combination_helps_and_two_small_gains_are_not_a_combination(self):
        # Neither doubling reaches 1.1 (1.03 each); both together beat each of them by 1.12: only the combination helps.
        got = self.conclusion({'M': 500.0, 'H3': 300.0, 'H3cl2': 309.0, 'H3x2': 309.0, 'H3x2cl2': 345.0})
        self.assertEqual(got['code'], 'G')
        self.assertIn('Chỉ nhân gộp có lợi', got['reading'])
        # Clinic helps only when Core is doubled (H3x2cl2/H3x2 = 1.12, H3x2cl2/H3cl2 = 1.09): still G.
        self.assertEqual(self.conclusion({'M': 500.0, 'H3': 300.0, 'H3cl2': 312.0, 'H3x2': 303.0, 'H3x2cl2': 340.0})['code'], 'G')
        # H3x2cl2/H3cl2 = 1.11 alone is not G: H3cl2 is the one that got worse (0.90) and the combination does not beat H3 (1.00): F.
        rps = {'M': 500.0, 'H3': 300.0, 'H3cl2': 270.0, 'H3x2': 300.0, 'H3x2cl2': 300.0}
        got = self.conclusion(rps, saturated=False)
        self.assertEqual((got['code'], round(got['ratios']['H3x2cl2/H3cl2'], 2)), ('F', 1.11))
        # 336 / 309 = 1.087: under the band, so the old reading (B, from H3x2cl2/H3 = 1.12) is gone.
        self.assertNotEqual(self.conclusion({'M': 500.0, 'H3': 300.0, 'H3cl2': 309.0, 'H3x2': 309.0, 'H3x2cl2': 336.0}, saturated=False)['code'], 'B')

    def test_two_gains_below_the_band_do_not_compound_into_b_the_case_the_review_tried(self):
        # x = 1.08, H3x2cl2/H3x2 = 1.05 (H3x2cl2/H3 = 1.134, which the old rule read as B), c = 1.04, H3x2cl2/H3cl2 = 1.09.
        rps = {'M': 500.0, 'H3': 300.0, 'H3cl2': 312.0, 'H3x2': 324.0, 'H3x2cl2': 340.2}
        for saturated, expected in ((False, 'D'), (True, 'E'), (None, 'E')):
            got = self.conclusion(rps, saturated=saturated)
            self.assertEqual(got['code'], expected, saturated)
            self.assertNotIn(got['code'], ('A', 'B', 'C', 'AC', 'G'))
        self.assertAlmostEqual(self.conclusion(rps)['ratios']['H3x2cl2/H3'], 1.134)   # reported, not a reason

    def test_f_an_extra_instance_costs_more_than_it_earns_when_nothing_helps(self):
        for rps in ({'H3cl2': 270.0, 'H3x2': 300.0, 'H3x2cl2': 300.0}, {'H3cl2': 300.0, 'H3x2': 270.0, 'H3x2cl2': 300.0}, {'H3cl2': 300.0, 'H3x2': 300.0, 'H3x2cl2': 260.0}):
            got = self.conclusion({'M': 500.0, 'H3': 300.0, **rps}, saturated=False)
            self.assertEqual(got['code'], 'F', rps)
            self.assertTrue(got['harmful'], rps)
        got = self.conclusion({'M': 500.0, 'H3': 300.0, 'H3cl2': 270.0, 'H3x2': 300.0, 'H3x2cl2': 300.0}, saturated=False)
        self.assertEqual(got['harmful'], ['H3cl2/H3'])
        self.assertIn('Có tỷ lệ ≤ 0,9', got['reading'])
        self.assertEqual(self.conclusion({'M': 500.0, 'H3': 300.0, 'H3cl2': 270.1, 'H3x2': 300.0, 'H3x2cl2': 290.0}, saturated=False)['code'], 'D')   # 0.9003 is within the band

    def test_d_nothing_moves_the_cpu_is_low_and_h3_is_not_saturated(self):
        flat = self.throughput(c=1.01, x=1.01, xc=1.02)
        got = self.conclusion(flat, saturated=False)
        self.assertEqual((got['code'], got['harmful'], got['h3_saturated']), ('D', [], False))
        self.assertIn('chưa bão hòa', bs.SCALE_OUT_READINGS['D'])
        self.assertEqual(sorted(got['hot_processes']), ['H3', 'H3cl2', 'H3x2', 'H3x2cl2'])   # the H3 configurations only
        self.assertTrue(all(not hot for hot in got['hot_processes'].values()))

    def test_e_is_everything_else_a_saturated_h3_a_hot_api_or_an_unknown(self):
        flat = self.throughput(c=1.01, x=1.01, xc=1.02)
        for label, saturated in (('H3 saturated at this step', True), ('not known', None)):
            got = self.conclusion(flat, saturated=saturated)
            self.assertEqual(got['code'], 'E', label)
            self.assertIn('giới hạn nằm ngoài số instance (máy, DB hoặc chưa xác định)', got['reading'])
        # The case the review tried: every ratio about 1 and Core at 0.95 core is not D, even when H3 is not saturated.
        hot = {**{c: self.CALM for c in flat}, 'H3': {'core': 0.95, 'clinic-0': 0.2, 'postgres': 0.8}}
        got = self.conclusion(flat, hot, saturated=False)
        self.assertEqual((got['code'], got['hot_processes']['H3']), ('E', ['core']))
        # The machine itself nearly full (6.1 of 7 cores) in one H3 configuration is not D either.
        full = {**{c: self.CALM for c in flat}, 'H3x2cl2': {'core-0': 0.8, 'core-1': 0.8, 'clinic-0': 0.8, 'clinic-1': 0.8, 'postgres': 2.9}}
        got = self.conclusion(flat, full, saturated=False)
        self.assertEqual((got['code'], got['machine_or_database_busy']), ('E', ['H3x2cl2']))

    def test_postgres_at_half_the_cpus_is_information_and_no_longer_a_reason_for_e(self):
        flat = self.throughput(c=1.01, x=1.01, xc=1.02)
        hot_db = {**{c: self.CALM for c in flat}, 'H3': {'core': 0.5, 'clinic-0': 0.3, 'postgres': 3.5}}
        got = self.conclusion(flat, hot_db, saturated=False)
        self.assertEqual((got['code'], got['machine_or_database_busy']), ('D', ['H3']))   # reported, decides nothing
        self.assertEqual(self.conclusion(flat, hot_db, server_cpus=8, saturated=False)['machine_or_database_busy'], [])

    def test_hot_and_busy_are_read_in_the_h3_configurations_only_never_in_m(self):
        flat = self.throughput(c=1.01, x=1.01, xc=1.02)
        components = {**{c: self.CALM for c in flat}, 'M': {'api': 0.97, 'postgres': 4.0}}   # M at 4.97 of 7 cores, its API above 0.85
        got = self.conclusion(flat, components, saturated=False)
        self.assertEqual(got['code'], 'D')
        self.assertNotIn('M', got['hot_processes'])
        self.assertNotIn('M', got['machine_or_database_busy'])

    def test_the_conclusion_is_not_readable_without_the_five_ratios_and_every_code_has_a_text(self):
        order = bs.TOP_ORDER
        members = [v2m(c, valid=c != 'H3cl2') for c in order]
        entries = {label: bs.ratio_entry(members, order, base, other) for label, base, other in bs.SCALE_OUT_COMPARISONS}
        got = bs.scale_out_conclusion(entries, {}, 7)
        self.assertEqual((got['code'], got['reading']), (None, 'không đọc được'))
        self.assertEqual(sorted(bs.SCALE_OUT_READINGS), sorted(['AC', 'A', 'B', 'C', 'D', 'E', 'F', 'G']))
        self.assertTrue(all(text for text in bs.SCALE_OUT_READINGS.values()))

    def test_saturated_at_reads_the_step_of_the_block_and_nothing_else(self):
        report = {'configs': {'H3': {'series': [{'users': 400, 'saturated': False}, {'users': 800, 'saturated': True}, {'users': 600, 'readable': False, 'saturated': None}]}}}
        self.assertEqual((bs.saturated_at(report, 'H3', 400), bs.saturated_at(report, 'H3', 800), bs.saturated_at(report, 'H3', 600)), (False, True, None))
        self.assertIsNone(bs.saturated_at(report, 'H3', 200))
        self.assertIsNone(bs.saturated_at(report, 'M', 800))
        self.assertIsNone(bs.saturated_at(None, 'H3', 800))

    def test_the_block_reports_the_scale_out_with_the_balance_flags_and_the_control_ratio(self):
        world = World(capacity={'M': 700.0, 'H3': 300.0, 'H3x2': 520.0, 'H3cl2': 300.0, 'H3x2cl2': 520.0})
        analysis = bs.analyze_v2(records_of(world, [block_of('tier', 800, bs.TOP_ORDER, pg_sampler=True)]))
        scale = analysis['scale_out']
        self.assertEqual((scale['block'], scale['code']), ('tier-800', 'A'))
        block = analysis['blocks']['tier-800']
        self.assertEqual(list(block['comparisons']), ['H3cl2/H3', 'H3x2/H3', 'H3x2cl2/H3x2', 'H3x2cl2/H3cl2', 'H3x2cl2/H3', 'H3/M'])
        self.assertEqual(block['comparisons']['H3/M']['base'], 'M')
        self.assertEqual(sorted(block['balance']['H3x2']), ['core'])   # two Core instances: core-0 and core-1; one Clinic has nothing to balance
        self.assertEqual(sorted(block['balance']['H3x2cl2']), ['clinic', 'core'])
        self.assertFalse(block['balance']['H3x2']['core']['uneven'])
        self.assertEqual(block['configs']['H3x2cl2']['members'], 2)


def burst_member(config, drain, relay=4.0, before=50.0, after=50.0, background=(100.0, 100.0), **kwargs):
    """A burst member: drain and relay drain in seconds, the read p95 before and after the burst second, the p95 latency of the background notifications before and during."""
    burst = {'valid': True, 'status': 'COMPLETE', 'drain_s': drain, 'relay_drain_s': relay, 'latency_ms': {'p95_ms': (drain or 0) * 1000},
             'background_latency_ms': {'before': {'p95_ms': background[0]}, 'during': {'p95_ms': background[1]}, 'after': {'p95_ms': background[0]}}}
    return v2m(config, burst=burst, segments={'before': {'n': 90, 'p95_ms': before}, 'after': {'n': 60, 'p95_ms': after}}, **kwargs)


class VmV2Burst(unittest.TestCase):
    order = bs.BURST_ORDER
    control = [v2m('H3', segments={'before': {'n': 90, 'p95_ms': 50.0}, 'after': {'n': 60, 'p95_ms': 50.0}}) for _ in range(2)]

    def analyze(self, members, control=None):
        return bs.analyze_burst(members, self.order, self.control if control is None else control)

    def test_the_drain_ratio_is_the_geometric_mean_of_the_forward_and_the_reverse_pair_and_efficiency_is_one_over_twice_it(self):
        # nw1 drains in 20 s and 24 s (the host slowed by 1.2 between positions), nw2 in 10 s and 14.4 s: ratios 0.5 and 0.6.
        members = [burst_member('H3b', 20.0), burst_member('H3bnw2', 10.0), burst_member('H3bnw2', 14.4), burst_member('H3b', 24.0)]
        result = self.analyze(members)
        self.assertTrue(result['readable'])
        self.assertEqual(result['drain']['comparison'], 'H3bnw2/H3b')
        self.assertEqual(result['drain']['pair_ratios'], [0.5, 0.6])
        self.assertAlmostEqual(result['drain']['ratio'], math.sqrt(0.3))
        self.assertAlmostEqual(result['drain']['efficiency'], 1 / (2 * math.sqrt(0.3)))
        self.assertEqual(result['drain']['reading'], '2 worker xả gần gấp đôi')
        self.assertEqual(result['configs']['H3b']['drain_s'], [20.0, 24.0])
        self.assertEqual(result['configs']['H3bnw2']['drain_s'], [10.0, 14.4])

    def test_the_reading_of_the_drain_ratio_has_four_bands_and_names_the_next_stage(self):
        self.assertEqual(bs.drain_reading(None, 0.5), 'không đọc được')
        self.assertEqual(bs.drain_reading(0.6, 0.5), '2 worker xả gần gấp đôi')
        self.assertEqual(bs.drain_reading(0.61, 0.5), '2 worker xả nhanh hơn nhưng không tuyến tính: nút kế là relay hoặc Postgres')
        self.assertEqual(bs.drain_reading(0.89, 0.5), '2 worker xả nhanh hơn nhưng không tuyến tính: nút kế là relay hoặc Postgres')
        self.assertTrue(bs.drain_reading(0.9, 0.95).startswith('nút ở relay (relay drain ≈ drain)'))
        self.assertTrue(bs.drain_reading(1.1, 0.9).startswith('nút ở relay'))
        self.assertTrue(bs.drain_reading(1.0, 0.5).startswith('nút ở commit Postgres'))
        self.assertTrue(bs.drain_reading(1.0, None).startswith('nút ở commit Postgres'))
        self.assertEqual(bs.drain_reading(1.2, 0.9), '2 worker xả chậm hơn 1 worker: bất thường')
        members = [burst_member('H3b', 20.0, relay=19.0), burst_member('H3bnw2', 20.0, relay=19.0), burst_member('H3bnw2', 20.0, relay=19.0), burst_member('H3b', 20.0, relay=19.0)]
        result = self.analyze(members)
        self.assertEqual(result['drain']['ratio'], 1.0)
        self.assertEqual(result['drain']['efficiency'], 0.5)
        self.assertAlmostEqual(result['drain']['relay_share_of_drain'], 0.95)
        self.assertTrue(result['drain']['reading'].startswith('nút ở relay'))

    def test_a_burst_that_did_not_drain_or_a_member_that_is_invalid_has_no_drain_time(self):
        members = [burst_member('H3b', 20.0), burst_member('H3bnw2', None), burst_member('H3bnw2', 10.0), burst_member('H3b', 20.0)]
        result = self.analyze(members)
        self.assertEqual((result['readable'], result['drain']['ratio'], result['drain']['reading'], result['drain']['efficiency']), (True, None, 'không đọc được', None))
        members = [burst_member('H3b', 20.0), burst_member('H3bnw2', 10.0, valid=False), burst_member('H3bnw2', 10.0), burst_member('H3b', 20.0)]
        result = self.analyze(members)
        self.assertEqual((result['readable'], result['drain']['ratio'], result['disturbance']['I']), (False, None, {'H3b': None, 'H3bnw2': None}))

    def test_the_effect_on_the_load_is_the_read_ratio_over_that_of_h3_in_part_1_per_configuration_and_nw2_over_nw1(self):
        # Without a burst H3 of Part 1 reads 50 ms both before and after (ratio 1). With one the reads after are 55 ms (nw1) and 75 ms (nw2): I = 1.1 and 1.5.
        members = [burst_member('H3b', 20.0, after=55.0), burst_member('H3bnw2', 10.0, after=75.0), burst_member('H3bnw2', 10.0, after=75.0), burst_member('H3b', 20.0, after=55.0)]
        result = self.analyze(members)
        disturbance = result['disturbance']
        self.assertEqual(disturbance['control_read_ratio'], 1.0)
        self.assertAlmostEqual(disturbance['I']['H3b'], 1.1)
        self.assertAlmostEqual(disturbance['I']['H3bnw2'], 1.5)
        self.assertAlmostEqual(disturbance['I_nw2_over_nw1'], 1.5 / 1.1)
        self.assertEqual(result['configs']['H3b']['I_reading'], 'đột biến làm chậm tải nền 10% (p95 đọc)')
        self.assertEqual(result['configs']['H3bnw2']['I_reading'], 'đột biến làm chậm tải nền 50% (p95 đọc)')
        # A control that reads slower after the second 120 anyway (1.2x: the load alone) takes that out of I.
        control = [v2m('H3', segments={'before': {'n': 90, 'p95_ms': 50.0}, 'after': {'n': 60, 'p95_ms': 60.0}}), v2m('H3', segments={'before': {'n': 90, 'p95_ms': 50.0}, 'after': {'n': 60, 'p95_ms': 60.0}})]
        result = self.analyze(members, control)
        self.assertAlmostEqual(result['disturbance']['control_read_ratio'], 1.2)
        self.assertAlmostEqual(result['disturbance']['I']['H3b'], 1.1 / 1.2)
        self.assertEqual(result['configs']['H3b']['I_reading'], 'Notification hấp thụ đột biến: p95 đọc của tải nền không đổi')

    def test_the_reading_of_I_has_three_bands(self):
        self.assertEqual(bs.disturbance_reading(None), 'không đọc được')
        self.assertEqual(bs.disturbance_reading(0.95), 'Notification hấp thụ đột biến: p95 đọc của tải nền không đổi')
        self.assertEqual(bs.disturbance_reading(1.09), 'Notification hấp thụ đột biến: p95 đọc của tải nền không đổi')
        self.assertEqual(bs.disturbance_reading(1.1), 'đột biến làm chậm tải nền 10% (p95 đọc)')
        self.assertEqual(bs.disturbance_reading(0.9), 'đột biến không làm chậm tải nền')
        self.assertEqual(bs.read_ratio(v2m()), 1.0)
        self.assertIsNone(bs.read_ratio(v2m(segments={'before': {'n': 0, 'p95_ms': None}, 'after': {'n': 60, 'p95_ms': 5.0}})))
        self.assertIsNone(bs.read_ratio({}))

    def test_a_control_without_a_reading_leaves_I_unreadable_and_the_burst_figures_stand(self):
        members = [burst_member('H3b', 20.0), burst_member('H3bnw2', 10.0), burst_member('H3bnw2', 10.0), burst_member('H3b', 20.0)]
        blind = [v2m('H3', segments={'before': {'n': 0, 'p95_ms': None}, 'after': {'n': 0, 'p95_ms': None}}) for _ in range(2)]
        result = self.analyze(members, blind)
        self.assertEqual((result['disturbance']['control_read_ratio'], result['disturbance']['I'], result['disturbance']['I_nw2_over_nw1']), (None, {'H3b': None, 'H3bnw2': None}, None))
        self.assertEqual(result['drain']['ratio'], 0.5)

    def test_an_invalid_or_missing_control_member_leaves_I_unreadable_and_the_drain_stands(self):
        members = [burst_member('H3b', 20.0, after=55.0), burst_member('H3bnw2', 10.0, after=75.0), burst_member('H3bnw2', 10.0, after=75.0), burst_member('H3b', 20.0, after=55.0)]
        segments = {'before': {'n': 90, 'p95_ms': 50.0}, 'after': {'n': 60, 'p95_ms': 50.0}}
        for label, control in (('one of the two is invalid', [v2m('H3', segments=segments), v2m('H3', segments=segments, valid=False)]),
                               ('both are invalid', [v2m('H3', segments=segments, valid=False)] * 2),
                               ('one is missing', [v2m('H3', segments=segments)]),
                               ('none', [])):
            result = self.analyze(members, control)
            disturbance = result['disturbance']
            self.assertFalse(disturbance['control_readable'], label)
            self.assertEqual((disturbance['control_read_ratio'], disturbance['I'], disturbance['I_nw2_over_nw1'], disturbance['reading']),
                             (None, {'H3b': None, 'H3bnw2': None}, None, 'không đọc được'), label)
            self.assertEqual((result['configs']['H3b']['I_reading'], result['configs']['H3bnw2']['I_reading']), ('không đọc được', 'không đọc được'), label)
            self.assertEqual((result['readable'], result['drain']['ratio']), (True, 0.5), label)   # the drain does not depend on the control
        self.assertTrue(self.analyze(members)['disturbance']['control_readable'])
        self.assertAlmostEqual(self.analyze(members)['disturbance']['I']['H3b'], 1.1)

    def test_the_notifications_of_the_background_are_late_when_their_p95_during_the_burst_is_1_1x_the_one_before(self):
        slow = [burst_member('H3b', 20.0, background=(100.0, 400.0)), burst_member('H3bnw2', 10.0, background=(100.0, 150.0)), burst_member('H3bnw2', 10.0, background=(100.0, 150.0)),
                burst_member('H3b', 20.0, background=(100.0, 400.0))]
        result = self.analyze(slow)
        self.assertEqual(result['background_notifications']['delay_during_over_before'], {'H3b': 4.0, 'H3bnw2': 1.5})
        self.assertIn('thông báo thường xếp sau đợt dồn', result['background_notifications']['reading'])
        calm = [burst_member(c, d, background=(100.0, 105.0)) for c, d in zip(self.order, (20.0, 10.0, 10.0, 20.0))]
        self.assertEqual(self.analyze(calm)['background_notifications']['reading'], 'trễ thông báo nền không tăng đáng kể')
        none = [burst_member(c, d, background=(None, None)) for c, d in zip(self.order, (20.0, 10.0, 10.0, 20.0))]
        self.assertEqual(self.analyze(none)['background_notifications']['reading'], 'không đọc được')


class VmV2Analysis(unittest.TestCase):
    def full_records(self, world=None, mode_blocks=None):
        return records_of(world or World(), mode_blocks or [b for b in bs.vm2_blocks('full')])

    def test_a_complete_run_is_compared_block_by_block_with_the_comparisons_of_the_design(self):
        analysis = bs.analyze_v2(self.full_records())
        self.assertEqual(analysis['decision'], 'COMPARED')
        self.assertEqual(list(analysis['blocks']), ['part1', 'burst', 'tier-200', 'tier-400', 'tier-800'])
        self.assertTrue(all(b['complete'] for b in analysis['blocks'].values()))
        self.assertEqual(list(analysis['blocks']['part1']['comparisons']), ['H3/H1', 'H3c/H3', 'H3/M', 'H1/M'])
        self.assertEqual(list(analysis['blocks']['tier-200']['comparisons']), ['H3x2/H3', 'H3/M'])
        self.assertEqual(list(analysis['blocks']['tier-800']['comparisons']), ['H3cl2/H3', 'H3x2/H3', 'H3x2cl2/H3x2', 'H3x2cl2/H3cl2', 'H3x2cl2/H3', 'H3/M'])
        self.assertIn('operations', analysis['blocks']['part1']['comparisons']['H3/M'])
        self.assertNotIn('operations', analysis['blocks']['tier-200']['comparisons']['H3/M'])
        self.assertEqual(analysis['unreadable'], [])
        self.assertEqual(analysis['bands'], [0.9, 1.1])
        self.assertIsNotNone(analysis['scale_out'])
        self.assertIsNotNone(analysis['burst'])
        self.assertIsNone(analysis['pool'])
        self.assertIsNotNone(analysis['saturation'])
        json.dumps(analysis)   # evaluation.json carries it

    def test_the_known_ratios_of_a_world_come_out_with_the_host_drift_cancelled(self):
        for drift in (1.0, 1.04):
            world = World(drift=drift, capacity={'M': 9000.0, 'H1': 9000.0, 'H3': 9000.0, 'H3c': 9000.0, 'H3x2': 9000.0, 'H3p8': 9000.0, 'H3cl2': 9000.0, 'H3x2cl2': 9000.0})
            analysis = bs.analyze_v2(records_of(world, [block_of('part1', 100, bs.PART1_ORDER, errors_invalidate=True)]))
            for label, entry in analysis['blocks']['part1']['comparisons'].items():
                self.assertAlmostEqual(entry['ratios']['success_rps'], 1.0, places=9, msg=label)   # every configuration serves the 90 requests per second 100 users ask for
                self.assertAlmostEqual(entry['ratios']['read_p95_ms'], 1.0, places=9, msg=label)

    def test_a_member_that_failed_stops_the_analysis_of_its_block_and_marks_the_decision_incomplete(self):
        records = self.full_records()[:10]
        records[9]['metrics'] = {'valid': False, 'reasons': ['member FAILED at load'], 'failed': True}
        analysis = bs.analyze_v2(records, stopped={'member': records[9]['name'], 'reasons': ['member FAILED at load']})
        self.assertEqual(analysis['decision'], 'INCOMPLETE')
        self.assertEqual(analysis['stopped']['member'], 'full-9-100-H3bnw2')
        self.assertTrue(analysis['blocks']['part1']['complete'])
        self.assertFalse(analysis['blocks']['burst']['complete'])
        self.assertIn('burst: the block did not run to its end', analysis['unreadable'])
        self.assertIsNone(analysis['burst'])
        self.assertEqual(bs.analyze_v2([])['decision'], 'NOT_RUN')

    def test_an_invalid_member_makes_only_the_ratios_it_is_in_unreadable(self):
        records = self.full_records(mode_blocks=[block_of('part1', 100, bs.PART1_ORDER, errors_invalidate=True)])
        records[3]['metrics'] = v2m('H3c', valid=False)   # the first H3c
        analysis = bs.analyze_v2(records)
        comparisons = analysis['blocks']['part1']['comparisons']
        self.assertFalse(comparisons['H3c/H3']['readable'])
        self.assertTrue(comparisons['H3/H1']['readable'])
        self.assertTrue(comparisons['H3/M']['readable'])
        self.assertEqual(analysis['unreadable'], ['part1: H3c/H3'])
        self.assertEqual(analysis['decision'], 'COMPARED')

    def test_a_part_1_h3_member_that_is_invalid_makes_I_unreadable_and_says_so(self):
        records = self.full_records()
        first_h3 = next(r for r in records if r['block'] == 'part1' and r['config'] == 'H3')
        first_h3['metrics'] = {**first_h3['metrics'], 'valid': False, 'reasons': ['error rate above 1%']}
        analysis = bs.analyze_v2(records)
        self.assertEqual(analysis['decision'], 'COMPARED')
        self.assertFalse(analysis['burst']['disturbance']['control_readable'])
        self.assertEqual(analysis['burst']['disturbance']['I'], {'H3b': None, 'H3bnw2': None})
        self.assertIsNotNone(analysis['burst']['drain']['ratio'])
        self.assertIn('burst: the two H3 members of Part 1 (the control of I) are not both there and valid, I is not readable', analysis['unreadable'])
        # With both valid the control is readable and nothing is said.
        analysis = bs.analyze_v2(self.full_records())
        self.assertTrue(analysis['burst']['disturbance']['control_readable'])
        self.assertFalse([line for line in analysis['unreadable'] if 'control of I' in line])

    def test_the_scale_out_conclusion_gets_the_saturation_of_h3_at_the_step_of_its_block(self):
        flat = {c: 9000.0 for c in World.CAPACITY}
        analysis = bs.analyze_v2(self.full_records(World(capacity=flat)))
        sat = analysis['saturation']['configs']['H3']['series']
        at_800 = next(entry for entry in sat if entry['users'] == 800)
        self.assertEqual(analysis['scale_out']['h3_saturated'], at_800['saturated'])
        self.assertIs(analysis['scale_out']['h3_saturated'], False)   # 720 requests per second asked for, 720 served: no sign
        # Every ratio is about 1 and H3 is not saturated, but its Core and Clinic are at one core in the world's CPU model: hot, so E and not D.
        self.assertEqual((analysis['scale_out']['code'], analysis['scale_out']['hot_processes']['H3']), ('E', ['clinic-0', 'core']))
        self.assertNotIn('M', analysis['scale_out']['hot_processes'])
        # A saturated H3 at the step: the flag is True.
        analysis = bs.analyze_v2(self.full_records(World(capacity={'H3': 300.0, 'H3x2': 520.0, 'H3cl2': 300.0, 'H3x2cl2': 520.0})))
        self.assertIs(analysis['scale_out']['h3_saturated'], True)
        self.assertEqual(analysis['scale_out']['code'], 'A')
        self.assertEqual(analysis['scale_out']['harmful'], [])

    def test_the_limitations_name_the_growth_rule_for_a_step_that_is_not_double_and_the_two_blocks_of_the_100_to_200_growth(self):
        text = ' '.join(bs.ANALYSIS_LIMITATIONS)
        # 1.5 ** log2(ratio): 84.5% of linear at 600 after 400 against 75% at a doubling.
        self.assertIn('1.5 ** log2(users ratio)', text)
        self.assertIn('84.5% of linear growth', text)
        self.assertIn('75% for a doubling step', text)
        self.assertAlmostEqual(bs.required_growth(600, 400) / 1.5, 0.845, places=3)
        self.assertAlmostEqual(bs.required_growth(200, 100) / 2.0, 0.75)
        self.assertIn('stricter at 600', text)
        self.assertIn('Part 1 (no pg_stat_activity sampler) with the 200-user step (sampler on)', text)
        self.assertIn('two different blocks', text)
        self.assertIn('drift of the host between blocks does not cancel', text)
        # The earlier limitations are still there, and the analysis carries all of them.
        self.assertIn('control of the effect I', text)
        self.assertIn('upper bound of the price at compose', text)
        analysis = bs.analyze_v2(self.full_records())
        self.assertEqual(analysis['limitations'], list(bs.ANALYSIS_LIMITATIONS))
        self.assertEqual(len(analysis['limitations']), 5)

    def test_a_step_with_more_than_1_percent_of_429_is_not_readable_at_all(self):
        records = self.full_records(World(rate_429={('H3x2', 400): 0.05}))
        analysis = bs.analyze_v2(records)
        self.assertFalse(analysis['blocks']['tier-400']['rate_429_ok'])
        self.assertTrue(all(not e['readable'] for e in analysis['blocks']['tier-400']['comparisons'].values()))
        self.assertIn('tier-400: more than 1% of the responses were 429', analysis['unreadable'])
        self.assertTrue(analysis['blocks']['tier-200']['comparisons']['H3x2/H3']['readable'])
        series = analysis['saturation']['configs']['H3']['series']
        self.assertEqual([(e['users'], e['readable']) for e in series], [(100, True), (200, True), (400, False), (800, True)])

    def test_a_run_whose_every_ratio_is_unreadable_is_invalid(self):
        records = self.full_records()
        for record in records:
            record['metrics'] = {**record['metrics'], 'valid': False}
        self.assertEqual(bs.analyze_v2(records)['decision'], 'INVALID')

    def test_the_saturation_of_a_world_is_found_at_the_step_where_h3_reaches_its_capacity_and_core_is_the_first_hot_process(self):
        analysis = bs.analyze_v2(self.full_records())
        saturation = analysis['saturation']
        h3 = saturation['configs']['H3']
        self.assertEqual(h3['first_saturated_users'], 400)         # 0.9 x 400 = 360 asked, 300 served: the read p95 is 900 ms
        self.assertEqual([(e['users'], e['saturated']) for e in h3['series']], [(100, False), (200, False), (400, True), (800, True)])
        self.assertIsNone(saturation['configs']['M']['first_saturated_users'])       # M serves everything asked (720 of 900 at 800 users)
        self.assertEqual(saturation['configs']['H3x2']['first_saturated_users'], 800)  # 520 of 720 asked
        self.assertEqual(saturation['first_hot']['users_by_group'], {'core': 400})
        self.assertEqual(saturation['first_hot']['first'], 'core')
        self.assertEqual(h3['series'][2]['signs'], ['read_p95'])  # 180 -> 300 grew by 1.67x, above 1.5
        self.assertEqual(h3['series'][3]['signs'], ['throughput', 'read_p95', 'errors'])

    def test_the_pool_block_is_analysed_as_h3p8_over_h3_and_names_the_pool_before_and_after(self):
        world = World(pool_full=('H3',), capacity={'H3p8': 420.0})
        records = records_of(world, [block_of('pool', 400, bs.POOL_ORDER, pg_sampler=True)])
        analysis = bs.analyze_v2(records)
        pool = analysis['pool']
        entry = pool['comparisons']['H3p8/H3']
        self.assertEqual((pool['block'], entry['throughput_reading']), ('pool-400', 'có lợi'))
        self.assertAlmostEqual(entry['ratios']['success_rps'], 360.0 / 300.0)
        self.assertEqual(pool['reading'], bs.POOL_READINGS['có lợi'])
        self.assertTrue(pool['pool_before']['bound'] and not pool['pool_after']['bound'])
        same = bs.analyze_v2(records_of(World(pool_full=('H3',)), [block_of('pool', 400, bs.POOL_ORDER, pg_sampler=True)]))['pool']
        self.assertEqual((same['comparisons']['H3p8/H3']['throughput_reading'], same['reading']), ('không đổi', bs.POOL_READINGS['không đổi']))
        worse = bs.analyze_v2(records_of(World(capacity={'H3p8': 200.0}), [block_of('pool', 400, bs.POOL_ORDER, pg_sampler=True)]))['pool']
        self.assertEqual(worse['reading'], bs.POOL_READINGS['hại'])

    def test_the_burst_block_of_the_run_reads_against_the_h3_members_of_part_1(self):
        analysis = bs.analyze_v2(self.full_records())
        burst = analysis['burst']
        self.assertEqual(burst['block'], 'burst')
        self.assertTrue(burst['readable'])
        self.assertAlmostEqual(burst['drain']['ratio'], 0.5, places=9)          # the world drains in 20/nw seconds, slowed by the drift only
        self.assertEqual(burst['drain']['reading'], '2 worker xả gần gấp đôi')
        self.assertAlmostEqual(burst['disturbance']['control_read_ratio'], 1.0)

    def test_probes_and_the_local_blocks_are_listed_but_not_paired(self):
        analysis = bs.analyze_v2(records_of(World(), bs.vm2_blocks('local')))
        self.assertEqual(analysis['decision'], 'COMPARED')
        self.assertEqual(analysis['blocks']['probe-800']['probe'], 'a dry-run member, not paired')
        self.assertNotIn('comparisons', analysis['blocks']['probe-100'])
        self.assertIn('H3x2/H3', analysis['blocks']['tier-200']['comparisons'])
        self.assertIsNone(analysis['burst'])   # one member of each burst configuration is no pair
        self.assertIsNotNone(analysis['saturation'])

    def test_the_200_step_without_the_h3x2_pair_has_no_h3x2_ratio_and_the_run_still_reads(self):
        records = records_of(World(), bs.vm2_blocks('full', ('x2-200',)))
        analysis = bs.analyze_v2(records)
        self.assertEqual(list(analysis['blocks']['tier-200']['comparisons']), ['H3/M'])
        self.assertEqual(analysis['decision'], 'COMPARED')
        self.assertEqual([e['users'] for e in analysis['saturation']['configs']['H3x2']['series']], [400, 800])   # the first step of H3x2 is 400

    def test_a_member_that_the_run_abandoned_is_left_out_of_the_analysis(self):
        records = self.full_records(mode_blocks=[block_of('tier', 800, bs.TOP_ORDER, pg_sampler=True)])
        records[0]['abandoned'] = True
        analysis = bs.analyze_v2(records)
        self.assertEqual(analysis['blocks']['tier-800']['order'], list(bs.TOP_ORDER[1:]))
        self.assertFalse(analysis['blocks']['tier-800']['complete'])

    def test_the_analysis_says_what_it_does_not_see(self):
        note = bs.analyze_v2(self.full_records())['note']
        for needle in ('geometric mean', 'cancels exactly', 'upper bound'):
            self.assertIn(needle, note)
        limits = ' '.join(bs.analyze_v2(self.full_records())['limitations'])
        for needle in ('burst-observe', 'control of the effect I', "not 'idle'", 'lower bound', 'P2024'):   # the two limits of the burst and of the pool reading, written where the numbers are
            self.assertIn(needle, limits)


class VmV2Flow(unittest.TestCase):
    """VmStudy2.execute on a synthetic host: members are not run, each answers with the metrics World gives for its configuration, users and position."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / 'src'
        self.root.mkdir()
        self.private, self.output = Path(self.directory.name) / 'private', Path(self.directory.name) / 'results'
        self.private.mkdir()

    def run_study(self, mode='full', world=None, *, fail=None, smoke_valid=True, cuts=(), invalid=None, progress=None):
        """fail: name of the member that FAILED; invalid: names of members that are invalid for a reason other than failing; progress: where the lines of the run go."""
        world = world or World()
        study = bs.VmStudy2(self.root, self.private, self.output, 'run-1', mode=mode, progress=progress or (lambda text: None), cuts=cuts)
        study.pinning = {'generator': [0], 'server': [1, 2, 3, 4, 5, 6, 7]}
        calls, positions = [], {'full': 0}

        def member(index, configuration, settings, label, *, burst=None, pg_sampler=False):
            calls.append({'index': index, 'config': configuration, 'users': settings['users'], 'label': label, 'burst': burst, 'pg_sampler': pg_sampler, 'settings': dict(settings)})
            name = bs.member_name(index, settings['users'], configuration) if label == 'full' else f'{label}-{index}-{configuration}'
            return self.private / 'members' / name

        def metrics(directory, settings, require_cpu=True, *, config, errors_invalidate=True, burst=False, pg_sampler=False):
            name = Path(directory).name
            calls[-1].update(config_asked=config, errors_invalidate=errors_invalidate, burst_asked=burst, name=name)
            if name == fail:
                return {'valid': False, 'reasons': ['member FAILED at load'], 'failed': True}
            if name.startswith('smoke'):
                return {'valid': smoke_valid, 'reasons': [] if smoke_valid else ['smoke broke'], 'config': config}
            position = positions['full']
            positions['full'] += 1
            value = world.metrics(config, settings['users'], position, errors_invalidate=errors_invalidate, burst=burst)
            if invalid and name in invalid:
                value.update(valid=False, reasons=['generator above 0.80 core (0.90)'])
            return value
        with patch.object(study, 'member', member), patch.object(study, 'metrics', metrics), patch.object(study, 'versions', return_value={}), \
                patch.object(study, 'build'), patch.object(study, 'before_members'):
            result = study.execute(install=False)
        return result, calls, study

    def test_smoke_runs_the_nine_members_with_a_burst_only_for_the_burst_configuration(self):
        result, calls, study = self.run_study('smoke')
        self.assertEqual((result['status'], result['comparison']), ('SMOKE_PASSED', {'decision': 'NOT_RUN'}))
        self.assertEqual([c['config'] for c in calls], list(bs.VM2_SMOKE_ORDER))
        self.assertEqual([(c['label'], c['users']) for c in calls], [('smoke', 2)] * 9)
        self.assertEqual([c['burst'] for c in calls], [None] * 8 + [{'count': 200, 'at_s': 5}])
        self.assertEqual([c['burst_asked'] for c in calls], [False] * 8 + [True])
        self.assertIn('H3cl2', [c['config'] for c in calls])   # a second Clinic instance is smoked before it is measured
        self.assertTrue(all(c['settings'] == bs.SMOKE and not c['pg_sampler'] for c in calls))
        self.assertEqual([s['configuration'] for s in result['smoke']], list(bs.VM2_SMOKE_ORDER))

    def test_a_failed_smoke_blocks_the_measured_members(self):
        result, calls, study = self.run_study('full', smoke_valid=False)
        self.assertEqual(result['status'], 'SMOKE_FAILED')
        self.assertEqual(len(calls), 9)
        self.assertEqual(result['comparison'], {'decision': 'NOT_RUN'})

    def test_full_runs_the_blocks_in_order_with_their_names_users_burst_and_sampler(self):
        result, calls, study = self.run_study('full', World(capacity={'H3': 5000.0, 'H3x2': 5000.0, 'H3cl2': 5000.0, 'H3x2cl2': 5000.0, 'M': 5000.0, 'H1': 5000.0, 'H3c': 5000.0}))
        self.assertEqual(result['status'], 'COMPLETE')
        measured = [c for c in calls if c['label'] == 'full']
        self.assertEqual(len(measured), 8 + 4 + 6 + 6 + 10)
        self.assertEqual([c['config'] for c in measured], list(bs.PART1_ORDER) + list(bs.BURST_ORDER) + list(bs.TIER_ORDER) * 2 + list(bs.TOP_ORDER))
        self.assertEqual([c['users'] for c in measured], [100] * 12 + [200] * 6 + [400] * 6 + [800] * 10)
        self.assertEqual([c['index'] for c in measured], list(range(34)))
        self.assertEqual([c['name'] for c in measured][:3], ['full-0-100-M', 'full-1-100-H1', 'full-2-100-H3'])
        self.assertEqual(measured[-1]['name'], 'full-33-800-M')
        self.assertEqual([c['burst'] for c in measured], [None] * 8 + [bs.BURST_FULL] * 4 + [None] * 22)
        self.assertEqual([c['pg_sampler'] for c in measured], [False] * 12 + [True] * 22)   # the sampler in Part 2 only
        self.assertEqual([c['errors_invalidate'] for c in measured], [True] * 12 + [False] * 22)
        self.assertEqual([c['settings']['spawn_rate'] for c in measured], [10] * 12 + [20] * 6 + [40] * 6 + [80] * 10)
        self.assertEqual(measured[0]['settings'], bs.FULL)
        self.assertEqual((result['comparison']['decision'], result['study'], result['mode']), ('COMPARED', bs.VM2_STUDY, 'full'))
        self.assertEqual([m['name'] for m in result['members']], [c['name'] for c in measured])
        self.assertEqual(result['settings']['top_tier'], {'planned': 800, 'used': 800, 'shifted': False, 'probe': 'full-24-800-M', 'generator_cores': result['settings']['top_tier']['generator_cores'], 'reason': None,
                                                           'would_shift': False})
        self.assertEqual(result['settings']['pool_block'], {'ran': False, 'users': None})
        self.assertEqual(result['settings']['burst'], bs.BURST_FULL)
        self.assertEqual(result['vm']['steps'], [200, 400, 800])
        self.assertIn('H3', result['vm']['configurations'])
        self.assertTrue(any('gateway topologies' in text for text in result['vm']['harnessChanges']))
        self.assertTrue((self.output / 'reports/evaluation.json').is_file())
        evaluation = json.loads((self.output / 'reports/evaluation.json').read_text(encoding='utf-8'))
        self.assertEqual(evaluation['comparison']['decision'], 'COMPARED')

    def test_the_pool_block_runs_once_right_after_the_first_step_where_h3_is_saturated_with_its_pool_full(self):
        world = World(pool_full=('H3',), capacity={'H3p8': 420.0})
        result, calls, study = self.run_study('full', world)
        measured = [c for c in calls if c['label'] == 'full']
        self.assertEqual(len(measured), 34 + 4)
        # Part 1 (8), burst (4), 200 (6), 400 (6), then the pool block at 400 users, then the highest step.
        self.assertEqual([(c['config'], c['users']) for c in measured[24:28]], [('H3', 400), ('H3p8', 400), ('H3p8', 400), ('H3', 400)])
        self.assertEqual([c['users'] for c in measured[28:]], [800] * 10)
        self.assertEqual([c['name'] for c in measured[24:28]], ['full-24-400-H3', 'full-25-400-H3p8', 'full-26-400-H3p8', 'full-27-400-H3'])
        self.assertTrue(all(c['pg_sampler'] and not c['errors_invalidate'] for c in measured[24:28]))
        self.assertEqual(result['settings']['pool_block'], {'ran': True, 'users': 400})
        self.assertEqual(result['comparison']['pool']['block'], 'pool-400')
        self.assertEqual(result['comparison']['pool']['comparisons']['H3p8/H3']['throughput_reading'], 'có lợi')
        self.assertEqual(sum(c['config'] == 'H3p8' for c in measured), 2)   # once, not at 800 as well, although H3 is saturated there too

    def test_no_pool_block_when_the_pool_is_not_full_at_any_step(self):
        result, calls, study = self.run_study('full', World())
        self.assertEqual(len([c for c in calls if c['label'] == 'full']), 34)
        self.assertFalse(result['settings']['pool_block']['ran'])
        self.assertIsNone(result['comparison']['pool'])

    def test_the_highest_step_moves_to_600_users_when_the_generator_of_its_first_member_needs_more_than_0_70_core(self):
        world = World(generator={('M', 800): 0.75})
        result, calls, study = self.run_study('full', world)
        measured = [c for c in calls if c['label'] == 'full']
        self.assertEqual(len(measured), 34 + 1)
        self.assertEqual((measured[24]['config'], measured[24]['users'], measured[24]['name']), ('M', 800, 'full-24-800-M'))
        self.assertEqual([(c['config'], c['users']) for c in measured[25:]], [(c, 600) for c in bs.TOP_ORDER])
        self.assertEqual([c['settings']['spawn_rate'] for c in measured[25:]], [60] * 10)
        self.assertEqual(measured[25]['name'], 'full-25-600-M')
        top = result['settings']['top_tier']
        self.assertEqual((top['planned'], top['used'], top['shifted'], top['probe'], top['generator_cores']), (800, 600, True, 'full-24-800-M', 0.75))
        self.assertIn('above 0.70', top['reason'])
        abandoned = [m for m in result['members'] if m.get('abandoned')]
        self.assertEqual([m['name'] for m in abandoned], ['full-24-800-M'])
        analysis = result['comparison']
        self.assertEqual(list(analysis['blocks']), ['part1', 'burst', 'tier-200', 'tier-400', 'tier-600'])   # the abandoned member is not an analysed block
        self.assertEqual(analysis['scale_out']['block'], 'tier-600')
        self.assertEqual([e['users'] for e in analysis['saturation']['configs']['H3']['series']], [100, 200, 400, 600])

    def test_the_highest_step_stays_at_800_when_the_generator_uses_0_70_core_or_less(self):
        result, calls, study = self.run_study('full', World(generator={('M', 800): 0.70}))
        self.assertEqual(len([c for c in calls if c['label'] == 'full']), 34)
        self.assertEqual((result['settings']['top_tier']['used'], result['settings']['top_tier']['shifted']), (800, False))
        self.assertEqual(result['settings']['top_tier']['generator_cores'], 0.70)

    def test_a_generator_that_is_busy_at_600_still_invalidates_its_members_but_nothing_moves_again(self):
        world = World(generator={('M', 800): 0.75, ('M', 600): 0.9})
        result, calls, study = self.run_study('full', world, invalid={'full-25-600-M'})
        self.assertEqual(len([c for c in calls if c['label'] == 'full']), 35)
        self.assertEqual(result['settings']['top_tier']['used'], 600)
        self.assertEqual(result['comparison']['decision'], 'COMPARED')
        self.assertFalse(result['comparison']['blocks']['tier-600']['valid'])
        self.assertFalse(result['comparison']['blocks']['tier-600']['comparisons']['H3/M']['readable'])

    def test_errors_above_one_percent_in_part_2_do_not_stop_the_study_but_are_a_sign_of_saturation(self):
        # H3 is asked for 1.5x its capacity at 400 users and fails 3% of its requests there and at 800.
        result, calls, study = self.run_study('full', World(capacity={'H3': 220.0, 'M': 5000.0}))
        measured = [c for c in calls if c['label'] == 'full']
        self.assertEqual(len(measured), 34)
        self.assertEqual(result['comparison']['decision'], 'COMPARED')
        h3 = result['comparison']['saturation']['configs']['H3']['series']
        self.assertIn('errors', [e for e in h3 if e['users'] == 400][0]['signs'])
        self.assertTrue(all(m['valid'] for m in result['members'] if m['users'] >= 200))

    def test_errors_above_one_percent_at_100_users_make_a_member_invalid_and_the_block_goes_on(self):
        result, calls, study = self.run_study('full', World(capacity={'H3': 30.0}))   # 90 requests asked of a capacity of 30: 3x
        measured = [c for c in calls if c['label'] == 'full']
        self.assertEqual(len(measured), 34)   # an invalid member does not stop the study
        invalid = [m['name'] for m in result['members'] if not m['valid']]
        self.assertIn('full-2-100-H3', invalid)
        comparisons = result['comparison']['blocks']['part1']['comparisons']
        self.assertFalse(comparisons['H3/H1']['readable'])
        self.assertTrue(comparisons['H1/M']['readable'])

    def test_a_member_that_failed_stops_the_study_and_what_ran_is_analysed(self):
        result, calls, study = self.run_study('full', fail='full-10-100-H3bnw2')
        measured = [c for c in calls if c['label'] == 'full']
        self.assertEqual(len(measured), 11)
        self.assertEqual(result['status'], 'COMPLETE')
        comparison = result['comparison']
        self.assertEqual((comparison['decision'], comparison['stopped']['member']), ('INCOMPLETE', 'full-10-100-H3bnw2'))
        self.assertTrue(comparison['blocks']['part1']['complete'])
        self.assertEqual(comparison['blocks']['burst']['members'], ['full-8-100-H3b', 'full-9-100-H3bnw2', 'full-10-100-H3bnw2'])
        self.assertEqual(result['members'][-1]['failed'], True)
        for call in measured:
            self.assertNotEqual(call['users'], 200)

    def test_a_member_that_failed_in_the_pool_block_or_the_first_member_of_the_top_step_stops_the_study_too(self):
        result, calls, study = self.run_study('full', World(), fail='full-24-800-M')
        self.assertEqual(len([c for c in calls if c['label'] == 'full']), 25)
        self.assertEqual(result['comparison']['decision'], 'INCOMPLETE')
        result, calls, study = self.run_study('full', World(pool_full=('H3',)), fail='full-26-400-H3p8')
        self.assertEqual(len([c for c in calls if c['label'] == 'full']), 27)
        self.assertEqual(result['comparison']['stopped']['member'], 'full-26-400-H3p8')
        self.assertEqual([c['users'] for c in calls if c['label'] == 'full'][-1], 400)

    def test_an_invalid_member_that_did_not_fail_is_carried_to_the_analysis(self):
        result, calls, study = self.run_study('full', invalid={'full-14-200-H3x2'})
        self.assertEqual(len([c for c in calls if c['label'] == 'full']), 34)
        self.assertEqual(result['comparison']['decision'], 'COMPARED')
        self.assertFalse(result['comparison']['blocks']['tier-200']['comparisons']['H3x2/H3']['readable'])
        self.assertTrue(result['comparison']['blocks']['tier-200']['comparisons']['H3/M']['readable'])

    def test_the_cuts_remove_the_members_they_name(self):
        result, calls, study = self.run_study('full', cuts=('x2-200', 'burst-short'))
        measured = [c for c in calls if c['label'] == 'full']
        self.assertEqual(len(measured), 8 + 4 + 4 + 6 + 10)
        self.assertEqual([c['config'] for c in measured if c['users'] == 200], ['M', 'H3', 'H3', 'M'])
        burst = [c for c in measured if c['burst']]
        self.assertEqual({(c['burst']['at_s'], c['settings']['seconds']) for c in burst}, {(60, 180)})
        self.assertEqual(result['vm']['cuts'], ['x2-200', 'burst-short'])
        self.assertEqual(result['settings']['burst'], {'count': 6000, 'at_s': 60})
        self.assertEqual(result['comparison']['decision'], 'COMPARED')

    def test_local_runs_the_reduced_plan_and_says_in_advance_whether_the_full_run_would_move_the_highest_step(self):
        lines = []
        result, calls, study = self.run_study('local', World(generator={('M', 800): 0.9, ('H3x2cl2', 800): 0.2}), progress=lines.append)
        measured = [c for c in calls if c['label'] == 'full']
        # M at 800 users opens the probe as it opens the highest step of a full run; H3x2cl2, the member added to that step, follows.
        self.assertEqual([(c['config'], c['users']) for c in measured], [(c, 200) for c in bs.TIER_ORDER] + [('M', 800), ('H3x2cl2', 800), ('H3b', 100), ('H3bnw2', 100)])
        self.assertEqual([c['burst'] for c in measured], [None] * 8 + [bs.BURST_LOCAL] * 2)
        self.assertEqual((measured[0]['settings']['seconds'], measured[0]['settings']['warmup']), (60, 10))
        top = result['settings']['top_tier']
        # The generator of M decides K10 (0.90 core is above 0.70); the dry run moves nothing and the probe is M, not the member that follows it.
        self.assertEqual((top['shifted'], top['used'], top['generator_cores'], top['would_shift'], top['probe']), (False, 800, 0.9, True, 'full-6-800-M'))
        self.assertTrue(any('0.90 core at 800 users: a full run would move the highest step to 600 users' in line for line in lines), lines)
        self.assertEqual(result['comparison']['decision'], 'COMPARED')
        self.assertFalse(result['settings']['pool_block']['ran'])
        self.assertEqual(len(calls), 9 + 10)
        self.assertEqual(result['comparison']['blocks']['probe-800']['order'], ['M', 'H3x2cl2'])

    def test_a_dry_run_whose_generator_is_not_busy_at_800_users_says_the_step_stays(self):
        lines = []
        result, calls, study = self.run_study('local', World(generator={('M', 800): 0.5, ('H3x2cl2', 800): 0.95}), progress=lines.append)
        top = result['settings']['top_tier']
        self.assertEqual((top['would_shift'], top['generator_cores'], top['used']), (False, 0.5, 800))   # the busy generator of the member after M decides nothing
        self.assertTrue(any('0.50 core at 800 users: a full run would keep the highest step at 800 users' in line for line in lines), lines)
        self.assertFalse(any('would move' in line for line in lines))
        full_lines = []
        self.run_study('full', World(generator={('M', 800): 0.5}), progress=full_lines.append)
        self.assertFalse(any('a full run would' in line for line in full_lines))   # the full run decides, it does not forecast

    def test_the_v1_study_is_untouched_by_the_split_of_execute(self):
        # KaggleStudyFlow and VmStudyFlow run the v1 orders through the same execute; here only that VmStudy has no measure of its own.
        self.assertIs(bs.VmStudy.measure, bs.Study.measure)
        self.assertIs(bs.VmStudy.smoke_members, bs.Study.smoke_members)
        self.assertIsNot(bs.VmStudy2.measure, bs.Study.measure)


class VmV2Cli(unittest.TestCase):
    def run_main(self, argv):
        with tempfile.TemporaryDirectory() as directory:
            base = ['--platform', 'vm', '--root', directory, '--results', str(Path(directory) / 'out')]
            with patch.object(bs, 'run_vm_study', return_value={'status': 'SMOKE_PASSED', 'download': 'x'}) as v1, \
                    patch.object(bs, 'run_vm_study2', return_value={'status': 'COMPLETE', 'comparison': {'decision': 'COMPARED'}, 'download': 'x'}) as v2, \
                    patch('builtins.print'):
                code = bs.main(base + argv)
        return code, v1, v2

    def test_the_study_defaults_to_v1_so_the_v1_script_keeps_working_and_v2_is_asked_for(self):
        code, v1, v2 = self.run_main(['--mode', 'smoke'])
        self.assertEqual((code, v1.call_count, v2.call_count), (0, 1, 0))
        code, v1, v2 = self.run_main(['--study', 'v2', '--mode', 'full', '--no-install'])
        self.assertEqual((code, v1.call_count, v2.call_count), (0, 0, 1))
        self.assertEqual((v2.call_args.kwargs['mode'], v2.call_args.kwargs['install'], v2.call_args.kwargs['cuts']), ('full', False, ()))

    def test_cuts_go_to_v2_only_and_must_be_known(self):
        code, v1, v2 = self.run_main(['--study', 'v2', '--cut', 'x2-200', '--cut', 'burst-short'])
        self.assertEqual(v2.call_args.kwargs['cuts'], ('x2-200', 'burst-short'))
        with patch('sys.stderr', io.StringIO()):   # argparse explains itself on stderr
            for argv in (['--cut', 'x2-200'], ['--study', 'v2', '--cut', 'nothing'], ['--study', 'v3']):
                with self.assertRaises(SystemExit):
                    self.run_main(argv)

    def test_a_v2_run_that_is_incomplete_or_invalid_exits_with_1(self):
        with tempfile.TemporaryDirectory() as directory:
            for decision, expected in (('COMPARED', 0), ('INCOMPLETE', 1), ('INVALID', 1)):
                with patch.object(bs, 'run_vm_study2', return_value={'status': 'COMPLETE', 'comparison': {'decision': decision}, 'download': 'x'}), patch('builtins.print'):
                    self.assertEqual(bs.main(['--platform', 'vm', '--study', 'v2', '--root', directory, '--results', directory]), expected)


# ---- bridge-m-h-vm-v2: the bundle, the export and vm_run.sh (K9 C4) ---------------------------------------------------------------------
def v2_files(layout):
    return {path: b'source ' + path.encode() for path in nb.CORE_LAYOUT_SOURCES[layout]}


class VmV2Bundle(unittest.TestCase):
    """pack_vm2 on made-up trees (nb.git and nb.tree patched): what goes into the bundle, the layout check, the manifest."""
    SCRIPT = 'benchmarks/phase2/kaggle/vm_run.sh'

    def harness(self):
        return {**{name: b'harness ' + name.encode() for name in nb.VM_HARNESS}, self.SCRIPT: b'#!/usr/bin/env bash\r\necho x\r\n'}

    def patches(self, h1_layout='phase2', h3_layout='workers', status=b'', harness=True):
        trees = {nb.M_COMMIT: {'backend/m.ts': b'm'}, 'h1': {**v2_files(h1_layout), 'backend/h1.ts': b'h1'}, 'h3': {**v2_files(h3_layout), 'backend/h3.ts': b'h3'}}
        trees['HEAD'] = trees['h3']   # `git rev-parse HEAD` of the fake repository is `HEAD` itself, whose tree is that of h3
        harness_files = self.harness()

        def tree(commit, paths):
            if paths == nb.VM_HARNESS:
                if not harness:
                    raise subprocess.CalledProcessError(128, 'git archive')
                return dict(harness_files)
            return dict(trees[commit])

        def git(*args):
            return {'rev-parse': (args[1] + '\n').encode(), 'status': status, 'log': b'4f1c0de\n'}[args[0]]
        return patch.object(nb, 'tree', tree), patch.object(nb, 'git', git)

    def pack(self, *args, **kwargs):
        first, second = self.patches(**{k: kwargs.pop(k) for k in ('h1_layout', 'h3_layout', 'status', 'harness') if k in kwargs})
        with first, second:
            return nb.pack_vm2(*(args or ('h3', 'h1')), **kwargs)

    def test_the_constants_name_the_study_the_harness_runs(self):
        self.assertEqual((nb.VM2_STUDY, nb.VM2_GROUPS), (bs.VM2_STUDY, bs.VM2_GROUPS))
        self.assertEqual(nb.VM2_GROUPS, ('M', 'H1', 'H3'))
        self.assertNotEqual(nb.VM2_FORMAT, nb.VM_FORMAT)
        self.assertEqual(nb.VM_FORMATS, {nb.VM_FORMAT: nb.VM_GROUPS, nb.VM2_FORMAT: nb.VM2_GROUPS})
        self.assertTrue(nb.H1_COMMIT.startswith('2841d1b') and len(nb.H1_COMMIT) == 40)
        self.assertEqual(nb.VM2_TARGET.name, 'bridge-m-h-vm-v2.zip')
        self.assertEqual(nb.VM_TARGET.name, 'bridge-m-h-vm-v1.zip')   # v1 stays what it was
        # The layout each tree is checked for is the one the study tells stack.mjs to build.
        self.assertEqual(nb.VM2_LAYOUTS, {tree: bs.VM2_CONFIGS[tree]['layout'] for tree in ('H1', 'H3')})
        self.assertEqual({layout for layout in nb.CORE_LAYOUT_SOURCES}, {'phase2', 'workers'})
        stack = (HERE / 'stack.mjs').read_text(encoding='utf-8')
        for layout, sources in nb.CORE_LAYOUT_SOURCES.items():
            for source in sources:   # backend/src/x.ts is built to backend/dist/src/x.js, which is what stack.mjs starts
                self.assertIn(source.replace('backend/src/', 'backend/dist/src/').replace('.ts', '.js'), stack, layout)

    def test_assemble_gives_three_trees_one_harness_and_lf_scripts(self):
        harness = self.harness()
        payload = nb.assemble_vm2({'backend/a.sh': b'a\r\nb\r\n'}, {'backend/a.ts': b'h1', 'benchmarks/phase2/kaggle/stack.mjs': b'stack-old'}, {'backend/a.ts': b'h3'}, harness)
        self.assertEqual({name.partition('/')[0] for name in payload}, {'M', 'H1', 'H3'})
        self.assertEqual(payload['H1/benchmarks/phase2/kaggle/stack.mjs'], harness['benchmarks/phase2/kaggle/stack.mjs'])
        self.assertEqual(payload['H3/benchmarks/phase2/kaggle/stack.mjs'], harness['benchmarks/phase2/kaggle/stack.mjs'])
        self.assertEqual((payload['H1/backend/a.ts'], payload['H3/backend/a.ts']), (b'h1', b'h3'))
        self.assertEqual(payload['M/benchmarks/kaggle/pcn_checks.mjs'], harness['benchmarks/kaggle/pcn_checks.mjs'])
        self.assertEqual(payload['M/backend/a.sh'], b'a\nb\n')
        for group in ('H1', 'H3'):
            self.assertEqual(payload[f'{group}/{self.SCRIPT}'], b'#!/usr/bin/env bash\necho x\n')
        self.assertFalse(any(b'\r' in value for name, value in payload.items() if name.endswith('.sh')))
        with self.assertRaises(ValueError):
            nb.assemble_vm2({'benchmarks/kaggle/pcn_checks.mjs': b'x'}, {}, {}, harness)

    def test_the_packed_bundle_verifies_and_says_what_it_holds(self):
        raw, manifest = self.pack()
        sha = hashlib.sha256(raw).hexdigest()
        checked, values = nb.verified_members(raw, sha, nb.VM2_GROUPS, nb.VM2_FORMAT)
        self.assertEqual(checked, manifest)
        self.assertEqual(manifest['format'], nb.VM2_FORMAT)
        for key, expected in (('study', 'bridge-m-h-vm-v2'), ('mCommit', nb.M_COMMIT), ('h1Commit', 'h1'), ('h3Commit', 'h3'), ('h3ProductCommit', '4f1c0de'),
                              ('harnessFromWorktree', False), ('coreLayouts', {'H1': 'phase2', 'H3': 'workers'})):
            self.assertEqual(manifest[key], expected, key)
        # annotate() writes these keys of the manifest into evaluation.json (the in-bundle manifest cannot hold the hash of its own zip).
        self.assertTrue({'mCommit', 'h1Commit', 'h3Commit', 'h3ProductCommit', 'harnessFromWorktree', 'treeSha256'} <= set(manifest))
        self.assertIn('H1/backend/src/phase2/notificationWorker.ts', values)
        self.assertIn('H3/backend/src/workers/notification.ts', values)
        self.assertNotIn('H1/backend/src/workers/notification.ts', values)
        self.assertNotIn('H3/backend/src/phase2/notificationWorker.ts', values)
        self.assertEqual(values['H1/benchmarks/phase2/kaggle/stack.mjs'], values['H3/benchmarks/phase2/kaggle/stack.mjs'])
        for group in ('H1', 'H3'):
            self.assertEqual(values[f'{group}/{self.SCRIPT}'], b'#!/usr/bin/env bash\necho x\n')   # LF whatever the checkout did
        self.assertEqual(raw, self.pack()[0])   # the same inputs, the same bytes
        with self.assertRaises(ValueError):
            nb.verified_members(raw, sha, nb.VM_GROUPS, nb.VM_FORMAT)   # not a v1 bundle

    def test_a_tree_with_the_wrong_core_worker_layout_is_refused_with_BRIDGE_VM2_LAYOUT(self):
        for label, kwargs in (('H1 with the workers layout', {'h1_layout': 'workers'}), ('H3 with the phase2 layout', {'h3_layout': 'phase2'}),
                              ('both swapped', {'h1_layout': 'workers', 'h3_layout': 'phase2'})):
            with self.assertRaisesRegex(ValueError, 'BRIDGE_VM2_LAYOUT', msg=label):
                self.pack(**kwargs)
        with self.assertRaisesRegex(ValueError, r'BRIDGE_VM2_LAYOUT: H1 must have the phase2 .*found workers'):
            self.pack(h1_layout='workers')
        both = {**v2_files('phase2'), **v2_files('workers')}
        none = {'backend/a.ts': b'x'}
        for label, h3 in (('both layouts', both), ('no layout', none)):
            with self.assertRaisesRegex(ValueError, 'BRIDGE_VM2_LAYOUT', msg=label):
                nb.check_vm2_layouts({'H1': v2_files('phase2'), 'H3': h3})
        with self.assertRaisesRegex(ValueError, 'BRIDGE_VM2_LAYOUT'):   # one source of a layout is not the layout
            nb.check_vm2_layouts({'H1': {nb.CORE_LAYOUT_SOURCES['phase2'][0]: b''}, 'H3': v2_files('workers')})
        nb.check_vm2_layouts({'H1': v2_files('phase2'), 'H3': set(v2_files('workers'))})   # paths work as well as files

    def test_build_writes_the_bundle_and_a_record_that_was_not_run_and_refuses_a_bad_tree_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'bridge-m-h-vm-v2.zip'
            first, second = self.patches()
            with first, second:
                record = nb.build_vm2(target, 'h3', 'h1')
            raw = target.read_bytes()
            self.assertEqual((record['sha256'], record['bundleBytes'], record['execution']), (hashlib.sha256(raw).hexdigest(), len(raw), 'NOT_RUN'))
            self.assertEqual((record['study'], record['mCommit'], record['h1Commit'], record['h3Commit'], record['h3ProductCommit'], record['harnessFromWorktree']),
                             ('bridge-m-h-vm-v2', nb.M_COMMIT, 'h1', 'h3', '4f1c0de', False))
            self.assertEqual(json.loads(target.with_suffix('.manifest.json').read_text()), record)
            bad = Path(directory) / 'bad.zip'
            first, second = self.patches(h3_layout='phase2')
            with first, second, self.assertRaisesRegex(ValueError, 'BRIDGE_VM2_LAYOUT'):
                nb.build_vm2(bad, 'h3', 'h1')
            self.assertFalse(bad.exists() or bad.with_suffix('.manifest.json').exists())

    def test_the_worktree_must_match_head_unless_it_is_markdown_or_the_harness_asked_for(self):
        with self.assertRaisesRegex(ValueError, 'BRIDGE_H_WORKTREE_DIFFERS_FROM_HEAD'):
            self.pack('HEAD', 'h1', status=b' M backend/src/index.ts\n')
        raw, manifest = self.pack('HEAD', 'h1', status=b' M backend/README.md\n?? services/clinic/README.md\n')
        self.assertEqual((manifest['h3Commit'], manifest['harnessFromWorktree']), ('HEAD', False))
        # A harness file that differs from HEAD is the point of --worktree-harness (and says so in the manifest); a harness that is not in the commit is refused without it.
        raw, manifest = self.pack('HEAD', 'h1', status=b' M benchmarks/phase2/kaggle/stack.mjs\n', worktree_harness=True)
        self.assertTrue(manifest['harnessFromWorktree'])
        with self.assertRaisesRegex(ValueError, 'BRIDGE_H_WORKTREE_DIFFERS_FROM_HEAD'):
            self.pack('HEAD', 'h1', status=b' M benchmarks/phase2/kaggle/stack.mjs\n')
        with self.assertRaisesRegex(ValueError, 'BRIDGE_VM_HARNESS_NOT_IN_H3'):
            self.pack(harness=False)

    def test_the_real_tree_packs_with_both_layouts_when_the_commits_are_here(self):
        try:
            raw, manifest = nb.pack_vm2('HEAD', worktree_harness=True)
        except (ValueError, OSError, nb.subprocess.CalledProcessError) as error:
            self.skipTest('cannot pack here: ' + str(error)[:80])
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            names = set(archive.namelist())
            for group in ('H1', 'H3'):
                script = archive.read(f'{group}/{self.SCRIPT}')
                self.assertTrue(script.startswith(b'#!/usr/bin/env bash\n'))
                self.assertNotIn(b'\r', script)
        self.assertIn('H1/backend/src/phase2/notificationWorker.ts', names)
        self.assertIn('H3/backend/src/workers/notification.ts', names)
        self.assertEqual((manifest['format'], manifest['harnessFromWorktree'], manifest['h1Commit'][:7]), (nb.VM2_FORMAT, True, '2841d1b'))
        self.assertTrue(re.fullmatch(r'[0-9a-f]{40}', manifest['h3ProductCommit']))

    def test_the_product_commit_is_the_last_one_that_changed_the_product(self):
        try:
            product = nb.product_commit('HEAD')
            later = nb.git('diff', '--name-only', product, 'HEAD', '--', *nb.PRODUCT_PATHS, *nb.NOT_PRODUCT).decode().split()
        except (OSError, nb.subprocess.CalledProcessError):
            self.skipTest('no git here')
        self.assertRegex(product, r'^[0-9a-f]{40}$')
        self.assertEqual(later, [])   # nothing the bundle runs changed after it (harness and test commits do not move it)


class VmV2Verify(unittest.TestCase):
    """verify_tree reads the format of the bundle: v2 allows M, H1, H3, checks the layout of each H tree and is not a v1 check."""

    def tree(self, directory, files, fmt=None, **extra):
        listing = [{'path': k, 'bytes': len(v), 'sha256': hashlib.sha256(v).hexdigest()} for k, v in sorted(files.items())]
        header = {'format': fmt or nb.VM2_FORMAT, 'files': listing, 'mCommit': 'm', 'h1Commit': 'h1', 'h3Commit': 'h3', 'h3ProductCommit': 'p',
                  'treeSha256': hashlib.sha256(json.dumps(listing, separators=(',', ':')).encode()).hexdigest(), **extra}
        root = Path(directory)
        (root / 'bundle-manifest.json').write_text(json.dumps(header))
        for name, value in files.items():
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_bytes(value)
        return root

    def good(self):
        return {'M/backend/a.ts': b'a', **{'H1/' + k: v for k, v in v2_files('phase2').items()}, **{'H3/' + k: v for k, v in v2_files('workers').items()}}

    def test_a_v2_tree_is_verified_by_its_format(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = nb.verify_tree(self.tree(directory, self.good()))
            self.assertEqual((manifest['format'], manifest['h3Commit']), (nb.VM2_FORMAT, 'h3'))
            self.assertEqual(nb.verify_tree(directory, fmt=nb.VM2_FORMAT)['h1Commit'], 'h1')
            with self.assertRaisesRegex(ValueError, 'BRIDGE_FORMAT'):
                nb.verify_tree(directory, fmt=nb.VM_FORMAT)

    def test_a_v2_tree_with_a_group_of_v1_or_without_the_layout_is_refused(self):
        files = self.good()
        for label, items, fmt, error in (
                ('H0 group in v2', {**files, 'H0/backend/a.ts': b'x'}, None, 'BRIDGE_UNSAFE_PATH'),
                ('H3 group in v1', {'M/backend/a.ts': b'a', 'H3/backend/a.ts': b'x'}, nb.VM_FORMAT, 'BRIDGE_UNSAFE_PATH'),
                ('H3 has the phase2 layout', {k: v for k, v in files.items() if not k.startswith('H3/')} | {'H3/' + k: v for k, v in v2_files('phase2').items()}, None, 'BRIDGE_VM2_LAYOUT'),
                ('H1 has no layout', {k: v for k, v in files.items() if not k.startswith('H1/')}, None, 'BRIDGE_VM2_LAYOUT'),
                ('unknown format', files, 'bridge-m-h-vm-source-3', 'BRIDGE_FORMAT'),
                ('the Kaggle format', files, nb.FORMAT, 'BRIDGE_FORMAT')):
            with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, error, msg=label):
                nb.verify_tree(self.tree(directory, items, fmt))

    def test_a_tampered_or_padded_v2_tree_is_refused_like_a_v1_one(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.tree(directory, self.good())
            (root / 'H3/backend/src/workers/billing.ts').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'BRIDGE_FILE_HASH'):
                nb.verify_tree(root)
        with tempfile.TemporaryDirectory() as directory:
            root = self.tree(directory, self.good())
            (root / 'H1/backend/extra.js').write_bytes(b'x')
            with self.assertRaisesRegex(ValueError, 'BRIDGE_INVENTORY'):
                nb.verify_tree(root)


class VmV2BuilderCli(unittest.TestCase):
    """make_bridge_notebook.main: --vm builds the v2 bundle, --vm-study v1 the v1 one as before, the notebook stays the default."""

    def run_main(self, argv):
        with patch.object(nb, 'build_vm2', return_value={'study': 'v2'}) as v2, patch.object(nb, 'build_vm', return_value={'study': 'v1'}) as v1, \
                patch.object(nb, 'build', return_value={'study': 'notebook'}) as notebook, patch.object(nb, 'verify_tree') as verify, patch('builtins.print'):
            result = nb.main(argv)
        return result, v2, v1, notebook, verify

    def test_vm_builds_v2_with_h_commit_as_h3_and_the_2841d1b_default_for_h1(self):
        result, v2, v1, notebook, verify = self.run_main(['--vm'])
        self.assertEqual(result, {'study': 'v2'})
        v2.assert_called_once_with(nb.VM2_TARGET, 'HEAD', nb.H1_COMMIT, False)
        v1.assert_not_called(); notebook.assert_not_called()
        result, v2, v1, notebook, verify = self.run_main(['--vm', '--h-commit', 'abc', '--h1-commit', 'def', '--target', 'x.zip', '--worktree-harness'])
        v2.assert_called_once_with(Path('x.zip'), 'abc', 'def', True)

    def test_vm_study_v1_builds_v1_as_before(self):
        for argv in (['--vm', '--vm-study', 'v1'], ['--vm-study', 'v1']):
            result, v2, v1, notebook, verify = self.run_main(argv)
            self.assertEqual(result, {'study': 'v1'})
            v1.assert_called_once_with(nb.VM_TARGET, 'HEAD', nb.H0_COMMIT, False)
            v2.assert_not_called()
        result, v2, v1, notebook, verify = self.run_main(['--vm-study', 'v1', '--h-commit', 'abc', '--h0-commit', 'def'])
        v1.assert_called_once_with(nb.VM_TARGET, 'abc', 'def', False)
        self.assertEqual(self.run_main(['--vm', '--vm-study', 'v2'])[0], {'study': 'v2'})

    def test_the_commits_of_the_other_study_are_refused_and_the_notebook_is_untouched(self):
        with patch('sys.stderr', io.StringIO()):
            for argv in (['--vm', '--h0-commit', 'x'], ['--vm-study', 'v1', '--h1-commit', 'x'], ['--h1-commit', 'x'], ['--h0-commit', 'x'], ['--vm-study', 'v3']):
                with self.assertRaises(SystemExit, msg=argv):
                    self.run_main(argv)
        result, v2, v1, notebook, verify = self.run_main([])
        self.assertEqual(result, {'study': 'notebook'})
        notebook.assert_called_once_with(nb.TARGET, nb.V1_H_COMMIT, False, False)
        v1.assert_not_called(); v2.assert_not_called()

    def test_verify_extracted_prints_what_the_bundle_says_for_either_study(self):
        with patch.object(nb, 'verify_tree', return_value={'format': nb.VM2_FORMAT, 'files': [1, 2, 3], 'mCommit': 'm', 'h1Commit': 'a', 'h3Commit': 'b', 'h3ProductCommit': 'c'}), \
                patch('builtins.print') as printed:
            result = nb.main(['--verify-extracted', 'somewhere'])
        self.assertEqual(result, {'verified': True, 'format': nb.VM2_FORMAT, 'files': 3, 'mCommit': 'm', 'h1Commit': 'a', 'h3Commit': 'b', 'h3ProductCommit': 'c'})
        with patch.object(nb, 'verify_tree', return_value={'format': nb.VM_FORMAT, 'files': [1], 'mCommit': 'm', 'h0Commit': 'x', 'h1Commit': 'y'}), patch('builtins.print'):
            self.assertEqual(nb.main(['--verify-extracted', 'somewhere']), {'verified': True, 'format': nb.VM_FORMAT, 'files': 1, 'mCommit': 'm', 'h0Commit': 'x', 'h1Commit': 'y'})


class VmV2Export(unittest.TestCase):
    def test_the_export_carries_the_burst_files_and_nothing_private(self):
        for name in ('burst.json', 'burst.jsonl', 'manifest.json', 'resources.jsonl', 'requests.jsonl', 'http.csv'):
            self.assertIn(name, bs.EXPORT)
        for private in ('pg-activity.txt', 'context.json', 'ready.json', 'pcn-fixture.json', 'api.log', 'cqrs.jsonl'):
            self.assertNotIn(private, bs.EXPORT)
        with tempfile.TemporaryDirectory() as directory:
            root, private = Path(directory) / 'src', Path(directory) / 'private'
            member = private / 'members' / 'full-3-100-H3b'
            member.mkdir(parents=True)
            for name in ('manifest.json', 'burst.json', 'burst.jsonl', 'pg-activity.txt', 'ready.json', 'core.log'):
                (member / name).write_text('{}')
            (private / 'reports').mkdir()
            (private / 'reports' / 'evaluation.json').write_text('{}')
            (root / 'H3').mkdir(parents=True)
            (root / 'bundle-manifest.json').write_text('{}')
            study = bs.VmStudy2(root, private, Path(directory) / 'out', 'run-1', mode='smoke', progress=lambda text: None)
            exported = {name for source, name in study.exported()}
        self.assertEqual(exported, {'reports/evaluation.json', 'members/full-3-100-H3b/manifest.json', 'members/full-3-100-H3b/burst.json',
                                    'members/full-3-100-H3b/burst.jsonl', 'bundle-manifest.json'})

    def test_the_harness_changes_of_v2_name_what_the_study_changed_about_the_stack(self):
        text = ' '.join(bs.VM2_HARNESS_CHANGES)
        for needle in ('max_fails=0', 'proxy_next_upstream off', 'Notification worker', 'burst', 'pg_stat_activity', 'application_name', 'upstream clinic', 'worker_connections 4096'):
            self.assertIn(needle, text)


class VmRunScriptV2(unittest.TestCase):
    """vm_run.sh takes the v2 bundle: the study from its format, --study and --cut, the compare with the bundled copy, the network settings of the VM. The part that needs
    root and apt is not run here; this reads the script and runs only the argument checks, which stop before anything is installed."""

    @classmethod
    def setUpClass(cls):
        cls.raw = (HERE / 'vm_run.sh').read_bytes()
        cls.text = cls.raw.decode('utf-8')

    def test_it_is_lf_and_has_the_checks_of_v1_untouched(self):
        self.assertNotIn(b'\r', self.raw)
        self.assertTrue(self.raw.startswith(b'#!/usr/bin/env bash\n'))
        self.assertIn('set -Eeuo pipefail', self.text)
        self.assertEqual(self.text.count('sha256sum -c'), 1)
        self.assertLess(self.text.index('sha256sum -c'), self.text.index('apt-get'))
        self.assertLess(self.text.index('apt-get'), self.text.index('unzip -q "$WORK/bundle.zip"'))

    def test_the_study_follows_the_format_of_the_bundle_and_v2_needs_M_H1_H3(self):
        self.assertIn(f'{nb.VM_FORMAT}) BUNDLE_STUDY=v1; TREES=(M H0 H1); HARNESS_TREE=H1; PREFIX=bridge-vm;;', self.text)
        self.assertIn(f'{nb.VM2_FORMAT}) BUNDLE_STUDY=v2; TREES=(M H1 H3); HARNESS_TREE=H3; PREFIX=bridge-vm-v2;;', self.text)
        self.assertEqual(tuple(re.search(rf'{nb.VM2_FORMAT}\) .*TREES=\(([^)]*)\)', self.text).group(1).split()), nb.VM2_GROUPS)
        self.assertEqual(tuple(re.search(rf'{nb.VM_FORMAT}\) .*TREES=\(([^)]*)\)', self.text).group(1).split()), nb.VM_GROUPS)
        self.assertIn('"$WORK/src/bundle-manifest.json"', self.text)
        self.assertIn('--study $STUDY, but the bundle is the $BUNDLE_STUDY study', self.text)
        self.assertIn('bundle lacks $part', self.text)
        self.assertIn('unknown bundle format', self.text)
        # The default name of the results is decided once the study is known; the re-exec through sudo passes --out only when it was given.
        self.assertLess(self.text.index('FORMAT=$(python3 -I'), self.text.index('OUT=$(readlink -m "${OUT:-$PWD/$PREFIX-$STAMP}")'))
        self.assertIn('[ -z "$OUT" ] || ARGS+=(--out "$OUT")', self.text)
        self.assertIn('exec sudo bash "$(readlink -f "$0")" "${ARGS[@]}"', self.text)

    def test_v2_asks_bridge_study_for_study_v2_with_the_cuts_and_v1_stays_flag_free(self):
        self.assertIn('STUDY_ARGS=(--study v2)', self.text)
        self.assertIn('STUDY_ARGS+=(--cut "$cut")', self.text)
        self.assertIn('"${STUDY_ARGS[@]}"', self.text)
        self.assertLess(self.text.index('if [ "$BUNDLE_STUDY" = v2 ]; then\n  STUDY_ARGS=(--study v2)'), self.text.index('"$PY" "$WORK/src/$HARNESS_TREE/benchmarks/phase2/kaggle/bridge_study.py"'))
        self.assertNotIn('--study v1', self.text.replace('--study auto|v1|v2', ''))   # v1 bundles carry a bridge_study.py that does not know --study
        self.assertIn('--platform vm --root "$WORK/src"', self.text)
        self.assertLess(self.text.index('--verify-extracted'), self.text.index('bridge_study.py'))
        self.assertIn('make_bridge_notebook.py" --verify-extracted "$WORK/src"', self.text)
        self.assertIn('$WORK/src/$HARNESS_TREE/benchmarks/phase2/kaggle/make_bridge_notebook.py', self.text)

    def test_the_cuts_are_the_ones_the_study_knows_and_only_for_v2_full(self):
        listed = re.search(r'case "\$cut" in ([^)]*)\) ;;', self.text).group(1).split('|')
        self.assertEqual(tuple(listed), bs.CUTS)
        self.assertIn('[ "$MODE" = full ] || { echo "--cut is for --mode full" >&2; usage; }', self.text)
        self.assertIn('[ "$STUDY" != v1 ] || { echo "--cut is for the v2 study" >&2; usage; }', self.text)
        self.assertIn('--cut is for the v2 study; the bundle is $BUNDLE_STUDY', self.text)
        self.assertIn('[--cut x2-200] [--cut burst-short]', self.text)

    def test_results_of_v2_are_named_bridge_vm_v2_and_v1_ones_as_before(self):
        self.assertIn('PREFIX=bridge-vm-v2', self.text)
        self.assertIn('PREFIX=bridge-vm;', self.text)
        self.assertIn('TAR=$OUT.tar.gz', self.text)
        self.assertIn('$PWD/$PREFIX-$STAMP', self.text)

    def test_the_script_that_runs_is_compared_with_the_copy_in_the_bundle(self):
        self.assertIn('cmp -s "$0" "$WORK/src/$HARNESS_TREE/benchmarks/phase2/kaggle/vm_run.sh"', self.text)
        self.assertLess(self.text.index('--verify-extracted'), self.text.index('cmp -s "$0"'))   # the copy it is compared with has been verified
        self.assertLess(self.text.index('cmp -s "$0"'), self.text.index('python3 -m venv'))
        self.assertIn('if [ "$SCRIPT_MATCH" = no ] && [ "$BUNDLE_STUDY" = v2 ]; then', self.text)
        self.assertIn('exit 1', self.text[self.text.index('if [ "$SCRIPT_MATCH" = no ]'):self.text.index('python3 -m venv')])
        self.assertIn('vm_run_sh_is_the_bundled_copy=$SCRIPT_MATCH', self.text)
        self.assertIn('[ -f "$0" ]', self.text)   # a pipe has no copy to compare

    def test_vm_info_records_the_network_settings_that_matter_at_800_users(self):
        self.assertIn('sysctl net.ipv4.tcp_tw_reuse net.ipv4.ip_local_port_range', self.text)
        info = self.text[self.text.index('{\n  echo "started_utc='):self.text.index('} > "$OUT/vm-info.txt"')]
        for needle in ('sysctl net.ipv4.tcp_tw_reuse net.ipv4.ip_local_port_range', 'ss -s', 'study=$BUNDLE_STUDY', 'cuts=', 'bundle_sha256=$SHA'):
            self.assertIn(needle, info)
        self.assertIn('>> "$OUT/vm-info.txt"', self.text)   # and ss -s again after the study
        self.assertIn('procps iproute2', self.text)   # sysctl and ss exist in a minimal container too

    def run_arguments(self, *argv):
        bash = shutil.which('bash')
        if not bash:
            self.skipTest('no bash here')
        script = (HERE / 'vm_run.sh').as_posix()
        probe = subprocess.run([bash, '-c', 'test -f "$1"', 'probe', script], capture_output=True)
        if probe.returncode:
            self.skipTest('this bash does not read the path of the script')
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / 'bundle.zip'
            bundle.write_bytes(b'not a bundle')
            return subprocess.run([bash, script, '--bundle', bundle.as_posix(), '--sha256', '0' * 64, *argv], capture_output=True, text=True, timeout=60, cwd=directory)

    def test_bad_arguments_stop_with_usage_before_anything_runs(self):
        for argv, message in ((['--cut', 'nothing', '--mode', 'full'], 'unknown --cut nothing'), (['--cut', 'x2-200', '--mode', 'local'], '--cut is for --mode full'),
                              (['--cut', 'x2-200', '--mode', 'smoke'], '--cut is for --mode full'), (['--cut', 'x2-200', '--study', 'v1'], '--cut is for the v2 study'),
                              (['--study', 'v3'], 'usage:'), (['--cut'], 'usage:'), (['--study'], 'usage:')):
            result = self.run_arguments(*argv)
            self.assertEqual(result.returncode, 2, (argv, result.stderr))
            self.assertIn(message, result.stderr)
            self.assertIn('usage: sudo bash vm_run.sh', result.stderr)
            self.assertIn('[--study auto|v1|v2] [--cut x2-200] [--cut burst-short]', result.stderr)


if __name__ == '__main__':
    unittest.main()
