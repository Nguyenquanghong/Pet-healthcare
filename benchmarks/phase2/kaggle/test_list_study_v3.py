"""cqrs-list-matched-kaggle-v3 tests: bundle v11, shared read-limit patch,
policy, controller rebinding, notebook validator and review; local files only."""
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

import cqrs_source as q6
import list_source_v3
import make_list_policy_v3
import make_list_notebook_v3 as nb3

REPO = make_list_policy_v3.REPO
V2_POLICY = json.loads(make_list_policy_v3.V2.read_text(encoding='utf-8'))


class BundleV11Test(unittest.TestCase):
    def setUp(self):
        self.archive = zipfile.ZipFile(REPO / make_list_policy_v3.BUNDLE)
        self.manifest = json.loads(self.archive.read('manifest.json'))

    def test_pinned_reader_accepts_v11(self):
        self.assertEqual(q6.verify_bundle(REPO / make_list_policy_v3.BUNDLE, make_list_policy_v3.BUNDLE_SHA)['status'], 'SOURCE_INTEGRITY_VERIFIED')

    def test_read_limit_patch_is_identical_in_o_and_ab_and_only_there(self):
        for group in ('O', 'AB'):
            http = self.archive.read(f'{group}/packages/runtime/src/http.ts').decode()
            self.assertIn(list_source_v3.READ_LIMIT_NEW, http); self.assertNotIn(list_source_v3.READ_LIMIT_OLD, http)
        patches = self.manifest['v3']['sharedEnvironmentPatch']['patches']
        self.assertEqual([p['group'] for p in patches], ['O', 'AB'])
        self.assertEqual({(p['from'], p['to']) for p in patches}, {(list_source_v3.READ_LIMIT_OLD, list_source_v3.READ_LIMIT_NEW)})
        v10 = json.loads(zipfile.ZipFile(REPO / 'test-results/phase2/cqrs/list-v2/cqrs-list-source-v10.zip').read('manifest.json'))
        files = lambda m, g: {f['path']: f['sha256'] for f in m['sources'][g]['files']}
        self.assertEqual([p for p, s in files(self.manifest, 'O').items() if files(v10, 'O').get(p) != s], ['packages/runtime/src/http.ts'])
        self.assertEqual(sorted(p for p, s in files(self.manifest, 'AB').items() if files(v10, 'AB').get(p) != s),
                         ['packages/runtime/src/http.ts', 'services/clinic/src/app.ts', 'services/clinic/src/index.ts', 'services/clinic/src/readFreshness.ts'])
        self.assertEqual(self.manifest['sources']['harness'], v10['sources']['harness'])

    def test_ab_keeps_v2_fixes_adds_f4_and_excludes_eb(self):
        ab = lambda p: self.archive.read('AB/' + p).decode()
        self.assertIn('lane,perAggregateLag:true', ab('services/clinic/src/index.ts'))
        self.assertIn('batchSize', ab('services/clinic/src/relay.ts'))
        self.assertIn('PROJECTED_STATEMENT_MAX_MS=1000', ab('services/clinic/src/infrastructure/queries/servingAppointments.ts'))
        self.assertNotIn("group:'public-rescue'", ab('packages/runtime/src/http.ts'))

    def test_patch_fails_closed_when_expression_is_not_unique(self):
        with self.assertRaisesRegex(ValueError, 'V3_READ_LIMIT_NOT_FOUND_ONCE_O'):
            list_source_v3.raise_read_limit({'packages/runtime/src/http.ts': b'no limiter'}, 'O')


class PolicyV3Test(unittest.TestCase):
    def setUp(self):
        self.policy = json.loads(make_list_policy_v3.TARGET.read_text(encoding='utf-8'))

    def test_thresholds_contract_and_diagnostics_equal_v2(self):
        for key in make_list_policy_v3.UNCHANGED:
            self.assertEqual(self.policy[key], V2_POLICY[key], key)

    def test_identity_and_sources(self):
        self.assertEqual(self.policy['study'], 'cqrs-list-matched-kaggle-v3')
        self.assertEqual(self.policy['derivedFrom']['sha256'], make_list_policy_v3.V2_SHA)
        self.assertEqual(self.policy['sources']['AB_list']['sourceBundleSha256'], make_list_policy_v3.BUNDLE_SHA)
        self.assertEqual(self.policy['sources']['O']['gitSha'], V2_POLICY['sources']['O']['gitSha'])
        self.assertEqual(make_list_policy_v3.policy(), self.policy)
        with self.assertRaisesRegex(ValueError, 'LIST_POLICY_ALREADY_EXISTS'):
            make_list_policy_v3.build()


class ControllerAndNotebookV3Test(unittest.TestCase):
    def test_rebinding(self):
        import list_study_v3 as s3
        self.assertEqual((s3.base.STUDY, s3.base.BUNDLE_SHA), ('cqrs-list-matched-kaggle-v3', make_list_policy_v3.BUNDLE_SHA))
        self.assertEqual(s3.base.POLICY, make_list_policy_v3.TARGET.relative_to(REPO).as_posix())
        self.assertIs(s3.base.Study, s3.Study)
        self.assertTrue(set(s3.base.CONTROLLER) <= set(nb3.STUDY_FILES))

    def test_archive_validator(self):
        raw, _ = nb3.source_bundle()
        manifest, values = nb3.verified_members(raw, nb3.digest(raw))
        self.assertEqual(manifest['study'], 'cqrs-list-matched-kaggle-v3')
        self.assertIn('benchmarks/phase2/kaggle/list_study_v3.py', values)
        self.assertIn('benchmarks/phase2/kaggle/list_study_v2.py', values, 'v3 controller imports v2')
        with self.assertRaisesRegex(ValueError, 'LIST_BUNDLE_HASH_MISMATCH'):
            nb3.verified_members(raw, '0' * 64)

    def test_review_refuses_other_versions(self):
        import list_review_v3 as r3
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / 'summary.json').write_text(json.dumps({'study': 'cqrs-list-matched-kaggle-v2'}), encoding='utf-8')
            with self.assertRaises(SystemExit):
                r3.require_v2(tmp)
            (Path(tmp) / 'summary.json').write_text(json.dumps({'study': 'cqrs-list-matched-kaggle-v3'}), encoding='utf-8')
            r3.require_v2(tmp)


if __name__ == '__main__':
    unittest.main()
