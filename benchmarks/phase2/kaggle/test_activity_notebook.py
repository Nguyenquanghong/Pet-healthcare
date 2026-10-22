"""Local pure packaging/guard/export checks; never starts the native stack."""
import ast
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch, Mock
import zipfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
def module(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value
builder = module('make_activity_notebook')
import sys,types
if sys.platform=='win32':
    with patch.dict(sys.modules,{'pwd':types.SimpleNamespace()}):
        native=module('activity_native')
else:
    native=module('activity_native')

class NotebookTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw, cls.manifest = builder.source_bundle()

    def rewrite(self, change):
        with zipfile.ZipFile(io.BytesIO(self.raw)) as z:
            items=[(i,z.read(i.filename)) for i in z.infolist()]
        items=change(items); buffer=io.BytesIO()
        with zipfile.ZipFile(buffer,'w',zipfile.ZIP_DEFLATED) as z:
            for item,value in items:z.writestr(item,value)
        return buffer.getvalue()

    def check_rejected(self, raw):
        with self.assertRaises((ValueError,KeyError)):
            builder.verified_members(raw,hashlib.sha256(raw).hexdigest())

    def test_bundle_exact_hashes_and_current_activity_source_no_secrets_or_windows_clients(self):
        manifest, values=builder.verified_members(self.raw,hashlib.sha256(self.raw).hexdigest())
        self.assertIn('tools/phase2/cqrs/activity/trial.mjs',values)
        self.assertIn('tools/phase2/cqrs/activity/trialBrowser.mjs',values)
        self.assertIn('tools/phase2/cqrs/activity/trialCoverage.mjs',values)
        self.assertIn(b'/dashboard/clinic/activity',values['services/clinic/src/app.ts'])
        self.assertFalse(manifest['performanceMeasurementsAllowed'])
        self.assertEqual(values['package-lock.json'],(REPO/'package-lock.json').read_bytes())
        self.assertFalse(any('/generated/' in n or '/node_modules/' in n or n.endswith('/.env') for n in values))
        self.assertEqual(len(values),len(manifest['files']))

    def test_tamper_and_inventory_path_symlink_reject_before_extraction(self):
        with self.assertRaises(ValueError):builder.verified_members(self.raw,'0'*64)
        def changed(items):
            return [(i,v+b'corrupt' if i.filename=='source/package.json' else v) for i,v in items]
        self.check_rejected(self.rewrite(changed))
        def traversal(items):
            return items+[(zipfile.ZipInfo('source/../../.env'),b'SECRET')]
        self.check_rejected(self.rewrite(traversal))
        def symlink(items):
            i=zipfile.ZipInfo('source/link');i.external_attr=(stat.S_IFLNK|0o777)<<16
            return items+[(i,b'/etc/passwd')]
        self.check_rejected(self.rewrite(symlink))
        self.check_rejected(self.rewrite(lambda items:items+[items[0]]))
        self.check_rejected(self.rewrite(lambda items:items[:-1]))

    def test_notebook_compiles_unexecuted_self_contained_and_no_benchmark_dispatch(self):
        directory=REPO/'test-results/phase2/cqrs/activity/notebook-package-tests'
        directory.mkdir(parents=True,exist_ok=True)
        # Retain artifacts; no recursive delete/cleanup of user files.
        import uuid
        target=directory/('activity-'+uuid.uuid4().hex+'.ipynb')
        record=builder.build(target)
        nb=json.loads(target.read_text(encoding='utf-8'))
        for cell in nb['cells']:
            if cell['cell_type']=='code':
                ast.parse(''.join(cell['source']))
                self.assertIsNone(cell['execution_count']);self.assertEqual(cell['outputs'],[])
        self.assertFalse(nb['metadata']['performance_measurements_allowed'])
        self.assertEqual(record['notebookSha256'],hashlib.sha256(target.read_bytes()).hexdigest())
        text='\n'.join(''.join(c['source']) for c in nb['cells'])
        self.assertIn('RUN_BENCHMARK = False',text);self.assertIn('runner.run_trial',text)
        self.assertNotIn('from cqrs_benchmark import run',text)
        with self.assertRaises(ValueError):builder.build(target)

    def test_source_path_rejects_runtime_env_and_generated_artifacts(self):
        for name in ['../x','/tmp/x','source\\x','.env','backend/.env','backend/.env.production',
                     '.git/config','node_modules/a','services/clinic/src/generated/client/index.js','file.key']:
            with self.assertRaises(ValueError):builder.safe_source_path(name)
        builder.safe_source_path('backend/.env.example')

    def test_wrong_host_never_runs_install_or_database_commands(self):
        trial=object.__new__(native.FunctionalTrial);trial.command=Mock()
        with patch.object(native.platform,'system',return_value='Windows'):
            with self.assertRaises(RuntimeError):trial.prerequisites()
        trial.command.assert_not_called()

    def test_child_environment_drops_all_inherited_database_broker_and_jwt_targets(self):
        with patch.dict(native.os.environ,{'PATH':'SAFE_PATH','HOME':'SAFE_HOME','DATABASE_URL':'PRIVATE_SECRET',
                                         'ACTIVITY_TRIAL_DATABASE_URL':'PRIVATE_SECRET','JWT_PRIVATE_KEY':'PRIVATE_SECRET',
                                         'REDIS_URL':'PRIVATE_SECRET','BROKER_URL':'PRIVATE_SECRET'},clear=True):
            self.assertEqual(native.clean_environment(),{'PATH':'SAFE_PATH','HOME':'SAFE_HOME'})

    def test_report_export_never_includes_private_context_log_fixture_rows_or_credentials(self):
        import uuid
        base=REPO/'test-results/phase2/cqrs/activity/notebook-export-tests'/uuid.uuid4().hex
        private,output=base/'private',base/'public';(private/'reports').mkdir(parents=True);output.mkdir()
        (private/'context.json').write_text('postgresql://PRIVATE_SECRET')
        (private/'commands.log').write_text('PRIVATE_SECRET')
        (private/'reports/fixture-rows.json').write_text('PRIVATE_SECRET')
        (private/'reports/fixture.json').write_text('{"status":"PASS_IN_SCOPE"}')
        for name in ['plans.json','plans-action.json','browser.json','stages.json']:
            (private/'reports'/name).write_text('{"status":"PASS_IN_SCOPE"}')
        (private/'reports/browser-login.json').write_text('PRIVATE_SECRET')
        summary={'status':'FAIL','failedStage':'new-private-cluster','errorType':'RuntimeError','performance':'NOT_RUN'}
        target=native.export_reports(private,output,summary,'a'*64)
        with zipfile.ZipFile(target) as z:
            self.assertEqual(set(z.namelist()),{'summary.json','fixture.json','result-manifest.json',
                                              'plans.json','plans-action.json','browser.json','stages.json'})
            self.assertNotIn(b'PRIVATE_SECRET',b''.join(z.read(n) for n in z.namelist()))
            self.assertEqual(json.loads(z.read('summary.json'))['status'],'FAIL')

    def test_native_paths_reject_reused_pgdata_wrong_run_and_other_workspace(self):
        run='01234567-89ab-4def-8123-0123456789ab'
        for private,output,root,bad_run in [('/tmp/old','/kaggle/working/old','/tmp/old/source',run),
            ('/tmp/clinic-activity-d1-'+run,'/tmp/output','/tmp/clinic-activity-d1-'+run+'/source',run),
            ('/tmp/x','/kaggle/working/x','/tmp/x/source','../main')]:
            with self.assertRaises(ValueError):native.validate_run_paths(root,private,output,bad_run)

    def test_source_reverification_detects_changes_after_npm_or_build_before_mutations(self):
        import uuid
        base=REPO/'test-results/phase2/cqrs/activity/notebook-reverify-tests'/uuid.uuid4().hex
        private,root=base/'private',base/'source';private.mkdir(parents=True);root.mkdir()
        data=b'validated source';(root/'example.mjs').write_bytes(data)
        manifest={'files':[{'path':'example.mjs','sha256':hashlib.sha256(data).hexdigest()}],'sourceTreeSha256':'recorded-tree'}
        with zipfile.ZipFile(private/'source.zip','x') as z:z.writestr('bundle-manifest.json',json.dumps(manifest))
        trial=object.__new__(native.FunctionalTrial);trial.private=private;trial.root=root.resolve();trial.bundle_sha=hashlib.sha256((private/'source.zip').read_bytes()).hexdigest()
        self.assertEqual(trial.verify_source(),'recorded-tree')
        (root/'example.mjs').write_bytes(b'changed source')
        with self.assertRaises(RuntimeError):trial.verify_source()

    def test_autostart_guard_restores_only_owned_policy_and_preserves_existing(self):
        import uuid
        base=REPO/'test-results/phase2/cqrs/activity/notebook-policy-tests'/uuid.uuid4().hex
        base.mkdir(parents=True);policy=base/'policy-rc.d'
        with self.assertRaisesRegex(RuntimeError,'INSTALL_FAILED'):
            with native.deny_service_autostart(policy):
                self.assertIn('exit 101',policy.read_text());raise RuntimeError('INSTALL_FAILED')
        self.assertFalse(policy.exists())
        policy.write_text('original policy')
        with patch.object(native.subprocess,'run',return_value=Mock(returncode=101)):
            with native.deny_service_autostart(policy):pass
        self.assertEqual(policy.read_text(),'original policy')
        with patch.object(native.subprocess,'run',return_value=Mock(returncode=0)):
            with self.assertRaisesRegex(RuntimeError,'DOES_NOT_DENY_AUTOSTART'):
                with native.deny_service_autostart(policy):self.fail('must not enter')

    def test_autostart_policy_concurrent_change_is_retained_and_rejected(self):
        import uuid
        base=REPO/'test-results/phase2/cqrs/activity/notebook-policy-tests'/uuid.uuid4().hex
        base.mkdir(parents=True);policy=base/'policy-rc.d'
        with self.assertRaisesRegex(RuntimeError,'CHANGED_CONCURRENTLY'):
            with native.deny_service_autostart(policy):policy.write_text('concurrent change')
        self.assertEqual(policy.read_text(),'concurrent change')

    def test_failed_stage_retains_utc_receipt_and_runs_cleanup_before_export(self):
        import uuid
        base=REPO/'test-results/phase2/cqrs/activity/notebook-stage-tests'/uuid.uuid4().hex
        private,output=base/'private',base/'output';private.mkdir(parents=True);output.mkdir()
        trial=Mock();trial.stage='prerequisites';trial.prerequisites.side_effect=RuntimeError('PRIVATE_DETAIL')
        with patch.object(native,'FunctionalTrial',return_value=trial):
            summary=native.run_trial(base/'source',private,output,str(uuid.uuid4()),'a'*64)
        trial.cleanup.assert_called_once();self.assertEqual(summary['status'],'FAIL')
        stages=json.loads((output/'stages.json').read_text())['stages'];self.assertEqual(len(stages),1)
        self.assertEqual(stages[0]['status'],'FAIL');self.assertIn('+00:00',stages[0]['startedAtUtc'])
        with zipfile.ZipFile(summary['download']) as z:
            self.assertNotIn(b'PRIVATE_DETAIL',b''.join(z.read(n) for n in z.namelist()))

if __name__=='__main__':unittest.main()
