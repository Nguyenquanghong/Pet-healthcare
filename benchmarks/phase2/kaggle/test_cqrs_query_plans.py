import hashlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

sys.path.insert(0,str(Path(__file__).parent))
from query_heavy import collect_post_load_plans, run_trial
from cqrs_source import REPO

def plan_result():
    return {'version':1,'status':'PARTIAL','scope':'post-load-read-only','capacityAccepted':False,
            'results':[{'operation':'admin-calendar','status':'UNAVAILABLE','sqlState':'57014'}]}

class QueryPlanTests(unittest.TestCase):
    def setUp(self):
        self.root=REPO/'test-results/phase2/cqrs/q6-offline-plan-tests'/str(uuid4());self.root.mkdir(parents=True)

    def test_collector_hash_and_failure_never_export_exception_text(self):
        result=collect_post_load_plans(SimpleNamespace(control=lambda action:plan_result()),self.root)
        self.assertEqual(result['status'],'PARTIAL')
        self.assertEqual(result['sha256'],hashlib.sha256((self.root/'query-plans.json').read_bytes()).hexdigest())
        def fail(action):raise RuntimeError('PRIVATE postgres credential')
        out=self.root/'error';out.mkdir()
        failure=collect_post_load_plans(SimpleNamespace(control=fail),out)
        self.assertEqual(failure['status'],'UNAVAILABLE');self.assertNotIn('PRIVATE',json.dumps(failure));self.assertFalse((out/'query-plans.json').exists())

    def test_v2_preserves_all_statement_plans_and_rejects_unknown_versions(self):
        payload={'version':2,'status':'COLLECTED','scope':'post-load-read-only','capacityAccepted':False,
                 'results':[{'operation':'admin-list','status':'COLLECTED','statementCount':2,
                             'statements':[{'part':i,'sqlShapeSha256':str(i)*64,'parameterCount':3,
                                            'plan':{'Plan':{'Node Type':'Aggregate'},'Execution Time':100+i}}
                                           for i in range(2)]}]}
        result=collect_post_load_plans(SimpleNamespace(control=lambda _:payload),self.root)
        self.assertEqual(result['status'],'COLLECTED')
        data=(self.root/'query-plans.json').read_bytes()
        self.assertEqual(json.loads(data),payload)
        self.assertEqual(result['sha256'],hashlib.sha256(data).hexdigest())
        for version in (0,3,True,'2'):
            out=self.root/('version-'+str(version));out.mkdir()
            result=collect_post_load_plans(SimpleNamespace(control=lambda _:{**payload,'version':version}),out)
            self.assertEqual(result['status'],'UNAVAILABLE')
            self.assertFalse((out/'query-plans.json').exists())

    def test_plans_run_once_after_load_and_sampler_stop_preserve_failed_warmup_or_measured_gate(self):
        for fail_phase in ('warmup','measured'):
            with self.subTest(fail_phase=fail_phase):
                events=[];private=self.root/fail_phase;private.mkdir();(private/'pgdata').mkdir()
                (private/'pgdata/postmaster.pid').write_text('123');(private/'nginx.pid').write_text('124')
                class Stack:
                    def __init__(self,*args,**kw):
                        self.private=private;self.run=str(uuid4());self.processes=[];self.application=SimpleNamespace(pid=125)
                        self.fixture={'dataset':{'appointments':100000},'dbCrossConnectDenied':6,'cqrs':{'configuration':'B','generation':'g'},'processes':[]}
                    def __enter__(self):return self
                    def __exit__(self,*args):events.append('closed')
                    def control(self,action):
                        if action=='query-snapshot':return {'unexpectedExit':False,'appointment':{'count':100000}}
                        if action=='query-observe':return {'unexpectedExit':False}
                        if action=='cqrs-observe':return {'pending':0}
                        if action=='cqrs-query-plans':events.append('plans');return plan_result()
                        raise AssertionError(action)
                def measure(*args,**kw):
                    n=sum(e.startswith('load') for e in events)+1;events.append('load'+str(n))
                    fail=fail_phase=='warmup' or n==2
                    return {'rows':[{'outcome':'contract_error' if fail else 'success'} for _ in range(8)],
                            'summary':[{} for _ in range(8)],'seconds':kw['seconds'],'generator_valid':True}
                with patch('query_heavy.NativeStack',Stack),patch('query_heavy.QueryClient',return_value=SimpleNamespace(read=lambda _:None)),patch('query_heavy.cqrs_preflight',return_value=[]),patch('query_heavy.preflight',return_value=[{'valid':True}]*3),patch('query_heavy.measure',measure),patch('query_heavy.resource_sample',return_value=[]):
                    report=run_trial(REPO,self.root/('result-'+fail_phase),mode='smoke',cqrs_configuration='B',progress=lambda _:None)
                self.assertEqual(report['status'],'FAIL');self.assertEqual(report['failed_stage'],fail_phase)
                self.assertEqual(events,(['load1'] if fail_phase=='warmup' else ['load1','load2'])+['plans','closed'])
                self.assertEqual(report['query_plans']['status'],'PARTIAL');self.assertIn('query-plans.json',report['hashes'])

if __name__=='__main__':unittest.main()
