import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sanitizePlan,captureStatement,captureStatements,collectQueryPlans} from '../../../benchmarks/phase2/kaggle/cqrs_query_plans.mjs';
import {ProjectedAppointmentQueries as Reader} from '../../../services/clinic/dist/infrastructure/queries/projectedAppointments.js';

const rawPlan=(node={})=>[{'QUERY PLAN':[{Plan:{'Node Type':'Aggregate','Actual Rows':7,'Actual Loops':1,...node},'Planning Time':1,'Execution Time':250}]}];
const fixture=()=>{
 const c={kind:'phase2-kaggle-native-v1',run:randomUUID(),pgPort:54321,datasetProfile:'query-heavy',cqrsConfiguration:'B',replicas:1};
 const url='postgresql://p8_clinic:fixture@127.0.0.1:54321/p8_clinic?schema=public&connection_limit=1';
 const calls=[];let guards=0;
 const tx={$executeRawUnsafe:async sql=>{calls.push(sql);},
  readProjectionControl:{findUnique:async()=>({activeGenerationId:'PRIVATE_GENERATION',servingMode:'projection',activeGeneration:{state:'ACTIVE',verifiedAt:new Date(),schemaVersion:1,projectionName:'appointments'}})},
  appointmentReadRow:{findMany:async()=>[]},appointment:{count:async()=>100000,findMany:async()=>[]},directoryProjection:{findMany:async args=>args.where.kind?[]:[{kind:'pet',id:'PRIVATE_PET'}]},
  $queryRawUnsafe:async(sql,...values)=>{calls.push({sql,values});return rawPlan({'Filter':"owner_id='PRIVATE'"});}};
 const db={$queryRaw:async()=>++guards===1?[{database:'p8_clinic',role:'p8_clinic',schema:'public'}]:[{run:c.run}],
  $transaction:async(fn,options)=>{calls.push(options);return fn(tx);}};
 return {c,url,tx,db,calls};
};

test('plan export drops identifiers/expressions/unknown fields, retaining useful bounded metrics',()=>{
 const out=sanitizePlan(rawPlan({'Relation Name':'PRIVATE','Index Name':'PRIVATE','Filter':"id='SECRET'",Output:['SECRET'],Workers:[{secret:'PRIVATE'}],
  Plans:[{'Node Type':'Hash Join','Join Type':'Inner','Actual Rows':100000,'Shared Read Blocks':40,'Plan Rows':10,'Hash Cond':'PRIVATE',Plans:[{'Node Type':'Seq Scan','Actual Loops':3,'Actual Rows':33333}]}]}));
 assert.equal(out.Plan.Plans[0]['Actual Rows'],100000);assert.equal(out.Plan.Plans[0].Plans[0]['Actual Loops'],3);
 assert.ok(!JSON.stringify(out).includes('PRIVATE')&&!JSON.stringify(out).includes('SECRET'));
 assert.equal(out['Execution Time'],250);assert.equal(out.truncated,false);
 assert.throws(()=>sanitizePlan([]));
 const large=sanitizePlan(rawPlan({Plans:Array.from({length:10000},()=>({'Node Type':'Seq Scan','Total Cost':Infinity}))}));
 assert.equal(large.truncated,true);assert.equal(large.Plan.Plans.length,63);
 const cycle={'Node Type':'Hash'};cycle.Plans=[cycle];assert.equal(sanitizePlan(rawPlan(cycle)).truncated,true);
});

test('capture uses real projected SQL with ACL and bound search values, never executes target SELECT or directory HTTP',async()=>{
 const {tx}=fixture();let selects=0;tx.$queryRawUnsafe=async()=>{selects++;throw new Error('must not execute');};
 const list=await captureStatement(tx,Reader,'PRIVATE_GENERATION','admin-list',{pageSize:'100'});
 const page=await captureStatement(tx,Reader,'PRIVATE_GENERATION','admin-page',{page:'500',pageSize:'100'});
 assert.equal(list.text,page.text);assert.deepEqual(list.values,page.values);
 const search=await captureStatement(tx,Reader,'PRIVATE_GENERATION','admin-search',{q:'Mèo',pageSize:'100'});
 const calendar=await captureStatement(tx,Reader,'PRIVATE_GENERATION','admin-calendar',{month:'2028-02'});
 for(const q of [list,search,calendar]){
  assert.match(q.text,/JOIN appointments a ON a.id=p\."appointmentId"/);
  assert.match(q.text,/a.owner_id=p\."ownerId" AND a.pet_id=p\."petId"/);
  assert.ok(q.values.includes('PRIVATE_GENERATION'));assert.ok(!q.text.includes('PRIVATE'));
 }
 assert.ok(search.values.includes('PRIVATE_PET')&&search.values.includes('%Mèo%'));assert.match(calendar.text,/GROUP BY p\.status,p\."appointmentDate",p\.type/);assert.equal(selects,0);
 class Writer{constructor(db){this.db=db;}async list(){await this.db.$executeRawUnsafe('DELETE FROM appointments');}}
 await assert.rejects(captureStatement(tx,Writer,'g','admin-list',{}));
});

test('native target/profile/configuration and marker guards reject before loading reader or explaining',async()=>{
 for(const patch of [{kind:'cqrs-q6-local-v1'},{datasetProfile:'pcn'},{cqrsConfiguration:'A'},{replicas:2},{run:'not-uuid'}]){
  const f=fixture();await assert.rejects(collectQueryPlans({$queryRaw:()=>assert.fail('DB touched')},f.url,{...f.c,...patch},()=>assert.fail('reader loaded')));
 }
 const f=fixture();f.db.$queryRaw=async()=>[{database:'main',role:'postgres',schema:'public'}];
 await assert.rejects(collectQueryPlans(f.db,f.url,f.c,()=>assert.fail('reader loaded')));assert.equal(f.calls.length,0);
});

test('four real-reader plans use read-only bounded transactions and parameters; output contains no SQL or fixture values',async()=>{
 const f=fixture();const out=await collectQueryPlans(f.db,f.url,f.c,async()=>Reader);
 assert.equal(out.status,'COLLECTED');assert.equal(out.results.length,4);assert.equal(out.requestsRunning,false);assert.equal(out.capacityAccepted,false);
 assert.ok(!JSON.stringify(out).includes('PRIVATE'));assert.ok(!JSON.stringify(out).includes('SELECT '));
 assert.deepEqual(f.calls.filter(x=>typeof x==='object'&&x.timeout).map(x=>x.timeout),[6000,6000,6000,6000]);
 const statements=f.calls.filter(x=>typeof x==='string');assert.equal(statements.filter(x=>x==='SET TRANSACTION READ ONLY').length,4);
 assert.equal(statements.filter(x=>x==="SET LOCAL statement_timeout='3000ms'").length,4);
 assert.equal(statements.filter(x=>x==="SET LOCAL plan_cache_mode='force_custom_plan'").length,4);
 const plans=f.calls.filter(x=>x.sql);assert.equal(plans.length,4);assert.ok(plans.every(x=>x.sql.startsWith('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT ')&&x.values[0]==='PRIVATE_GENERATION'));
});

test('timeout is retained as unavailable per operation without retry; broken fixture never runs EXPLAIN',async()=>{
 const f=fixture();let count=0;f.tx.$queryRawUnsafe=async()=>{count++;throw {code:'P2010',meta:{code:'57014',message:'SECRET'},message:'PRIVATE'};};
 const out=await collectQueryPlans(f.db,f.url,f.c,async()=>Reader);assert.equal(out.status,'PARTIAL');assert.equal(count,4);
 assert.ok(out.results.every(r=>r.status==='UNAVAILABLE'&&r.sqlState==='57014'));assert.ok(!JSON.stringify(out).includes('PRIVATE'));
 const wrong=fixture();wrong.tx.appointment.count=async()=>999;wrong.tx.$queryRawUnsafe=async()=>assert.fail('EXPLAIN on wrong fixture');
 const denied=await collectQueryPlans(wrong.db,wrong.url,wrong.c,async()=>Reader);assert.equal(denied.status,'PARTIAL');
});

test('collector records all bounded statements and rejects misleading single-part capture',async()=>{
 const f=fixture();let seeks=0;
 f.tx.appointment.findMany=async()=>++seeks%2?[{id:'PRIVATE_MIDDLE'},{id:'PRIVATE_NEXT'}]:[];
 const parts=await captureStatements(f.tx,Reader,'PRIVATE_GENERATION','admin-list',{});
 assert.equal(parts.length,2);assert.ok(parts.every(p=>p.values.includes('PRIVATE_MIDDLE')));
 await assert.rejects(captureStatement(f.tx,Reader,'PRIVATE_GENERATION','admin-list',{}),/PLAN_QUERY_COUNT/);
 const out=await collectQueryPlans(f.db,f.url,f.c,async()=>Reader);
 assert.equal(out.version,2);assert.equal(out.status,'COLLECTED');
 assert.deepEqual(out.results.map(r=>r.statementCount),[2,2,2,2]);
 assert.ok(out.results.every(r=>r.statements.length===r.statementCount));
 assert.ok(!JSON.stringify(out).includes('PRIVATE'));
});
