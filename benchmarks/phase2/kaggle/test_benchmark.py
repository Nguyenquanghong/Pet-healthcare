import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
import unittest
import time
import json
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from benchmark import open_loop, summarize, reconcile, matrix_report, POLICY, Client
from workflow import plan, execute
import tempfile
from contextlib import contextmanager


@contextmanager
def test_directory():
    base=Path(__file__).parents[3]/'test-results/phase2/kaggle-tools'
    base.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(dir=base) as directory:
        assert Path(directory).resolve().is_relative_to(base.resolve())
        yield directory


class BenchmarkTests(unittest.TestCase):
    def test_auto_workflow_gates_deep_load_on_actual_smoke(self):
        calls=[]
        def fail(repo,output,**kwargs):
            calls.append(kwargs)
            return {'status':'COMPLETE','generator_valid':True,'reconciliation':{'status':'REVIEW_REQUIRED'}}
        with test_directory() as directory:
            reports,result=execute('.',directory,runner=fail,progress=lambda text:None)
        self.assertEqual(len(calls),1)
        self.assertEqual(result['stopped_reason'],'smoke_not_passed')
        self.assertFalse(result['capacity_accepted'])

    def test_auto_plan_has_three_real_repeats_for_each_topology(self):
        measured=[case for case in plan() if case['stage']=='measured']
        self.assertEqual(len(measured),18)
        for profile in ('read','mixed','clinic_write'):
            for replicas in (1,2):
                selected=[c for c in measured if c['profile']==profile and c['replicas']==replicas]
                self.assertEqual({c['repeat'] for c in selected},{1,2,3})
                self.assertTrue(all(c['warmup']>=120 and c['seconds']>=300 for c in selected))

    def test_auto_workflow_exports_failure_without_retrying(self):
        calls=[]
        def fail(repo,output,**kwargs):
            calls.append(kwargs); raise RuntimeError('Synthetic failed startup')
        with test_directory() as directory:
            reports,result=execute('.',directory,runner=fail,progress=lambda text:None)
            saved=json.loads(Path(directory,'workflow.json').read_text())
        self.assertEqual(len(calls),1)
        self.assertEqual(saved['status'],'STOPPED')
        self.assertEqual(saved['errors'][0]['error_type'],'RuntimeError')

    def test_failed_fault_probe_is_preserved_and_stops_workflow(self):
        def runner(repo,output,**kwargs):
            return {'status':'COMPLETE','profile':kwargs['profile'],'offered_rps':kwargs['rate'],
                'clinic_replicas':kwargs['replicas'],'repeat':kwargs['repeat'],
                'classification':'MEASURED_SCOPE_ONLY','generator_valid':True,
                'reconciliation':{'status':'PASS_IN_SCOPE'},
                'telemetry':{'metric_errors':0,'process_errors':0},
                'summary':[{'threshold_result':'PASS_IN_SCOPE','success_ratio_of_scheduled':1,'unexpected_error_ratio':0}],
                'billing_terminal':{'status':'PASS_IN_SCOPE'},'notification_healthy':{'status':'FAIL'},
                'notification_recovery':{'status':'PASS_IN_SCOPE'}}
        with test_directory() as directory:
            reports,result=execute('.',directory,runner=runner,progress=lambda text:None)
        self.assertEqual(result['stopped_reason'],'fault_scenario_failed')
        self.assertEqual(reports[-1]['notification_healthy']['status'],'FAIL')
        self.assertFalse(any(r['stage']=='policy' for r in reports))
    def test_open_loop_does_not_silently_become_closed_loop(self):
        def slow(index):
            time.sleep(.1)
            return {'operation':'core.pets','status':200,'outcome':'success','sent':True,'instance':''}
        run=open_loop(slow,rate=80,seconds=.3,concurrency=1)
        self.assertEqual(run['scheduled'],24)
        self.assertEqual(len(run['rows']),24)
        self.assertGreater(run['generator_drop_ratio'],.5)
        self.assertFalse(run['generator_valid'])

    def test_fast_429_cannot_pass_latency(self):
        rows=[{'operation':'auth.login_policy','status':429,'outcome':'rate_limited','sent':True,'latency_ms':1,'total_ms':1} for _ in range(1000)]
        report=summarize(rows,300)[0]
        self.assertIsNone(report['p95_success_ms'])
        self.assertEqual(report['threshold_result'],'FAIL')
        self.assertEqual(report['http_429'],1000)

    def test_backoff_is_in_denominator(self):
        rows=[{'operation':'core.pets','status':200,'outcome':'success','sent':True,'latency_ms':1,'total_ms':1},
              {'operation':'core.pets','status':0,'outcome':'client_backoff','sent':False,'latency_ms':0,'total_ms':0}]
        self.assertEqual(summarize(rows,1)[0]['success_ratio_of_scheduled'],.5)

    def test_small_sample_is_not_accepted(self):
        rows=[{'operation':'core.pets','status':200,'outcome':'success','sent':True,'latency_ms':1,'total_ms':1}]
        self.assertEqual(summarize(rows,1)[0]['threshold_result'],'INSUFFICIENT_SAMPLES')

    def test_request_budget_rejected_before_dispatch(self):
        def forbidden(index): raise AssertionError('must not call')
        for rate in (float('inf'),float('nan'),-1):
            with self.assertRaises(ValueError): open_loop(forbidden,rate=rate,seconds=1)
        with self.assertRaises(ValueError): open_loop(forbidden,rate=10,seconds=2,max_requests=5)

    def test_reconcile_missing_duplicate_and_unknown_commit(self):
        row={'id':'one','petId':'pet','appointmentDate':'2026-12-01','appointmentTime':'09:00','status':'pending'}
        empty={'appointments':[]}
        after={'appointments':[row],'unexpectedExit':False}
        self.assertEqual(reconcile(empty,after,['one'])['status'],'PASS_IN_SCOPE')
        self.assertEqual(reconcile(empty,after,['one','one'])['status'],'REVIEW_REQUIRED')
        self.assertEqual(reconcile(empty,after,[])['writes_without_success_response'],1)
        self.assertEqual(reconcile(empty,after,['missing'])['missing_success_ids'],1)
        after['appointments'].append({**row,'id':'two'})
        self.assertEqual(reconcile(empty,after,['one','two'])['duplicate_active_slots'],1)

    def test_matrix_needs_actual_distinct_repeats_and_every_run(self):
        run={'profile':'read','offered_rps':5,'clinic_replicas':1,'repeat':1,'status':'COMPLETE',
             'classification':'MEASURED_SCOPE_ONLY','generator_valid':True,
             'reconciliation':{'status':'PASS_IN_SCOPE'},'summary':[{'threshold_result':'PASS_IN_SCOPE'}]}
        self.assertEqual(matrix_report([run]*3)[0]['status'],'NOT_ACCEPTED')
        runs=[{**run,'repeat':n} for n in range(3)]
        self.assertEqual(matrix_report(runs)[0]['status'],'PASS_IN_SCOPE')
        runs[2]['generator_valid']=False
        self.assertEqual(matrix_report(runs)[0]['status'],'NOT_ACCEPTED')

    def test_no_external_target(self):
        class Stack: fixture={'baseUrl':'https://example.com'}
        with self.assertRaises(ValueError): Client(Stack())

    def test_real_http_driver_contract_scope_and_retry_after(self):
        state={'wrong_owner':False,'limit':False,'calls':0}
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length','0')))
                self.send_response(200); self.end_headers()
                self.wfile.write(b'{"user":{"id":"owner"},"token":"synthetic-test-token"}')
            def do_GET(self):
                state['calls']+=1
                self.send_response(429 if state['limit'] else 200)
                if state['limit']: self.send_header('Retry-After','60')
                self.end_headers()
                value={'items':[{'id':'pet','ownerId':'other' if state['wrong_owner'] else 'owner'}],
                       'pagination':{'total':1}}
                self.wfile.write(json.dumps(value).encode())
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        class Stack:
            fixture={'baseUrl':f'http://127.0.0.1:{server.server_port}',
                     'accounts':[{'id':'owner','email':'synthetic@example.test','pets':[]}],'password':'fixture'}
        try:
            client=Client(Stack()); call=client.workload('read')
            self.assertEqual(call(0)['outcome'],'success')
            state['wrong_owner']=True
            self.assertEqual(call(0)['outcome'],'contract_error')
            state['limit']=True
            self.assertEqual(call(0)['outcome'],'rate_limited')
            before=state['calls']
            self.assertEqual(call(0)['outcome'],'client_backoff')
            self.assertEqual(state['calls'],before)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_notebook_cells_compile_and_are_unexecuted(self):
        path=Path(__file__).parents[1]/'phase2-kaggle.ipynb'
        notebook=json.loads(path.read_text(encoding='utf-8'))
        for cell in notebook['cells']:
            if cell['cell_type']=='code':
                compile(''.join(cell['source']),str(path),'exec')
                self.assertEqual(cell['outputs'],[])
                self.assertIsNone(cell['execution_count'])


if __name__=='__main__': unittest.main()
