import test from 'node:test';
import assert from 'node:assert/strict';
import {Prisma} from '../../../services/clinic/src/generated/client/index.js';
import {AppointmentAggregateCache} from '../../../services/clinic/dist/infrastructure/queries/appointmentAggregateCache.js';
import {ReadDiagnostics} from '../../../services/clinic/dist/readDiagnostics.js';

function fixture(){
 const f={epochs:['directory','projection','source-acl'].map(scope=>({scope,revision:'1',readOnly:'on',isolation:'repeatable read'})),calls:0,value:[{date:new Date('2028-02-01'),n:3}]};
 f.tx={$queryRaw:async sql=>{if(Array.isArray(sql))return structuredClone(f.epochs);f.calls++;if(f.error)throw f.error;return structuredClone(f.value);}};return f;
}
test('aggregate cache rechecks all epochs on every hit and partitions bindings and actor scope',async()=>{
 const f=fixture(),cache=new AppointmentAggregateCache(),sql=Prisma.sql`SELECT ${'generation-a'}`;
 const first=await cache.read(f.tx,sql,'owner-a');first[0].n=999;
 assert.deepEqual(await cache.read(f.tx,sql,'owner-a'),f.value);assert.equal(f.calls,1);
 for(let i=0;i<3;i++){f.epochs[i].revision='2';await cache.read(f.tx,sql,'owner-a');assert.equal(f.calls,i+2);}
 await cache.read(f.tx,sql,'owner-b');await cache.read(f.tx,Prisma.sql`SELECT ${'generation-b'}`,'owner-a');
 assert.equal(f.calls,6);assert.equal(cache.stats.hits,1);
});
test('writable or non-repeatable snapshots, missing/corrupt guard rows fail closed even with cached value',async()=>{
 for(const corrupt of [f=>f.epochs.pop(),f=>f.epochs[0].revision='0',f=>f.epochs[0].scope='wrong',f=>f.epochs[0].readOnly='off',f=>f.epochs[0].isolation='read committed']){
  const f=fixture(),cache=new AppointmentAggregateCache(),sql=Prisma.sql`SELECT 1`;await cache.read(f.tx,sql,'admin');corrupt(f);
  await assert.rejects(cache.read(f.tx,sql,'admin'),/EPOCH_UNAVAILABLE/);assert.equal(f.calls,1);
 }
});
test('failed SQL is not cached; TTL and entry count bound lifetime without changing results',async()=>{
 let time=0;const f=fixture(),cache=new AppointmentAggregateCache(()=>time,2,100),one=Prisma.sql`SELECT ${1}`,two=Prisma.sql`SELECT ${2}`,three=Prisma.sql`SELECT ${3}`;
 f.error=new Error('failure');await assert.rejects(cache.read(f.tx,one,'a'),/failure/);delete f.error;
 await cache.read(f.tx,one,'a');await cache.read(f.tx,two,'a');await cache.read(f.tx,three,'a');await cache.read(f.tx,one,'a');assert.equal(f.calls,5);
 await cache.read(f.tx,one,'a');assert.equal(f.calls,5);time=100;await cache.read(f.tx,one,'a');assert.equal(f.calls,6);
 assert.throws(()=>new AppointmentAggregateCache(()=>0,0),/BOUNDS/);assert.throws(()=>new AppointmentAggregateCache(()=>0,129),/BOUNDS/);
});
test('concurrent identical misses coalesce, changed epochs do not; failures release bounded admission',async()=>{
 const f=fixture(),cache=new AppointmentAggregateCache();let release,entered;const held=new Promise(r=>release=r),ready=new Promise(r=>entered=r);let queries=0;
 f.tx.$queryRaw=async sql=>{if(Array.isArray(sql))return structuredClone(f.epochs);queries++;if(queries===1){entered();await held;}return [{n:queries}];};
 const sql=Prisma.sql`SELECT 1`,one=cache.read(f.tx,sql,'a');await ready;
 const two=cache.read(f.tx,sql,'a');await new Promise(r=>setImmediate(r));f.epochs[2].revision='2';
 const three=cache.read(f.tx,sql,'a');await new Promise(r=>setImmediate(r));assert.equal(queries,1);release();
 assert.deepEqual(await one,[{n:1}]);assert.deepEqual(await two,[{n:1}]);assert.deepEqual(await three,[{n:2}]);assert.equal(queries,2);assert.equal(cache.stats.coalesced,1);
});
test('hot entries renew idle TTL only after epoch verification; waiting for another key has a deadline',async()=>{
 let time=0;const f=fixture(),cache=new AppointmentAggregateCache(()=>time,2,100),sql=Prisma.sql`SELECT 1`;
 await cache.read(f.tx,sql,'a');time=90;await cache.read(f.tx,sql,'a');time=150;await cache.read(f.tx,sql,'a');assert.equal(f.calls,1);time=250;await cache.read(f.tx,sql,'a');assert.equal(f.calls,2);
 let release,entered;const held=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 f.tx.$queryRaw=async value=>{if(Array.isArray(value))return f.epochs;entered();await held;return [];};
 const one=cache.read(f.tx,Prisma.sql`SELECT 2`,'a');await ready;
 await assert.rejects(cache.read(f.tx,Prisma.sql`SELECT 3`,'a'),/AGGREGATE_BUSY/);release();await one;
 assert.deepEqual(await cache.read(f.tx,Prisma.sql`SELECT 3`,'a'),[]);
});
test('a coalesced caller cannot inherit a longer transaction deadline from the computing request',async()=>{
 const f=fixture(),cache=new AppointmentAggregateCache(),sql=Prisma.sql`SELECT 1`;let release,entered;
 const ready=new Promise(r=>entered=r),held=new Promise(r=>release=r);
 f.tx.$queryRaw=async value=>{if(Array.isArray(value))return f.epochs;entered();await held;return [{n:1}];};
 const one=cache.read(f.tx,sql,'a',performance.now()+1000);await ready;
 await assert.rejects(cache.read(f.tx,sql,'a',performance.now()+10),/AGGREGATE_BUSY/);release();assert.deepEqual(await one,[{n:1}]);
 assert.deepEqual(await cache.read(f.tx,sql,'a'),[{n:1}]);
});

test('cache hit/miss telemetry is sampled and exports no epoch, actor or SQL bindings',async()=>{
 const f=fixture(),cache=new AppointmentAggregateCache(),rows=[];
 const diag=new ReadDiagnostics(true,line=>rows.push(JSON.parse(line.slice('CLINIC_READ_DIAGNOSTIC '.length))));
 const sql=Prisma.sql`SELECT ${'PRIVATE'}`;
 for(let i=0;i<20;i++)await diag.run('admin-list',async()=>{diag.mark('projection-counts');await cache.read(f.tx,sql,'PRIVATE',undefined,diag);});
 assert.equal(rows.filter(r=>r.event==='cache_miss').length,1);assert.equal(rows.filter(r=>r.event==='cache_hit').length,1);
 assert.ok(!JSON.stringify(rows).includes('PRIVATE'));assert.equal(f.calls,1);
});
