// Experimental indexes only, inside a previously marked fixed local Q6 schema.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {PrismaClient} from '../../../services/clinic/src/generated/client/index.js';
import {guard} from '../../../benchmarks/phase2/kaggle/cqrs_runtime.mjs';
import {assertTestProject} from '../test-project.mjs';
const args=process.argv.slice(2);assert.equal(args.length,2);assert.ok(['--run','--rollback'].includes(args[0]));
const path=resolve(args[1]);assert.ok(path.startsWith(resolve('test-results/phase2/cqrs')+sep));
const c=JSON.parse(readFileSync(path,'utf8'));assert.equal(c.kind,'cqrs-q6-local-v1');assertTestProject();
const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',c.schema);url.searchParams.set('connection_limit','1');
const db=new PrismaClient({datasourceUrl:url.href});
try{
 await guard(db,url,c);assert.equal(await db.appointment.count(),100000);
 if(args[0]==='--rollback'){
  const rows=await db.$queryRaw`SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname IN ('q6_trial_source_acl','q6_trial_read_aggregate') ORDER BY indexname`;
  assert.deepEqual(rows.map(r=>r.indexname),['q6_trial_read_aggregate','q6_trial_source_acl']);
  await db.$executeRawUnsafe('DROP INDEX "q6_trial_read_aggregate"');await db.$executeRawUnsafe('DROP INDEX "q6_trial_source_acl"');
  console.log(JSON.stringify({status:'EXPERIMENT_INDEXES_REMOVED',schema:c.schema}));
 }else{
 // Omit unbounded note/serviceName text: INCLUDE must not impose a new index-tuple size limit on commands.
 await db.$executeRawUnsafe('CREATE INDEX "q6_trial_source_acl" ON appointments(id) INCLUDE(owner_id,pet_id)');
 await db.$executeRawUnsafe('CREATE INDEX "q6_trial_read_aggregate" ON "AppointmentReadRow"(generation,"appointmentId") INCLUDE("ownerId","petId",status,"billingHeld","appointmentDate",type) WHERE "deletedAt" IS NULL');
 await db.$executeRawUnsafe('ANALYZE appointments');await db.$executeRawUnsafe('ANALYZE "AppointmentReadRow"');
 const indexes=await db.$queryRaw`SELECT indexrelname,pg_relation_size(indexrelid)::text AS bytes FROM pg_stat_user_indexes WHERE schemaname=current_schema() AND indexrelname LIKE 'q6_trial_%' ORDER BY indexrelname`;
 const report={status:'EXPERIMENT_ONLY',schema:c.schema,indexes,applicationMigrationAdded:false,capacityAccepted:false};
 writeFileSync(resolve('test-results/phase2/cqrs/q6-plan-tuning-20261017/trial-indexes.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }
}finally{await db.$disconnect();}
