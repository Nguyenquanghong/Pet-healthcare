// Read-only experiment, fixed marked local Q6 trial. No application settings changed.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '../../../services/clinic/src/generated/client/index.js';
import {guard} from '../../../benchmarks/phase2/kaggle/cqrs_runtime.mjs';
import {captureStatement,sanitizePlan} from '../../../benchmarks/phase2/kaggle/cqrs_query_plans.mjs';
import {ProjectedAppointmentQueries} from '../../../services/clinic/dist/infrastructure/queries/projectedAppointments.js';
import {assertTestProject} from '../test-project.mjs';
const args=process.argv.slice(2);
if(args.join(' ')==='--help'){console.log('Usage: compare-query-plans.mjs --run <local Q6 context.json> [--merge|--serial-memory|--one-worker]\nFixed marked trial, 100k rows, read-only AB/BA plans (default versus serial unless candidate specified); no migration/data writes/persistent config changes. Settings are transaction-local. PASS means aggregate parity, not performance acceptance.');process.exit(0);}
assert.ok(args.length===2||args.length===3);assert.equal(args[0],'--run');if(args[2])assert.ok(['--merge','--serial-memory','--one-worker'].includes(args[2]));const candidate=args[2]?.slice(2)??'serial';const path=resolve(args[1]);assert.ok(path.startsWith(resolve('test-results/phase2/cqrs')+sep));
const c=JSON.parse(readFileSync(path,'utf8'));assert.equal(c.kind,'cqrs-q6-local-v1');assertTestProject();
const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',c.schema);url.searchParams.set('connection_limit','1');
const db=new PrismaClient({datasourceUrl:url.href}),out=resolve('test-results/phase2/cqrs/plan-compare-'+randomUUID());mkdirSync(out);
const report={status:'STARTING',schema:c.schema,candidate,scope:'readonly default/candidate SQL diagnosis; not HTTP performance acceptance',capacityAccepted:false,results:[]};
try{
 await guard(db,url,c);assert.equal(await db.appointment.count(),100000);
 const control=await db.readProjectionControl.findUniqueOrThrow({where:{projectionName:'appointments'},include:{activeGeneration:true}});
 assert.equal(control.activeGenerationId,c.generation);assert.equal(control.activeGeneration.state,'ACTIVE');assert.ok(control.activeGeneration.verifiedAt);
 const cases=[['admin-list',{pageSize:'100'}],['admin-search',{q:'Mèo',pageSize:'100'}],['admin-page',{page:'500',pageSize:'100'}],['admin-calendar',{month:'2028-02'}]];
 for(let repeat=0;repeat<6;repeat++)for(const mode of repeat%2?[candidate,'default']:['default',candidate])for(const [operation,query] of cases){
  const result=await db.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');await tx.$executeRawUnsafe("SET LOCAL statement_timeout='3000ms'");
   if(mode==='serial')await tx.$executeRawUnsafe('SET LOCAL max_parallel_workers_per_gather=0');
   if(mode==='one-worker')await tx.$executeRawUnsafe('SET LOCAL max_parallel_workers_per_gather=1');
   if(mode==='serial-memory'){await tx.$executeRawUnsafe('SET LOCAL max_parallel_workers_per_gather=0');await tx.$executeRawUnsafe("SET LOCAL work_mem='8MB'");}
   if(mode==='merge'){await tx.$executeRawUnsafe('SET LOCAL enable_hashjoin=off');await tx.$executeRawUnsafe('SET LOCAL enable_nestloop=off');}
   const sql=await captureStatement(tx,ProjectedAppointmentQueries,c.generation,operation,query);
   const rows=(await tx.$queryRawUnsafe(sql.text,...sql.values)).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
   const plan=sanitizePlan(await tx.$queryRawUnsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+sql.text,...sql.values));
   return {rows,plan};
  },{isolationLevel:'RepeatableRead',maxWait:50,timeout:6500});
  const prior=report.results.find(r=>r.operation===operation);if(prior)assert.deepEqual(result.rows,prior.rows);
  report.results.push({repeat,mode,operation,...result});
 }
 report.status='PASS';
 for(const [operation] of cases)for(const mode of ['default',candidate]){
  const times=report.results.filter(r=>r.operation===operation&&r.mode===mode).map(r=>r.plan['Execution Time']).sort((a,b)=>a-b);
  console.log(JSON.stringify({operation,mode,minMs:times[0],medianMs:(times[2]+times[3])/2,maxMs:times.at(-1)}));
 }
}catch(error){report.status='FAIL';report.errorType=error.name;process.exitCode=1;}
finally{await db.$disconnect();writeFileSync(resolve(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,output:out}));}
