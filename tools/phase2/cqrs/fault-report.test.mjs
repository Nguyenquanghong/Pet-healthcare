import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFaultEvidence} from './fault-report.mjs';
const policy={correctness:{racePairsPerScenario:2},freshness:{runs:1,mutationsPerRun:2,p95MsMax:2000,p99MsMax:5000,adminWindowCases:2,adminWindowMsMax:10000},recovery:{runs:1,projectorOutageSeconds:60,catchUpSecondsMax:120,inputEventsMax:300,inputEventsPerSecondMax:5}};
function fixture(){return{
 cases:{races:[...['status','undo'].map((winner,pair)=>({pair,winner,scenario:'status-undo',status:[200,409]})),...[0,1].map((winnerReplica,pair)=>({pair,winnerReplica,scenario:'slot',status:[201,409]}))],freshness:[{run:0,status:'PASS',samples:[0,1].map(id=>({id,status:'PASS',rywStatus:200,rywSource:'projection',visibleMs:100}))}],recovery:[{run:0,status:'PASS',outageMs:60000,catchUpMs:1000,validDlq:0,expected:[{id:'a',version:1,acceptedMs:500}]}],remainingConsumers:0,rollback:{replicas:2,projectionTableUnavailable:true,tokenOptional:true}},
 billing:{prepareUndo:['prepare','undo'].map((winner,pair)=>({pair,winner,status:'PASS'})),commitAbort:['commit','abort'].map((winner,pair)=>({pair,winner,status:'PASS'}))},
 admin:{samples:[0,1].map(id=>({id,status:'PASS',visibleMs:5000})),sources:{projection:1}}
};}
test('Q5 evaluator rejects missing samples, one-sided barriers, failures and altered summary percentiles',()=>{
 const ok=fixture();assert.equal(evaluateFaultEvidence(policy,ok.cases,ok.billing,ok.admin).status,'PASS');
 for(const damage of [f=>f.cases.freshness[0].samples.pop(),f=>f.cases.freshness[0].samples[1].status='FAIL',f=>{f.cases.freshness[0].p99Ms=1;f.cases.freshness[0].samples[1].visibleMs=6000;},f=>f.billing.commitAbort[1].winner='commit',f=>f.admin.samples[1].visibleMs=10001,f=>f.cases.recovery[0].outageMs=59999,f=>f.cases.recovery[0].validDlq=1]){
  const f=fixture();damage(f);assert.throws(()=>evaluateFaultEvidence(policy,f.cases,f.billing,f.admin));
 }
});
test('Q5 evaluator rejects burst recovery input despite a low whole-run average',()=>{
 const f=fixture();f.cases.recovery[0].expected=Array.from({length:6},(_,i)=>({id:String(i),version:1,acceptedMs:100+i}));assert.throws(()=>evaluateFaultEvidence(policy,f.cases,f.billing,f.admin),/input rate exceeded/);
});
