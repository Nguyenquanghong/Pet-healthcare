"""cqrs-list-matched-kaggle-v2 tests: bundle v10, policy, controller rebinding,
diagnostics sampler and review; synthetic data and local files only."""
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

import cqrs_source as q6
import list_source_v2
import make_list_policy_v2
import make_list_notebook_v2 as nb2

REPO = make_list_policy_v2.REPO
V1_POLICY = json.loads(make_list_policy_v2.V1.read_text(encoding='utf-8'))
V2_POLICY_PATH = make_list_policy_v2.TARGET


class BundleV10Test(unittest.TestCase):
    def test_pinned_reader_accepts_v10_and_o_harness_equal_v9(self):
        result = q6.verify_bundle(REPO / make_list_policy_v2.BUNDLE, make_list_policy_v2.BUNDLE_SHA)
        self.assertEqual(result['status'], 'SOURCE_INTEGRITY_VERIFIED')
        v9 = json.loads(zipfile.ZipFile(REPO / 'test-results/phase2/cqrs/q6-cold-parts-20261019/cqrs-q6-source-v9.zip').read('manifest.json'))
        v10 = json.loads(zipfile.ZipFile(REPO / make_list_policy_v2.BUNDLE).read('manifest.json'))
        self.assertEqual(v10['sources']['O'], v9['sources']['O'])
        self.assertEqual(v10['sources']['harness'], v9['sources']['harness'])

    def test_ab_has_fixes_and_excludes_only_eb(self):
        archive = zipfile.ZipFile(REPO / make_list_policy_v2.BUNDLE)
        http = archive.read('AB/' + list_source_v2.RUNTIME_HTTP).decode()
        self.assertNotIn("group:'public-rescue'", http)
        self.assertIn('acceptRequestId', http, 'D request-id change kept')
        self.assertNotIn('AB/' + list_source_v2.EB_TEST, archive.namelist())
        self.assertIn('batchSize', archive.read('AB/services/clinic/src/relay.ts').decode())
        self.assertIn('PROJECTED_STATEMENT_MAX_MS=1000', archive.read('AB/services/clinic/src/infrastructure/queries/servingAppointments.ts').decode())
        manifest = json.loads(archive.read('manifest.json'))
        exclusion = manifest['v2']['abExclusions']
        self.assertEqual([f['path'] for f in exclusion['patchedFiles']], [list_source_v2.RUNTIME_HTTP])
        self.assertEqual([f['path'] for f in exclusion['removedFiles']], [list_source_v2.EB_TEST])
        self.assertEqual(manifest['worktree_head'], q6.BASELINE)
        self.assertNotEqual(manifest['v2']['actualGitHead'], q6.BASELINE)

    def test_exclusion_fails_closed_when_branch_is_missing(self):
        with self.assertRaisesRegex(ValueError, 'V2_EB_BRANCH_NOT_FOUND_ONCE'):
            list_source_v2.exclude_eb({list_source_v2.RUNTIME_HTTP: b'no limiter here', list_source_v2.EB_TEST: b'x'})
        twice = (list_source_v2.EB_BRANCH * 2).encode()
        with self.assertRaisesRegex(ValueError, 'V2_EB_BRANCH_NOT_FOUND_ONCE'):
            list_source_v2.exclude_eb({list_source_v2.RUNTIME_HTTP: twice, list_source_v2.EB_TEST: b'x'})


class PolicyV2Test(unittest.TestCase):
    def setUp(self):
        self.policy = json.loads(V2_POLICY_PATH.read_text(encoding='utf-8'))

    def test_thresholds_blocks_and_contract_are_v1_verbatim(self):
        for key in make_list_policy_v2.UNCHANGED:
            self.assertEqual(self.policy[key], V1_POLICY[key], key)
        self.assertEqual(self.policy['acceptance']['readPathImprovement']['medianPairedBtoAP95RatioMax'], 0.8)

    def test_identity_source_and_diagnostics_declared(self):
        self.assertEqual(self.policy['study'], 'cqrs-list-matched-kaggle-v2')
        self.assertEqual(self.policy['sources']['AB_list']['sourceBundleSha256'], make_list_policy_v2.BUNDLE_SHA)
        self.assertEqual(self.policy['derivedFrom']['sha256'], make_list_policy_v2.V1_SHA)
        self.assertIn('diagnostics sampler', self.policy['accounting']['measuredWindowObservation'])
        self.assertEqual(self.policy['diagnostics']['grading'], 'diagnostic only; never used for grading or replacement decisions')

    def test_regeneration_matches_frozen_file_and_refuses_overwrite(self):
        self.assertEqual(make_list_policy_v2.policy(), self.policy)
        with self.assertRaisesRegex(ValueError, 'LIST_POLICY_ALREADY_EXISTS'):
            make_list_policy_v2.build()


class ControllerV2Test(unittest.TestCase):
    def test_rebinding_and_member_files(self):
        import list_study_v2 as s2
        self.assertEqual(s2.base.STUDY, 'cqrs-list-matched-kaggle-v2')
        self.assertEqual(s2.base.BUNDLE_SHA, make_list_policy_v2.BUNDLE_SHA)
        self.assertEqual(s2.base.POLICY, V2_POLICY_PATH.relative_to(REPO).as_posix())
        self.assertTrue(issubclass(s2.base.Study, s2.base.Study.__mro__[1]) and s2.base.Study is s2.Study)
        self.assertTrue(set(s2.DIAGNOSTIC_FILES) <= set(s2.base.MEMBER_FILES))
        self.assertTrue(set(s2.base.CONTROLLER) <= set(nb2.STUDY_FILES), 'harness digest files must ship in the notebook bundle')

    def test_sampler_tails_filters_redacts_and_survives_bad_lines(self):
        import list_study_v2 as s2
        with tempfile.TemporaryDirectory() as tmp:
            stack, out = Path(tmp) / 'pet-phase2-kaggle-x', Path(tmp) / 'out'
            stack.mkdir(); out.mkdir()
            pg, clinic = stack / 'postgres.log', stack / 'clinic-0.log'
            pg.write_text('LOG:  checkpoint starting: time\nLOG:  connection received\nERROR:  canceling statement due to statement timeout\n'
                          'STATEMENT:  SELECT 1 FROM x WHERE url=\'postgresql://u:p@h/db\'\npartial line without newline', encoding='utf-8')
            clinic.write_text('{"route":"/api/appointments","status":200}\nCLINIC_READ_DIAGNOSTIC {"event":"projection_failure","reason":"query_error","sqlState":"57014"}\n'
                              'CLINIC_READ_DIAGNOSTIC {not json\n', encoding='utf-8')
            sampler = s2.MemberDiagnostics(out, [], {})
            sampler.tick(stack)
            with pg.open('a', encoding='utf-8') as handle:
                handle.write('\nLOG:  checkpoint complete: wrote 10 buffers\n')
            sampler.tick(stack)
            lines = [json.loads(l) for l in (out / 'postgres-log.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertEqual([l.get('line', 'REDACTED')[:24] for l in lines],
                             ['LOG:  checkpoint startin', 'ERROR:  canceling statem', 'REDACTED', 'LOG:  checkpoint complet'])
            self.assertEqual(lines[2], {'redacted': True})
            reads = [json.loads(l) for l in (out / 'clinic-read-diagnostics.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertEqual(reads[0]['sqlState'], '57014'); self.assertEqual(reads[0]['instance'], 'clinic-0')
            self.assertEqual(reads[1], {'instance': 'clinic-0', 'unparsed': True})
            samples = [json.loads(l) for l in (out / 'diagnostics.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertEqual(len(samples), 2); self.assertNotIn('clinicOutbox', samples[0], 'no socket -> no queries')
            exported = (out / 'postgres-log.jsonl').read_text(encoding='utf-8') + (out / 'clinic-read-diagnostics.jsonl').read_text(encoding='utf-8')
            self.assertIsNone(s2.base.SECRET.search(exported), 'sampler output passes the export secret scan')

    def test_sampler_ignores_stacks_that_existed_before_the_member(self):
        import list_study_v2 as s2
        sampler = s2.MemberDiagnostics(Path(tempfile.gettempdir()) / 'unused', ['pet-phase2-kaggle-old'], {})
        self.assertIn('pet-phase2-kaggle-old', sampler.existing)


class NotebookV2Test(unittest.TestCase):
    def test_archive_validator_accepts_and_rejects_tampering(self):
        raw, manifest = nb2.source_bundle()
        sha = nb2.digest(raw)
        checked, values = nb2.verified_members(raw, sha)
        self.assertEqual(checked['study'], 'cqrs-list-matched-kaggle-v2')
        self.assertIn('benchmarks/phase2/kaggle/list_study_v2.py', values)
        self.assertEqual(nb2.digest(values[nb2.BUNDLE]), nb2.BUNDLE_SHA)
        with self.assertRaisesRegex(ValueError, 'LIST_BUNDLE_HASH_MISMATCH'):
            nb2.verified_members(raw, '0' * 64)
        buffer = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(raw)) as src, zipfile.ZipFile(buffer, 'w') as dst:
            for info in src.infolist():
                data = src.read(info)
                if info.filename == 'source/benchmarks/phase2/kaggle/list_study_v2.py':
                    data += b'\n# tampered\n'
                dst.writestr(info, data)
        tampered = buffer.getvalue()
        with self.assertRaisesRegex(ValueError, 'LIST_SOURCE_HASH'):
            nb2.verified_members(tampered, nb2.digest(tampered))


class ReviewV2Test(unittest.TestCase):
    def test_refuses_non_v2_sessions_and_summarises_diagnostics(self):
        import list_review_v2 as r2
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / 'summary.json').write_text(json.dumps({'study': 'cqrs-list-matched-kaggle-v1'}), encoding='utf-8')
            with self.assertRaises(SystemExit):
                r2.require_v2(d)
            m = d / 'members' / 'pcn-full-b0-B'; m.mkdir(parents=True)
            (m / 'diagnostics.jsonl').write_text('\n'.join(json.dumps(x) for x in [
                {'monotonicMs': 1, 'clinicOutbox': {'pending': 10}, 'coreOutbox': {'pending': 1}},
                {'monotonicMs': 2, 'clinicOutbox': {'pending': 20000}, 'coreOutbox': None},
                {'event': 'sampler-stopped', 'errors': 1}]) + '\n', encoding='utf-8')
            (m / 'clinic-read-diagnostics.jsonl').write_text(json.dumps({'event': 'projection_failure', 'stage': 'projection-items', 'reason': 'query_error', 'sqlState': '57014'}) + '\n', encoding='utf-8')
            (m / 'postgres-log.jsonl').write_text('\n'.join(json.dumps({'line': l}) for l in [
                'ERROR:  relation "OutboxEvent" does not exist at character 113',
                "STATEMENT:  SELECT json_build_object('pending', count(*), 'oldestSeconds', 1) FROM \"OutboxEvent\" WHERE \"publishedAt\" IS NULL",
                'ERROR:  canceling statement due to statement timeout', 'STATEMENT:  SELECT p.id FROM "AppointmentReadRow" p']) + '\n', encoding='utf-8')
            s = r2.diagnostics(m)
            self.assertEqual((s['clinicOutboxPendingMax'], s['coreOutboxPendingMax'], s['samplerErrors'], s['statementTimeouts']), (20000, 1, 1, 1))
            self.assertEqual((s['pgErrors'], s['samplerStartupPgErrors']), (1, 1), "sampler's own pre-migration errors are counted apart")
            self.assertEqual(s['projectionFailures'], {'projection-items:query_error:57014': 1})
            self.assertEqual(r2.diagnostics(d / 'members' / 'missing'), {'present': False})


if __name__ == '__main__':
    unittest.main()
