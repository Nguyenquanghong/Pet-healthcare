import test from 'node:test';
import assert from 'node:assert/strict';
import {Prisma} from '../../../services/clinic/dist/generated/client/index.js';
import {boundedAppointmentAggregate} from '../../../services/clinic/dist/infrastructure/queries/boundedAppointmentAggregate.js';
import {AppointmentAggregateCache} from '../../../services/clinic/dist/infrastructure/queries/appointmentAggregateCache.js';
import {ReadDiagnostics} from '../../../services/clinic/dist/readDiagnostics.js';

const statement=range=>Prisma.sql`SELECT test FROM source WHERE authorized=true ${range}`;
test('aggregate combines disjoint ranges, keeps status/date/type keys separate and binds arbitrary string boundaries',async()=>{
 const cursors=[[{id:"odd' boundary"},{id:'next'}],[{id:'last'}]],queries=[],where=[];
 const tx={appointment:{findMany:async args=>{where.push(args);return cursors.shift();}},$queryRaw:async sql=>{
  queries.push(sql);return queries.length===1?[{status:'pending',date:new Date('2028-02-01'),type:'spa',n:2,held:1}]:[
   {status:'pending',date:new Date('2028-02-01'),type:'spa',n:3,held:2},{status:'pending',date:new Date('2028-02-02'),type:'spa',n:1,held:0}];
 }};
 const rows=await boundedAppointmentAggregate(tx,'g',statement,r=>JSON.stringify([r.status,r.date,r.type]));
 assert.deepEqual(rows.map(r=>[r.n,r.held]),[[5,3],[1,0]]);
 assert.deepEqual(where[0].where,{});assert.deepEqual(where[1].where,{id:{gt:"odd' boundary"}});
 assert.equal(where[0].skip,39999);assert.equal(where[0].take,2);
 assert.match(queries[0].text,/p\."appointmentId"<=\$1 AND a.id<=\$2/);
 assert.match(queries[1].text,/p\."appointmentId">\$1 AND a.id>\$2/);
 assert.ok(queries.every(q=>q.text.includes('authorized=true')&&!q.text.includes("odd'")));
 assert.deepEqual(queries.map(q=>q.values),[["odd' boundary","odd' boundary"],["odd' boundary","odd' boundary"]]);
});
test('empty and exactly full final batch terminate; expired deadline touches no DB',async()=>{
 for(const cursor of [[],[{id:'last'}]]){
  let calls=0;const tx={appointment:{findMany:async()=>cursor},$queryRaw:async()=>{calls++;return [];}};
  assert.deepEqual(await boundedAppointmentAggregate(tx,'g',statement,r=>r.status),[]);assert.equal(calls,1);
 }
 await assert.rejects(boundedAppointmentAggregate({},'g',statement,r=>r.status,performance.now()-1),/DEADLINE/);
});
test('failure in a later part rejects the whole aggregate and cannot populate cache',async()=>{
 let parts=0,cursors=0,fail=true;
 const epochs=['directory','projection','source-acl'].map(scope=>({scope,revision:'1',readOnly:'on',isolation:'repeatable read'}));
 const tx={appointment:{findMany:async()=>++cursors%2?[{id:'middle'},{id:'next'}]:[]},$queryRaw:async sql=>{
  if(Array.isArray(sql))return epochs;
  parts++;if(fail&&parts===2)throw new Error('TRIAL_SQL_TIMEOUT');return [{status:'pending',n:1,held:0}];
 }};
 const cache=new AppointmentAggregateCache(),sql=statement(Prisma.empty),read=()=>cache.read(tx,sql,'admin',undefined,undefined,()=>boundedAppointmentAggregate(tx,'g',statement,r=>r.status));
 await assert.rejects(read(),/TRIAL_SQL_TIMEOUT/);fail=false;
 assert.deepEqual(await read(),[{status:'pending',n:2,held:0}]);assert.equal(parts,4);
 assert.deepEqual(await read(),[{status:'pending',n:2,held:0}]);assert.equal(parts,4);
});

test('failure telemetry distinguishes boundary lookup, first aggregate and later aggregate without exposing keys',async()=>{
 for(const failure of ['boundary','first','next']){
  const events=[],diagnostics=new ReadDiagnostics(true,line=>events.push(JSON.parse(line.slice('CLINIC_READ_DIAGNOSTIC '.length))));
  let boundaries=0,parts=0;
  const tx={appointment:{findMany:async()=>{
   if(failure==='boundary')throw {code:'P2010',meta:{code:'57014'},message:'PRIVATE'};
   return ++boundaries===1?[{id:'PRIVATE_BOUNDARY'},{id:'PRIVATE_NEXT'}]:[];
  }},$queryRaw:async()=>{
   parts++;if(failure==='first'||parts===2)throw {code:'P2010',meta:{code:'57014'},message:'PRIVATE'};
   return [{status:'pending',n:1,held:0}];
  }};
  await diagnostics.run('admin-list',async()=>{
   await assert.rejects(boundedAppointmentAggregate(tx,'PRIVATE_GEN',statement,r=>r.status,undefined,diagnostics),error=>{
    diagnostics.emit('projection_failure','query_error',error);return true;
   });
  });
  const event=events.find(e=>e.event==='projection_failure');
  assert.equal(event.stage,'projection-aggregate-'+failure);assert.equal(event.sqlState,'57014');
  assert.ok(!JSON.stringify(events).includes('PRIVATE'));
 }
});

test('deadline exhausted during boundary lookup never starts the aggregate',async()=>{
 let deadline=performance.now()+15;
 const tx={appointment:{findMany:async()=>{await new Promise(r=>setTimeout(r,25));return [];}},$queryRaw:()=>assert.fail('expired aggregate executed')};
 await assert.rejects(boundedAppointmentAggregate(tx,'g',statement,r=>r.status,deadline),/DEADLINE/);
});
