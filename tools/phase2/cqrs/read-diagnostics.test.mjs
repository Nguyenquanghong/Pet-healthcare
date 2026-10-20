import test from 'node:test';
import assert from 'node:assert/strict';
import {ReadDiagnostics,diagnosticOperation} from '../../../services/clinic/dist/readDiagnostics.js';
import {ReadFreshness} from '../../../services/clinic/dist/readFreshness.js';
import {ServingAppointmentQueries} from '../../../services/clinic/dist/infrastructure/queries/servingAppointments.js';

const capture=()=>{const rows=[];return {rows,diag:new ReadDiagnostics(true,line=>rows.push(JSON.parse(line.slice('CLINIC_READ_DIAGNOSTIC '.length))))};};
const error=Object.assign(new Error('PRIVATE SQL/token/password'),{code:'P2010',meta:{code:'57014',message:'PRIVATE SQL/params'},clientVersion:'PRIVATE'});
const control={activeGenerationId:'private-generation',servingMode:'projection',activeGeneration:{state:'ACTIVE',verifiedAt:new Date(),schemaVersion:1,projectionName:'appointments'}};

test('diagnostics is opt-in, isolates concurrent contexts and never emits private error fields',async()=>{
 let called=false;const disabled=new ReadDiagnostics(false,()=>{throw new Error('must not log');});
 assert.equal(await disabled.run('admin-search',async id=>{called=true;assert.equal(id,undefined);disabled.emit('projection_failure','query_error',error);return 42;}),42);assert.ok(called);
 const {diag,rows}=capture();let release;const held=new Promise(r=>release=r);
 const first=diag.run('admin-search',async()=>{diag.mark('projection-counts');await held;diag.emit('projection_failure','query_error',error);});
 await diag.run('owner-calendar',async()=>{diag.mark('projection-calendar');diag.emit('projection_failure','query_error',{code:'PRIVATE',meta:{code:'SECRET'}});});release();await first;
 const failures=rows.filter(r=>r.event==='projection_failure');assert.deepEqual(failures.map(r=>[r.id,r.operation,r.stage]),[[2,'owner-calendar','projection-calendar'],[1,'admin-search','projection-counts']]);
 assert.equal(failures[1].prismaCode,'P2010');assert.equal(failures[1].sqlState,'57014');assert.equal(failures[0].prismaCode,null);
 assert.ok(!JSON.stringify(rows).includes('PRIVATE'));assert.ok(!JSON.stringify(rows).includes('SECRET'));
 const bad=new ReadDiagnostics(true,()=>{throw new Error('sink broken');});
 assert.equal(await bad.run('admin-list',async()=>{bad.emit('projection_failure','query_error',error);return 7;}),7);
});

test('diagnostic writes/cardinality are bounded with an explicit terminal marker',async()=>{
 const {diag,rows}=capture();await diag.run('admin-list',async()=>{for(let n=0;n<2000;n++)diag.emit('projection_failure','query_error',error);});
 assert.equal(rows.length,513);assert.equal(rows.at(-1).event,'limit');assert.equal(rows.at(-1).sequence,513);
 assert.equal(diagnosticOperation(false,false,{q:'PRIVATE'}),'admin-search');
 assert.equal(diagnosticOperation(false,false,{page:'40'}),'admin-page');
 assert.equal(diagnosticOperation(false,false,{page:{toString:'PRIVATE'}}),'admin-list');
 assert.equal(diagnosticOperation(false,false,{petId:'PRIVATE'}),'admin-filter');
});

test('projection SQL failure keeps fallback contract, stage, correlation and original time budgets',async()=>{
 const {diag,rows}=capture(),options=[],statements=[];
 const tx={$executeRawUnsafe:async sql=>statements.push(sql),readProjectionControl:{findUnique:async()=>control}};
 const db={$transaction:async(fn,opt)=>{options.push(opt);return fn(tx);}};
 const serving=new ServingAppointmentQueries(db,{usable:()=>true},diag);let calls=0;
 const result=await diag.run('admin-list',()=>serving.read(async()=>{if(++calls===1){diag.mark('projection-counts');throw error;}return {count:123};}));
 assert.deepEqual(result,{data:{count:123},source:'authoritative',degraded:true});assert.equal(calls,2);
 assert.equal(options[0].maxWait,50);assert.ok(options[0].timeout>0&&options[0].timeout<=1250);
 assert.deepEqual([options[1].maxWait,options[1].timeout],[50,2500]);
 assert.deepEqual(statements,['SET TRANSACTION READ ONLY',"SET LOCAL statement_timeout='200ms'","SET LOCAL statement_timeout='1500ms'"]);
 assert.deepEqual(rows.filter(r=>!['enabled','admission_ready'].includes(r.event)).map(r=>[r.id,r.event,r.stage,r.sqlState]),[[1,'projection_failure','projection-counts','57014'],[1,'fallback_ok','fallback-commit',null]]);
});

test('fallback busy and source failure remain distinct and propagate the original failure',async()=>{
 const {diag,rows}=capture();let release,started=0,ready;const entered=new Promise(r=>ready=r),held=new Promise(r=>release=r);
 const tx={$executeRawUnsafe:async()=>0};const db={$transaction:fn=>fn(tx)};
 const serving=new ServingAppointmentQueries(db,{},diag);
 const run=async()=>{if(++started===2)ready();await held;return 1;};
 const one=serving.read(run,{},true),two=serving.read(run,{},true);await entered;
 await assert.rejects(serving.read(run,{},true),e=>e.status===503);release();await Promise.all([one,two]);
 const sourceError=Object.assign(new Error('PRIVATE'),{code:'P2028'});
 await assert.rejects(serving.read(async()=>{throw sourceError;},{},true),e=>e===sourceError);
 assert.equal(rows.filter(r=>r.event==='fallback_busy').length,1);
 assert.equal(rows.find(r=>r.event==='fallback_error').prismaCode,'P2028');
 assert.deepEqual(serving.stats,{projection:0,fallback:3,rejected:1});
});

test('source transaction acquisition, setup and query failures have distinct stages without retry or budget changes',async()=>{
 for(const stage of ['fallback-acquire','fallback-setup','fallback-query']){
  const {diag,rows}=capture();let attempts=0;
  const failure=Object.assign(new Error('PRIVATE'),{code:'P2028'});
  const db={$transaction:async(fn,options)=>{
   attempts++;assert.deepEqual(options,{isolationLevel:'RepeatableRead',maxWait:50,timeout:2500});
   if(stage==='fallback-acquire')throw failure;
   return fn({$executeRawUnsafe:async sql=>{assert.equal(sql,"SET LOCAL statement_timeout='1500ms'");if(stage==='fallback-setup')throw failure;}});
  }};
  const serving=new ServingAppointmentQueries(db,{},diag);
  await assert.rejects(diag.run('admin-unbilled',()=>serving.read(async()=>{throw failure;},{},true)),e=>e===failure);
  assert.equal(attempts,1);const event=rows.find(r=>r.event==='fallback_error');
  assert.equal(event.stage,stage);assert.equal(event.reason,'forced_source');assert.equal(event.prismaCode,'P2028');
  assert.ok(!JSON.stringify(rows).includes('PRIVATE'));
 }
});

test('freshness diagnostics distinguish broker/database faults and preserve fail-closed age/lag limits',async()=>{
 const {diag,rows}=capture();let broker=false;
 const db={$transaction:async()=>{throw error;}};
 const freshness=new ReadFreshness(db,async()=>broker,()=>10000,diag);
 await freshness.sample();assert.equal(freshness.evidence,undefined);broker=true;await freshness.sample();assert.equal(freshness.evidence,undefined);
 assert.deepEqual(rows.filter(r=>r.event==='sample_error').map(r=>[r.stage,r.reason,r.sqlState]),[['freshness-broker','broker_unavailable',null],['freshness-acquire','sample_error','57014']]);
 for(const [patch,reason] of [[{sampledAt:3999},'freshness_expired'],[{sampledAt:10001},'freshness_clock'],[{lagMs:5001},'freshness_lag'],[{generation:'old'},'freshness_generation'],[{healthy:false},'freshness_unhealthy'],[{sampledAt:NaN},'freshness_clock']]){
  freshness.evidence={generation:'g',sampledAt:10000,lagMs:0,healthy:true,...patch};assert.equal(freshness.unusableReason('g'),reason);assert.equal(freshness.usable('g'),false);
 }
 freshness.evidence={generation:'g',sampledAt:4000,lagMs:0,healthy:true};assert.equal(freshness.usable('g'),true);
 const serving=new ServingAppointmentQueries({$transaction:fn=>fn({$executeRawUnsafe:async()=>0,readProjectionControl:{findUnique:async()=>control}})},freshness,diag);
 await serving.read(async()=>1);assert.ok(rows.some(r=>r.reason==='freshness_generation'&&r.event==='projection_failure'));
});
