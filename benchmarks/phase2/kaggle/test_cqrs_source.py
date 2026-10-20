"""Source provenance and hostile-archive tests; never touch a database."""
import copy
import json
from pathlib import Path
import stat
import sys
import unittest
from uuid import uuid4
from unittest.mock import patch
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

sys.path.insert(0, str(Path(__file__).parent))
import cqrs_source as source


def write_zip(path, payload):
    with ZipFile(path, 'x', ZIP_DEFLATED) as archive:
        for name, data in payload.items():
            entry = ZipInfo(name)
            entry.external_attr = (stat.S_IFREG | 0o600) << 16
            archive.writestr(entry, data)


class SourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = source.REPO / 'test-results/phase2/cqrs/source-tests'
        root.mkdir(parents=True, exist_ok=True)
        cls.root = root / str(uuid4())
        cls.root.mkdir()
        cls.archive = cls.root / 'actual-source.zip'
        cls.receipt = source.make_bundle(source.REPO, cls.archive)
        cls.payload, cls.manifest, cls.sha = source.read_bundle(cls.archive)

    def test_actual_dirty_cqrs_files_match_worktree_and_O_matches_git_objects(self):
        for name in ('services/clinic/src/app.ts', 'services/clinic/src/readWorker.ts',
                     'services/clinic/src/infrastructure/queries/servingAppointments.ts',
                     'services/clinic/prisma/migrations/20261015000600_read_token_dedup/migration.sql',
                     'frontend/src/services/clinicReadState.ts', 'packages/messaging/src/index.ts'):
            self.assertEqual(self.payload['AB/' + name], (source.REPO / name).read_bytes(), name)
        self.assertNotIn('O/services/clinic/src/readWorker.ts', self.payload)
        for name in ('services/clinic/src/app.ts', 'package-lock.json'):
            self.assertEqual(self.payload['O/' + name], source.git(source.REPO, 'show', source.BASELINE + ':' + name))
        plan = json.loads(self.payload['plan.json'])
        self.assertEqual(plan['configurations']['A']['source_sha256'], plan['configurations']['B']['source_sha256'])
        self.assertNotEqual(plan['configurations']['O']['source_sha256'], plan['configurations']['A']['source_sha256'])

    def test_deterministic_archive_and_no_overwrite(self):
        second = self.root / 'second.zip'
        receipt = source.make_bundle(source.REPO, second)
        self.assertEqual(receipt['archive_sha256'], self.sha)
        with self.assertRaisesRegex(ValueError, 'OUTPUT_EXISTS'):
            source.make_bundle(source.REPO, second)
        self.assertEqual(source.digest(second.read_bytes()), self.sha)

    def test_scope_excludes_credentials_data_generated_and_unrelated_outputs(self):
        for name in ('backend/.env', 'services/clinic/.env.production', 'backend/uploads/x.png',
                     'backend/src/generated/x.ts', 'frontend/dist/index.html',
                     'backend/node_modules/x/package.json', 'backend/secret.pem',
                     'test-results/ready.json', '.git/config', 'benchmarks/phase2/old.ipynb',
                     'phase2-plan/evidence/private.json', 'frontend/vite.config.js'):
            self.assertFalse(source.selected(name), name)
        for name in ('services/clinic/src/readWorker.ts', 'services/clinic/prisma/schema.prisma',
                     'services/clinic/prisma/migrations/20261015000600_read_token_dedup/migration.sql',
                     'tools/vendor/braces/LICENSE', 'package-lock.json'):
            self.assertTrue(source.selected(name), name)
        for group in ('O', 'AB'):
            self.assertTrue(all(source.selected(row['path']) for row in self.manifest['sources'][group]['files']))

    def test_policy_and_schedule_keep_AB_BA_AB_both_workloads_and_no_fake_pass(self):
        plan = json.loads(self.payload['plan.json'])
        self.assertEqual(source.digest(self.payload['policy.json']), source.POLICY_SHA)
        for workload in ('pcn', 'query-heavy'):
            trials = [r for r in plan['trials'] if r['workload'] == workload]
            self.assertEqual([r['configuration'] for r in trials[:3]], list('OAB'))
            self.assertEqual([r['configuration'] for r in trials[3:6]], list('OOO'))
            self.assertEqual([r['configuration'] for r in trials[6:]], list('ABBAAB'))
            self.assertEqual([r['pair'] for r in trials[6:]], [1, 1, 2, 2, 3, 3])
        self.assertEqual(plan['pcn']['steadySeconds'], 1800)
        self.assertEqual(plan['pcn']['users'], 100)
        self.assertEqual(plan['query_heavy']['rate'], 12)
        self.assertEqual(plan['query_heavy']['steady_seconds'], 800)
        self.assertEqual(plan['status'], 'NOT_RUN')
        self.assertFalse(plan['capacity_accepted'])
        self.assertFalse(plan['automatic_retries'])
        self.assertTrue(plan['sequential'])
        self.assertTrue(all(plan['configurations'][m]['projector_enabled'] for m in 'AB'))
        self.assertFalse(any(c['shadow_enabled'] for c in plan['configurations'].values()))

    def test_roundtrip_verifies_bytes_and_refuses_existing_directory(self):
        destination = self.root / 'roundtrip'
        result = source.extract_bundle(self.archive, destination, self.sha)
        self.assertEqual(result['status'], 'EXTRACTED_AND_VERIFIED')
        self.assertEqual(result['measurements'], 'NOT_RUN')
        for name, data in self.payload.items():
            self.assertEqual((destination / name).read_bytes(), data, name)
        with self.assertRaisesRegex(ValueError, 'DESTINATION_EXISTS'):
            source.extract_bundle(self.archive, destination, self.sha)

    def test_expected_archive_hash_rejects_before_creating_destination(self):
        destination = self.root / 'wrong-hash'
        with self.assertRaisesRegex(ValueError, 'ARCHIVE_HASH'):
            source.extract_bundle(self.archive, destination, '0' * 64)
        self.assertFalse(destination.exists())

    def test_tampered_source_and_unrecorded_file_fail_inventory(self):
        for case in ('changed', 'extra', 'missing'):
            payload = dict(self.payload)
            if case == 'changed': payload['AB/services/clinic/src/app.ts'] += b'// altered'
            if case == 'extra': payload['AB/backend/.env'] = b'PRIVATE'
            if case == 'missing': del payload['AB/services/clinic/src/readWorker.ts']
            archive = self.root / (case + '.zip')
            write_zip(archive, payload)
            with self.assertRaisesRegex(ValueError, 'FILE_HASH_OR_INVENTORY'):
                source.verify_bundle(archive)

    def test_hostile_paths_duplicates_and_links_rejected_before_writing(self):
        for n, name in enumerate(('../escape', '/absolute', 'C:/escape', 'AB/../escape',
                                  'AB\\escape', 'AB/NUL.txt', 'AB/app.ts.', 'AB//app.ts')):
            with self.assertRaisesRegex(ValueError, 'PATH'):
                source.safe_path(name)
            payload = dict(self.payload); payload[name] = b'x'
            archive = self.root / f'path-{n}.zip'; write_zip(archive, payload)
            # ZipInfo itself normalizes backslashes on Windows; even then the
            # unrecorded member must fail before any extraction is attempted.
            with self.assertRaisesRegex(ValueError, 'Q6_SOURCE_'):
                source.verify_bundle(archive)
        archive = self.root / 'duplicate.zip'
        payload = dict(self.payload); payload['AB/PACKAGE.json'] = b'x'
        write_zip(archive, payload)
        with self.assertRaisesRegex(ValueError, 'DUPLICATE_PATH'):
            source.verify_bundle(archive)
        archive = self.root / 'link.zip'
        with ZipFile(archive, 'x') as z:
            info = ZipInfo('AB/link'); info.external_attr = (stat.S_IFLNK | 0o777) << 16
            z.writestr(info, '../../outside')
        with self.assertRaisesRegex(ValueError, 'ARCHIVE_FILE_TYPE'):
            source.verify_bundle(archive)

    def test_rehashed_manifest_still_cannot_relax_frozen_schedule(self):
        payload = dict(self.payload)
        plan = json.loads(payload['plan.json']); plan['pcn']['steadySeconds'] = 15
        payload['plan.json'] = source.canonical(plan)
        manifest = copy.deepcopy(self.manifest)
        del payload['manifest.json']; del manifest['sha256']
        manifest['files'] = source.entries(payload)
        manifest['sha256'] = source.digest(source.canonical(manifest))
        payload['manifest.json'] = source.canonical(manifest)
        archive = self.root / 'relaxed-plan.zip'; write_zip(archive, payload)
        with self.assertRaisesRegex(ValueError, 'PLAN_DRIFT'):
            source.verify_bundle(archive)

    def test_worktree_drift_during_pack_is_detected_before_publishing(self):
        current = source.worktree_files(source.REPO)
        changed = dict(current); changed['services/clinic/src/app.ts'] += b'// concurrent edit'
        destination = self.root / 'drift.zip'
        with patch.object(source, 'worktree_files', side_effect=[current, changed]):
            with self.assertRaisesRegex(ValueError, 'WORKTREE_CHANGED_DURING_PACK'):
                source.make_bundle(source.REPO, destination)
        self.assertFalse(destination.exists())

    def test_dependency_or_policy_change_cannot_silently_use_old_protocol(self):
        current = source.worktree_files(source.REPO)
        current['package-lock.json'] += b' '
        with patch.object(source, 'worktree_files', return_value=current):
            with self.assertRaisesRegex(ValueError, 'LOCKFILE_DRIFT'):
                source.make_bundle(source.REPO, self.root / 'lock-drift.zip')
        original_reader = source.source_bytes
        def drift(root, name):
            data = original_reader(root, name)
            return data + b' ' if name == 'phase2-plan/cqrs/acceptance.json' else data
        with patch.object(source, 'source_bytes', side_effect=drift):
            with self.assertRaisesRegex(ValueError, 'POLICY_DRIFT'):
                source.make_bundle(source.REPO, self.root / 'policy-drift.zip')

    def test_private_key_and_known_credential_patterns_never_export_values(self):
        root = self.root / 'private-fixture'; root.mkdir()
        path = root / 'test.ts'
        for value, code in [(b'-----BEGIN PRIVATE KEY-----', 'PRIVATE_KEY'),
                            (b'ghp_' + b'A' * 36, 'CREDENTIAL')]:
            path.write_bytes(value)
            with self.assertRaisesRegex(ValueError, code) as caught:
                source.source_bytes(root, 'test.ts')
            self.assertNotIn(value.decode(), str(caught.exception))


if __name__ == '__main__':
    unittest.main()
