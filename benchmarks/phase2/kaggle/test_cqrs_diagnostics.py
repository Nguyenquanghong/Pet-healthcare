import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0,str(Path(__file__).parent))
from cqrs_diagnostics import collect, validated, PREFIX
from cqrs_probe import read_evidence
from cqrs_source import REPO
from query_heavy import run_trial
from pcn_runner import run_pcn

def row(**extra):
    return dict(version=1,sequence=1,id=4,operation='admin-list',stage='projection-counts',event='projection_failure',reason='query_error',prismaCode='P2010',sqlState='57014',atUnixMs=1792100000000,elapsedMs=211.2,stageMs=201.5,**extra)

class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.root=REPO/'test-results/phase2/cqrs/q6-diagnostic-tests'/str(uuid4())
        self.root.mkdir(parents=True); self.private=self.root/'private';self.private.mkdir()
        self.output=self.root/'output';self.output.mkdir()

    def test_only_strict_allowlist_is_exported_no_raw_or_private_fields(self):
        good=row(); bad=[]
        for key,value in [('reason','PRIVATE'),('prismaCode','PASSWORD'),('sqlState','PRIVATE'),('operation',{}),('elapsedMs',float('nan')),('stageMs',10**1000),('id',True)]:
            r={**good,key:value};self.assertFalse(validated(r));bad.append(r)
        bad.append({**good,'message':'PRIVATE token/sql'})
        data=b'postgresql://PRIVATE\n'+PREFIX+json.dumps(good).encode()+b'\n'
        data+=b''.join(PREFIX+json.dumps(r).encode()+b'\n' for r in bad)
        data+=PREFIX+b'['*2000+b'0'+b']'*2000+b'\n'
        (self.private/'clinic-0.log').write_bytes(data)
        result=collect(self.private,1,self.output)
        self.assertEqual(result['records'],1);self.assertEqual(result['rejected'],len(bad)+1);self.assertEqual(result['status'],'INCOMPLETE')
        exported=(self.output/'read-diagnostics.jsonl').read_bytes();self.assertNotIn(b'PRIVATE',exported)
        self.assertEqual(hashlib.sha256(exported).hexdigest(),result['sha256'])

    def test_limit_missing_logs_and_oversize_lines_are_explicit(self):
        records=[{**row(),'sequence':n,'event':'limit' if n==513 else 'projection_failure'} for n in range(1,514)]
        (self.private/'clinic-0.log').write_bytes(PREFIX+b'x'*9000+b'\n'+b''.join(PREFIX+json.dumps(r).encode()+b'\n' for r in records))
        result=collect(self.private,2,self.output)
        self.assertEqual(result['records'],513);self.assertTrue(result['limited']);self.assertEqual(result['missing_logs'],1);self.assertEqual(result['rejected'],1)
        self.assertEqual(collect(self.private,99,self.output)['status'],'COLLECTION_ERROR')

    def test_diagnostic_id_cannot_export_arbitrary_headers(self):
        self.assertEqual(read_evidence({'X-Clinic-Read-Diagnostic-Id':'45'})['diagnostic_id'],45)
        for bad in ['PRIVATE','-1','1\nSECRET','1.2','0','9'*100]:
            self.assertNotIn('diagnostic_id',read_evidence({'X-Clinic-Read-Diagnostic-Id':bad}))

    def test_transaction_setup_stage_is_exported_separately_from_acquire(self):
        records=[{**row(),'sequence':n,'operation':'admin-unbilled','stage':stage,'event':'fallback_error','reason':'forced_source','prismaCode':'P2028','sqlState':None}
                 for n,stage in enumerate(('fallback-acquire','fallback-setup','fallback-query'),1)]
        (self.private/'clinic-0.log').write_bytes(b''.join(PREFIX+json.dumps(r).encode()+b'\n' for r in records))
        result=collect(self.private,1,self.output)
        self.assertEqual(result['status'],'COLLECTED');self.assertEqual(result['records'],3)
        exported=[json.loads(line) for line in (self.output/'read-diagnostics.jsonl').read_text().splitlines()]
        self.assertEqual([r['stage'] for r in exported],['fallback-acquire','fallback-setup','fallback-query'])

    def test_bounded_aggregate_failure_stages_survive_export(self):
        stages=['projection-aggregate-boundary','projection-aggregate-first','projection-aggregate-next']
        records=[{**row(),'sequence':i,'stage':stage} for i,stage in enumerate(stages,1)]
        (self.private/'clinic-0.log').write_bytes(b''.join(PREFIX+json.dumps(r).encode()+b'\n' for r in records))
        result=collect(self.private,1,self.output)
        self.assertEqual(result['status'],'COLLECTED')
        exported=[json.loads(line) for line in (self.output/'read-diagnostics.jsonl').read_text().splitlines()]
        self.assertEqual([r['stage'] for r in exported],stages)

    def test_failed_native_startup_still_exports_diagnostics_and_preserves_failure(self):
        (self.private/'clinic-0.log').write_bytes(PREFIX+json.dumps(row()).encode()+b'\n')
        class FailedStack:
            private=self.private
            def __enter__(self): raise RuntimeError('PRIVATE postgres token')
            def __exit__(self,*args): pass
        target=self.root/'failed'
        with patch('query_heavy.NativeStack',return_value=FailedStack()):
            report=run_trial(REPO,target,mode='smoke',cqrs_configuration='B',progress=lambda _:None)
        self.assertEqual(report['status'],'FAIL');self.assertEqual(report['failed_stage'],'startup')
        self.assertEqual(report['read_diagnostics']['records'],1)
        self.assertEqual(report['hashes']['read-diagnostics.jsonl'],hashlib.sha256((target/'read-diagnostics.jsonl').read_bytes()).hexdigest())
        self.assertNotIn('PRIVATE',json.dumps(report))
        pcn_target=self.root/'pcn-failed'
        with patch('pcn_runner.NativeStack',return_value=FailedStack()):
            result=run_pcn(REPO,pcn_target,mode='smoke',cqrs_configuration='B',progress=lambda _:None)
        self.assertEqual(result['overall'],'FAIL')
        manifest=json.loads((pcn_target/'manifest.json').read_text())
        self.assertEqual(manifest['status'],'FAILED');self.assertEqual(manifest['read_diagnostics']['records'],1)
        self.assertNotIn('PRIVATE',json.dumps(manifest))

    def test_projection_admission_setup_and_sampled_cache_events_are_exportable(self):
        records=[]
        for stage,event in [('projection-admission','admission_wait'),('projection-admission','admission_ready'),
                            ('projection-setup','projection_failure'),('projection-counts','cache_hit'),
                            ('projection-calendar','cache_miss'),('projection-counts','cache_coalesced'),
                            ('projection-counts','cache_wait')]:
            records.append({**row(),'sequence':len(records)+1,'stage':stage,'event':event})
        (self.private/'clinic-0.log').write_bytes(b''.join(PREFIX+json.dumps(r).encode()+b'\n' for r in records))
        result=collect(self.private,1,self.output)
        self.assertEqual(result['status'],'COLLECTED');self.assertEqual(result['records'],7)
        for private in ('epoch','actor','sql','cacheKey'):
            self.assertFalse(validated({**records[0],private:'PRIVATE'}))

if __name__=='__main__':unittest.main()
