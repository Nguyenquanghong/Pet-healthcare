import json
from pathlib import Path
import unittest
import datetime as dt
from load_runner import percentile, summarize, run_load, retry_after_seconds


class WriteFixture:
    """In-memory HTTP fixture for negative reconciliation tests, no DB access."""
    def __init__(self, duplicate=False, status=201):
        self.fixture = {'pets': [{'id': str(index)} for index in range(21)]}
        self.records = {}
        self.duplicate = duplicate
        self.status = status
        self.sequence = 0

    def request(self, method, path, body=None, role=None, key=None):
        if method == 'POST':
            self.sequence += 1
            identifier = 'same-id' if self.duplicate else str(self.sequence)
            record = dict(body, id=identifier, status='pending')
            self.records[identifier] = record
            return self.status, {'appointment': record}, {}
        return 200, {'items': list(self.records.values()),
                     'pagination': {'total': len(self.records), 'totalPages': 1}}, {}

    def metrics(self):
        return []


class MetricsTests(unittest.TestCase):
    def test_multiple_actors_reconcile_separate_owned_lists(self):
        class MultiFixture(WriteFixture):
            def __init__(self):
                super().__init__()
                self.actors = [{'role': 'owner_a', 'pets': [{'id': 'pet_a'}]},
                               {'role': 'owner_b', 'pets': [{'id': 'pet_b'}]}]
                self.seen = set()
            def request(self, method, path, body=None, role=None, key=None):
                self.seen.add(role)
                if method == 'POST':
                    return super().request(method, path, body, role, key)
                pet = 'pet_a' if role == 'owner_a' else 'pet_b'
                records = [r for r in self.records.values() if r['petId'] == pet]
                return 200, {'items': records, 'pagination': {'total': len(records), 'totalPages': 1}}, {}
        fixture = MultiFixture()
        result = run_load(fixture, profile='clinic_write', users=2, seconds=1,
                          max_requests=4, think_seconds=.01, allow_writes=True)
        self.assertEqual(fixture.seen, {'owner_a', 'owner_b'})
        self.assertEqual(result['reconciliation']['status'], 'PASS_IN_SCOPE')
        self.assertEqual(result['reconciliation']['after'], 4)

    def run_fixture(self, fixture):
        return run_load(fixture, profile='clinic_write', users=1, seconds=1,
                        max_requests=2, think_seconds=0, allow_writes=True)

    def test_distinct_successful_writes_reconcile(self):
        report = self.run_fixture(WriteFixture())
        self.assertEqual(report['reconciliation']['status'], 'PASS_IN_SCOPE')
        self.assertEqual(len(report['created_ids']), 2)

    def test_duplicate_write_response_ids_cannot_pass_reconciliation(self):
        report = self.run_fixture(WriteFixture(duplicate=True))
        self.assertEqual(report['duplicate_returned_ids'], 1)
        self.assertEqual(report['reconciliation']['status'], 'REVIEW_REQUIRED')

    def test_error_response_id_is_not_counted_as_successful_write(self):
        report = self.run_fixture(WriteFixture(status=500))
        self.assertEqual(report['created_ids'], [])
        self.assertEqual(report['reconciliation']['status'], 'REVIEW_REQUIRED')

    def test_retry_after_is_case_insensitive_and_bounded_by_measurement(self):
        self.assertEqual(retry_after_seconds({'ReTrY-AfTeR': '7'}, remaining=30), 7)
        self.assertEqual(retry_after_seconds({'Retry-After': '60'}, remaining=3), 3)
        self.assertEqual(retry_after_seconds({'Retry-After': '7'}, remaining=-1), 0)

    def test_bad_retry_after_cannot_crash_or_sleep_forever(self):
        for raw in ['-7', 'NaN', 'Infinity', 'garbage', '', None]:
            with self.subTest(raw=raw):
                self.assertEqual(retry_after_seconds({'Retry-After': raw}, remaining=30), 1)
        self.assertEqual(retry_after_seconds({}, remaining=.2), .2)

    def test_retry_after_http_date_and_past_date(self):
        now = dt.datetime(2026, 10, 13, 0, 0, tzinfo=dt.timezone.utc)
        self.assertEqual(retry_after_seconds({'retry-after': 'Tue, 13 Oct 2026 00:00:07 GMT'}, remaining=30, now=now), 7)
        self.assertEqual(retry_after_seconds({'retry-after': 'Tue, 13 Oct 2026 00:00:00 GMT'}, remaining=30, now=now), 0)

    def test_empty_samples_do_not_invent_latency_or_pass(self):
        self.assertIsNone(percentile([], .95))
        self.assertEqual(summarize([], 10), [])

    def test_rejections_and_fast_errors_do_not_inflate_success(self):
        rows = [dict(operation='read', outcome='success', status=200, latency_ms=900),
                dict(operation='read', outcome='rate_limited', status=429, latency_ms=5),
                dict(operation='read', outcome='overload', status=503, latency_ms=2),
                dict(operation='read', outcome='transport_error', status=0, latency_ms=15000)]
        summary = summarize(rows, 10)[0]
        self.assertEqual(summary['successful_rps'], .1)
        self.assertEqual(summary['success_ratio'], .25)
        self.assertEqual(summary['rate_429'], .25)
        self.assertEqual(summary['rate_503'], .25)
        self.assertEqual(summary['unexpected_error_rate'], .5)
        self.assertEqual(summary['p95_ms_all'], 15000)
        self.assertEqual(summary['p95_ms_success'], 900)

    def test_percentile_nearest_rank(self):
        self.assertEqual(percentile(list(range(1, 101)), .95), 95)

    def test_mutating_profile_requires_explicit_opt_in_before_http(self):
        with self.assertRaisesRegex(ValueError, 'allow_writes'):
            run_load(None, profile='clinic_write')

    def test_notebook_cells_compile_and_contain_no_saved_outputs(self):
        notebook = json.loads(Path(__file__).with_name('phase2-load.ipynb').read_text(encoding='utf-8'))
        ids = [cell['id'] for cell in notebook['cells']]
        self.assertEqual(len(ids), len(set(ids)))
        for cell in notebook['cells']:
            if cell['cell_type'] == 'code':
                compile(''.join(cell['source']), cell['id'], 'exec')
                self.assertIsNone(cell['execution_count'])
                self.assertEqual(cell['outputs'], [])


if __name__ == '__main__':
    unittest.main()
