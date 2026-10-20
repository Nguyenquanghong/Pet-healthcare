import test from 'node:test';
import assert from 'node:assert/strict';
import {ProjectionAdmission} from '../../../services/clinic/dist/infrastructure/queries/projectionAdmission.js';
import {ServingAppointmentQueries} from '../../../services/clinic/dist/infrastructure/queries/servingAppointments.js';
import {ReadDiagnostics} from '../../../services/clinic/dist/readDiagnostics.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const control={activeGenerationId:'g',servingMode:'projection',activeGeneration:{state:'ACTIVE',verifiedAt:new Date(),schemaVersion:1,projectionName:'appointments'}};
const makeTx=()=>({$executeRawUnsafe:async()=>0,readProjectionControl:{findUnique:async()=>control}});

test('admission is FIFO, bounded to sixteen waiters and releases exactly once',async()=>{
 const gate=new ProjectionAdmission(),first=await gate.acquire(performance.now()+1000),order=[];
 const waiting=Array.from({length:16},(_,i)=>gate.acquire(performance.now()+1000).then(release=>{order.push(i);return release;}));
 await assert.rejects(gate.acquire(performance.now()+1000),/ADMISSION_BUSY/);first();first();
 for(const item of waiting){const release=await item;release();}
 assert.deepEqual(order,Array.from({length:16},(_,i)=>i));assert.equal(gate.busy,false);
});

test('expired and timed-out waiters never acquire a slot later or block the next caller',async()=>{
 let now=0;const gate=new ProjectionAdmission(()=>now),release=await gate.acquire(1000);
 const expired=assert.rejects(gate.acquire(10),/ADMISSION_BUSY/);now=11;release();await expired;
 assert.equal(gate.busy,false);const next=await gate.acquire(1000);
 const timed=assert.rejects(gate.acquire(15),/ADMISSION_BUSY/);await timed;next();
 const last=await gate.acquire(1000);last();assert.equal(gate.busy,false);
 await assert.rejects(gate.acquire(0),/ADMISSION_BUSY/);
});

test('queued projection requests hold no DB connection; forced source is independent and snapshot starts after admission',async()=>{
 const held=deferred(),started=deferred();let active=0,max=0,transactions=0,version=1;
 const snapshots=[],options=[];
 const db={$transaction:async(fn,opt)=>{transactions++;active++;max=Math.max(max,active);options.push(opt);const snapshot=version;snapshots.push(snapshot);
  try{return await fn(makeTx());}finally{active--;}
 }};
 const serving=new ServingAppointmentQueries(db,{usable:()=>true},new ReadDiagnostics(false));
 const one=serving.read(async()=>{started.resolve();await held.promise;return version;});await started.promise;
 const waiting=Array.from({length:16},()=>serving.read(async()=>version));
 await new Promise(r=>setImmediate(r));assert.equal(transactions,1);assert.equal(active,1);
 const financial=await serving.read(async()=>42,{},true);assert.equal(financial.source,'authoritative');assert.equal(transactions,2);
 version=2;held.resolve();const results=await Promise.all([one,...waiting]);
 assert.ok(results.every(r=>r.source==='projection'));assert.equal(active,0);assert.equal(max,2);
 assert.deepEqual(snapshots,[1,1,...Array(16).fill(2)]);assert.equal(transactions,18);
 assert.ok(options.filter(o=>o.timeout!==2500).every(o=>o.timeout>0&&o.timeout<=1250&&o.maxWait<=50));
});

test('projection acquire/setup/query errors release admission before fallback and do not retry SQL',async()=>{
 for(const stage of ['projection-acquire','projection-setup','projection-query']){
  const rows=[],diag=new ReadDiagnostics(true,line=>rows.push(JSON.parse(line.slice('CLINIC_READ_DIAGNOSTIC '.length))));
  const failure=Object.assign(new Error('PRIVATE'),{code:'P2028'});let count=0;
  const db={$transaction:async fn=>{const first=++count===1;if(first&&stage==='projection-acquire')throw failure;
   const tx=makeTx();if(first&&stage==='projection-setup')tx.$executeRawUnsafe=async()=>{throw failure;};return fn(tx);
  }};
  const serving=new ServingAppointmentQueries(db,{usable:()=>true},diag);let reads=0;
  const result=await serving.read(async()=>{if(++reads===1&&stage==='projection-query')throw failure;return 7;});
  assert.equal(result.source,'authoritative');assert.equal(count,2);assert.equal(rows.find(r=>r.event==='projection_failure').stage,stage);
  assert.equal((await serving.read(async()=>8)).source,'projection');assert.equal(count,3);assert.ok(!JSON.stringify(rows).includes('PRIVATE'));
 }
});

test('a timed-out waiter opens no projection transaction and cannot run after fallback',async()=>{
 const held=deferred(),started=deferred();let transactions=0;const options=[];
 const db={$transaction:async(fn,opt)=>{transactions++;options.push(opt);return fn(makeTx());}};
 const serving=new ServingAppointmentQueries(db,{usable:()=>true},new ReadDiagnostics(false));
 const first=serving.read(async()=>{started.resolve();await held.promise;return 1;});await started.promise;
 // The queued request expires before it may acquire a connection or check tokens.
 const waiting=serving.read(async()=>2,{id:1});
 const result=await waiting;assert.equal(result.source,'authoritative');assert.equal(transactions,2);
 assert.equal(options[1].timeout,2500);held.resolve();await first;
 assert.equal((await serving.read(async()=>3)).source,'projection');assert.equal(transactions,3);
});

test('admitted RYW requests recheck control/token in a new snapshot and subtract waiting from their deadline',async()=>{
 const held=deferred(),started=deferred();const options=[];let tokenChecks=0;
 const db={$transaction:async(fn,opt)=>{options.push(opt);const tx=makeTx();tx.$queryRaw=async()=>{tokenChecks++;return [{id:'id',version:2,deleted:false,projected:2,deletedAt:null}];};return fn(tx);}};
 const serving=new ServingAppointmentQueries(db,{usable:()=>true},new ReadDiagnostics(false));
 const first=serving.read(async()=>{started.resolve();await held.promise;return 1;});await started.promise;
 const second=serving.read(async()=>2,{id:2});await new Promise(r=>setTimeout(r,60));assert.equal(tokenChecks,0);
 held.resolve();await first;assert.equal((await second).source,'projection');assert.equal(tokenChecks,1);
 assert.ok(options[1].timeout>0&&options[1].timeout<=450);assert.equal(options[1].maxWait,50);
});

test('admission stays occupied until commit or rollback settles, including a failed commit',async()=>{
 const commit=deferred(),returned=deferred();let transactions=0;
 const db={$transaction:async fn=>{const first=++transactions===1;const value=await fn(makeTx());if(first){returned.resolve();await commit.promise;throw Object.assign(new Error('PRIVATE'),{code:'P2028'});}return value;}};
 const serving=new ServingAppointmentQueries(db,{usable:()=>true},new ReadDiagnostics(false));
 const first=serving.read(async()=>1);await returned.promise;const second=serving.read(async()=>2);
 await new Promise(r=>setImmediate(r));assert.equal(transactions,1);commit.resolve();
 assert.equal((await first).source,'authoritative');assert.equal((await second).source,'projection');assert.equal(transactions,3);
});
