// Collector tests on a fake /proc and cgroup tree (synthetic; not app measurements).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseStat,sample,windowCpu,applicationRoles} from './bench/collector.mjs';

// Fixture lives in a run-owned directory under test-results and is removed after.
const root=resolve('test-results/phase2/cqrs/activity/bench-collector-fixture-'+randomUUID());
const proc=root+'/proc',cg=root+'/cgroup';
function setProc(rows){
  rmSync(proc,{recursive:true,force:true});
  for(const [pid,ppid,ticks,comm='node',reaped=0] of rows){mkdirSync(proc+'/'+pid,{recursive:true});
    writeFileSync(proc+'/'+pid+'/stat',pid+' ('+comm+') S '+ppid+' 0 0 0 -1 0 0 0 0 0 '+ticks+' '+ticks+' '+reaped+' 0 20 0 1 0 0 0 0');}
}
const ledger=Object.fromEntries([...applicationRoles,'generator','controller'].map((r,i)=>[r,[100+i*10]]));
// Each role root pid plus one child (a PG-backend-like comm with spaces/parens).
const rowsAt=k=>Object.values(ledger).flatMap(([pid],i)=>[[pid,1,k*(i+1)],[pid+1,pid,k*(i+1),'postgres: u (db) idle']]);
test.after(()=>rmSync(root,{recursive:true,force:true}));

test('parses /proc stat with spaces/parentheses in comm',()=>{
  assert.deepEqual(parseStat('42 (postgres: user (db) idle) S 7 0 0 0 -1 0 0 0 0 0 300 50 0 0'),{ppid:7,utime:300,stime:50,cutime:0,cstime:0,comm:'postgres: user (db) idle'});
  assert.throws(()=>parseStat('garbage'),/INVALID_PROC_STAT/);
});
test('role CPU includes descendants, cgroup total is separate and never substituted',()=>{
  mkdirSync(cg,{recursive:true});const samples=[];
  for(const [k,at,usage] of [[1,1000,1e6],[2,2000,3e6],[3,3000,6e6]]){setProc(rowsAt(k));writeFileSync(cg+'/cpu.stat','usage_usec '+usage+'\nuser_usec 1\n');samples.push(sample(ledger,{procRoot:proc,cgroupRoot:cg,clockTicks:100,at}));}
  const w=windowCpu(samples,1000,3000);assert.equal(w.complete,true,JSON.stringify(w.reasons));
  // api: root + child, each utime+stime = 2k ticks -> (k3-k1)*4 ticks = 8 ticks = 0.08 s.
  assert.equal(w.roles.api,0.08);assert.ok(w.applicationCpuSeconds>0);assert.deepEqual(Object.keys(w.separateCpuSeconds),['generator','controller']);
  assert.equal(w.totalEnvelopeCpuSeconds,5);assert.equal(w.coveredMs,2000);assert.notEqual(w.applicationCpuSeconds,w.totalEnvelopeCpuSeconds);
});
test('an exiting child reaped by its role parent keeps the counter monotonic (cutime/cstime)',()=>{
  // broker 500 with helper 501 (10+10 ticks); helper exits and is reaped into 500's cutime.
  setProc([[500,1,5],[501,500,10]]);const a=sample({broker:[500]},{procRoot:proc,cgroupRoot:cg,clockTicks:100,at:1});
  setProc([[500,1,6,'beam',20]]);const b=sample({broker:[500]},{procRoot:proc,cgroupRoot:cg,clockTicks:100,at:2});
  assert.deepEqual([a.roles.broker,b.roles.broker],[30,32]);const w=windowCpu([a,b],1,2,['broker']);
  assert.equal(w.complete,true,JSON.stringify(w.reasons));assert.equal(w.roles.broker,0.02);
  // Not reaped by the tree (re-parented away): counter drops -> incomplete, not estimated.
  setProc([[500,1,6]]);const c=sample({broker:[500]},{procRoot:proc,cgroupRoot:cg,clockTicks:100,at:2});
  assert.equal(windowCpu([a,c],1,2,['broker']).complete,false);
});
test('a controller that spawned the APIs does not absorb their subtrees',()=>{
  // controller 900 -> api 901 -> pg-like child 902; generator 903 also under the controller.
  setProc([[900,1,5],[901,900,7],[902,901,11],[903,900,13]]);
  const s=sample({controller:[900],api:[901],generator:[903]},{procRoot:proc,cgroupRoot:cg,clockTicks:1,at:1});
  assert.deepEqual(s.unreadable,[]);assert.deepEqual(s.roles,{controller:10,api:36,generator:26});
});
test('missing role, overlapping ledgers, counter reset or too few samples => incomplete coverage',()=>{
  setProc(rowsAt(1).filter(([pid])=>pid!==ledger.broker[0]&&pid!==ledger.broker[0]+1));
  const gone=sample(ledger,{procRoot:proc,cgroupRoot:cg+'-missing',at:1});assert.ok(gone.unreadable.includes('broker'));assert.equal(gone.totalCgroupCpuSeconds,null);
  setProc(rowsAt(2));const ok=sample(ledger,{procRoot:proc,cgroupRoot:cg,at:2});
  const w=windowCpu([gone,ok],1,2);assert.equal(w.complete,false);assert.ok(w.reasons.includes('role_unreadable:broker'));assert.equal(w.applicationCpuSeconds,null);
  assert.ok(sample({...ledger,audit:[ledger.api[0]]},{procRoot:proc,cgroupRoot:cg,at:3}).unreadable.some(r=>r.endsWith(':overlap')));
  setProc(rowsAt(1));const reset=sample(ledger,{procRoot:proc,cgroupRoot:cg,at:4});assert.equal(windowCpu([ok,reset],2,4).complete,false);
  assert.equal(windowCpu([ok],2,2).complete,false);
});
