import ast
import base64
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
from uuid import uuid4
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).parent))
from cqrs_source import REPO, make_bundle, read_bundle
from make_cqrs_notebook import build


class NotebookTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = REPO / 'test-results/phase2/cqrs/q6-notebook-tests' / str(uuid4())
        cls.root.mkdir(parents=True)
        cls.archive = cls.root / 'source.zip'
        cls.receipt = make_bundle(REPO, cls.archive)
        cls.historical = {name: (REPO / 'benchmarks/phase2' / name).read_bytes() for name in (
            'cqrs-q0-query-heavy.ipynb', 'cqrs-q0-pcn-baseline.ipynb', 'phase2-pcn-kaggle.ipynb')}
        cls.target = cls.root / 'q6.ipynb'
        cls.result = build(cls.archive, cls.receipt['archive_sha256'], cls.target)
        cls.notebook = json.loads(cls.target.read_text(encoding='utf-8'))

    def test_cells_compile_source_is_pinned_and_smoke_is_default(self):
        nb = self.notebook
        self.assertFalse(self.result['executed']); self.assertFalse(self.result['default_full'])
        for cell in nb['cells']:
            if cell['cell_type'] == 'code':
                ast.parse(''.join(cell['source']))
                self.assertEqual(cell['outputs'], []); self.assertIsNone(cell['execution_count'])
        tree = ast.parse(''.join(nb['cells'][1]['source']))
        constants = {node.targets[0].id: ast.literal_eval(node.value) for node in tree.body
                     if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                     and node.targets[0].id in ('RUN_FULL', 'SOURCE_SHA256', 'SOURCE_BASE64')}
        self.assertFalse(constants['RUN_FULL'])
        raw = base64.b64decode(constants['SOURCE_BASE64'], validate=True)
        self.assertEqual(raw, self.archive.read_bytes())
        self.assertEqual(hashlib.sha256(raw).hexdigest(), constants['SOURCE_SHA256'])
        self.assertNotIn('.extractall(', ''.join(nb['cells'][1]['source']))
        self.assertNotIn("['git','clone'", ''.join(nb['cells'][1]['source']))
        for name, data in self.historical.items():
            self.assertEqual((REPO / 'benchmarks/phase2' / name).read_bytes(), data)

    def test_invalid_bundle_or_existing_output_cannot_be_overwritten(self):
        old = self.target.read_bytes()
        with self.assertRaises(ValueError):
            build(self.archive, '0' * 64, self.root / 'bad.ipynb')
        self.assertFalse((self.root / 'bad.ipynb').exists())
        with self.assertRaises(FileExistsError):
            build(self.archive, self.receipt['archive_sha256'], self.target)
        self.assertEqual(self.target.read_bytes(), old)

    def test_export_keeps_failure_and_raw_hashes_but_excludes_private_artifacts(self):
        output = self.root / 'export'; trial = output / 'query-heavy/trials/smoke-B'
        trial.mkdir(parents=True)
        (trial / 'report.json').write_text('{"status":"FAIL"}')
        (trial / 'requests.jsonl').write_text('{"status":503}\n')
        (trial / 'read-diagnostics.jsonl').write_text('{"event":"projection_failure","sqlState":"57014"}\n')
        (trial / 'query-plans.json').write_text('{"status":"PARTIAL","capacityAccepted":false}')
        (trial / 'clinic-0.log').write_text('PRIVATE')
        (trial / 'context.json').write_text('PRIVATE')
        (trial / 'ready.json').write_text('PRIVATE')
        (output / 'setup.log').write_text('PRIVATE')
        (output / 'source.zip').write_bytes(b'PRIVATE')
        namespace = {'OUTPUT': output, 'WORKLOADS': ['query-heavy'], 'SOURCE_SHA256': self.receipt['archive_sha256'],
                     'json': json, 'hashlib': hashlib, 'ZipFile': ZipFile, 'ZIP_DEFLATED': 8,
                     'display': lambda value: None, 'FileLink': str}
        with contextlib.redirect_stdout(io.StringIO()):
            exec(''.join(self.notebook['cells'][7]['source']), namespace)
        with ZipFile(output.with_suffix('.zip')) as archive:
            self.assertEqual(set(archive.namelist()), {'query-heavy/trials/smoke-B/report.json',
                'query-heavy/trials/smoke-B/requests.jsonl', 'query-heavy/trials/smoke-B/read-diagnostics.jsonl', 'query-heavy/trials/smoke-B/query-plans.json', 'result-manifest.json'})
            self.assertTrue(all(b'PRIVATE' not in archive.read(name) for name in archive.namelist()))
            manifest = json.loads(archive.read('result-manifest.json'))
            self.assertFalse(manifest['capacity_accepted'])
            for row in manifest['files']:
                self.assertEqual(hashlib.sha256(archive.read(row['path'])).hexdigest(), row['sha256'])


if __name__ == '__main__': unittest.main()
