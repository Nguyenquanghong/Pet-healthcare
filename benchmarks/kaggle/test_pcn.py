"""Acceptance guards and notebook/export checks; no app DB or Kaggle required."""
import ast
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from pcn_contract import load_verdict, percentile, report
from pcn_export import export_evidence


def full_load():
    return {'completed': True, 'requests': 1000, 'started_requests': 1000,
            'observed_user_min': 100, 'observed_user_max': 100, 'measured_seconds': 1800, 'error_rate': 0,
            'endpoints': [{'name': name, 'requests': 125, 'p95_ms': 50, 'within_2s_success_ratio': 1}
                          for name in ('GET pets', 'GET appointments', 'GET medical by pet', 'GET hotel',
                                       'GET invoices', 'GET notifications', 'POST appointment', 'POST rescue report')]}


class PcnTests(unittest.TestCase):
    def test_full_duration_and_population_are_required(self):
        data = full_load()
        self.assertEqual(load_verdict(data, kaggle=True)['PCN02'], 'PASS_IN_SCOPE')
        for key, value in [('measured_seconds', 120), ('observed_user_min', 99), ('observed_user_max', 101),
                           ('completed', False), ('started_requests', 1001)]:
            changed = {**data, key: value}
            self.assertEqual(load_verdict(changed, kaggle=True)['PCN02'], 'PARTIAL', key)
        self.assertEqual(load_verdict(data, kaggle=False)['PCN01'], 'PARTIAL')

    def test_slow_single_endpoint_cannot_hide_in_fast_aggregate(self):
        data = full_load()
        data['endpoints'][2]['p95_ms'] = 2001
        self.assertEqual(load_verdict(data, kaggle=True)['PCN01'], 'FAIL')
        data['endpoints'][2]['p95_ms'] = 50
        data['endpoints'][2]['within_2s_success_ratio'] = 0.94
        self.assertEqual(load_verdict(data, kaggle=True)['PCN01'], 'FAIL')

    def test_missing_write_workload_is_not_a_pass(self):
        data = full_load()
        data['endpoints'].pop()
        self.assertEqual(load_verdict(data, kaggle=True)['PCN01'], 'FAIL')
        data = full_load()
        data['endpoints'] = [item for item in data['endpoints'] if item['name'] != 'GET invoices']
        self.assertEqual(load_verdict(data, kaggle=True)['PCN01'], 'FAIL')

    def test_error_limit_boundary(self):
        self.assertEqual(load_verdict({**full_load(), 'error_rate': 0.01}, kaggle=True)['PCN02'], 'PASS_IN_SCOPE')
        self.assertEqual(load_verdict({**full_load(), 'error_rate': 0.01001}, kaggle=True)['PCN02'], 'FAIL')

    def test_raw_percentile_does_not_round_down_the_2s_boundary(self):
        self.assertEqual(percentile([2000.1] * 100), 2000.1)
        self.assertIsNone(percentile([]))

    def test_backup_lab_does_not_certify_daily_operations(self):
        summary = report(backup={'restore_passed': True, 'restore_seconds': 5, 'retained_backups': 7})
        self.assertEqual(summary['requirements']['PCN07']['status'], 'PARTIAL')
        self.assertEqual(summary['overall'], 'PARTIAL')
        failed = report(backup={'restore_passed': True, 'restore_seconds': 1801, 'retained_backups': 7})
        self.assertEqual(failed['requirements']['PCN07']['status'], 'FAIL')

    def test_restart_requires_all_twenty_records(self):
        self.assertEqual(report(restart={'passed': True, 'count': 19})['requirements']['PCN06']['status'], 'FAIL')
        self.assertEqual(report(restart={'passed': True, 'count': 20})['requirements']['PCN06']['status'], 'PASS_IN_SCOPE')

    def test_notebook_default_cannot_be_the_old_120_second_run(self):
        notebook = json.loads(Path(__file__).with_name('notebook_pcn.ipynb').read_text(encoding='utf-8'))
        for cell in notebook['cells']:
            if cell['cell_type'] == 'code':
                ast.parse(''.join(cell['source']))
                self.assertEqual(cell.get('outputs'), [])
        source = '\n'.join(''.join(c['source']) for c in notebook['cells'])
        self.assertIn('pcn_runner.py', source)
        self.assertNotIn('--local-smoke', source)
        self.assertIn('1800', source)
        self.assertIn('finally:', source)

    def test_early_failure_still_exports_logs_and_no_pass(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            root = Path(temporary)
            folder = root / 'failed-evidence'
            folder.mkdir()
            (folder / 'runner.log').write_text('Database prerequisite missing', encoding='utf-8')
            archive = export_evidence(folder, root)
            with zipfile.ZipFile(archive) as zipped:
                status = json.loads(zipped.read('failed-evidence/export-status.json'))
                self.assertEqual(status['overall'], 'PARTIAL_OR_FAILED')
                self.assertIn('failed-evidence/runner.log', zipped.namelist())

    def test_private_files_are_excluded_and_reexport_preserves_original_zip(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            root = Path(temporary)
            folder = root / 'evidence'
            folder.mkdir()
            for name in ('fixture.json', 'snapshot.json', '.env', 'backup.dump'):
                (folder / name).write_text('private-value', encoding='utf-8')
            (folder / 'setup.log').write_text('postgresql://user:private@localhost/db Bearer secret.token.value JWT_SECRET=hidden', encoding='utf-8')
            first = export_evidence(folder, root)
            original = first.read_bytes()
            second = export_evidence(folder, root)
            self.assertNotEqual(first, second)
            self.assertEqual(first.read_bytes(), original)
            with zipfile.ZipFile(second) as zipped:
                self.assertFalse(any(name.endswith(('fixture.json', 'snapshot.json', '.env', '.dump')) for name in zipped.namelist()))
                log = zipped.read('evidence/setup.log').decode()
                for secret in ('private@', 'secret.token.value', 'hidden'):
                    self.assertNotIn(secret, log)


if __name__ == '__main__':
    unittest.main()
