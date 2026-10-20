import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,sep,dirname} from 'node:path';
import {PrismaClient} from '../../../services/clinic/src/generated/client/index.js';
import {assertTestProject} from '../test-project.mjs';
import amqp from 'amqplib';
import {topology} from '../../../packages/messaging/dist/index.js';
export const broker='amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679';
export function context(file){
  const path=resolve(file);assert.ok(path.startsWith(resolve('test-results/phase2/cqrs')+sep),'Q5_CONTEXT_PATH');
  const c=JSON.parse(readFileSync(path,'utf8'));assert.match(c.run,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(c.schema,'cqrs_q5_'+c.run.replaceAll('-',''));assert.equal(c.marker,'cqrs-q5:'+c.run);assert.equal(c.prefix,'p2.cqrs-q5.'+c.run);
  assert.equal(resolve(c.output),dirname(path),'Q5_ARTIFACT_PATH');
  return c;
}
export function client(c,pool=1){const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',c.schema);url.searchParams.set('connection_limit',String(pool));url.searchParams.set('application_name',c.schema);return new PrismaClient({datasourceUrl:url.href});}
export async function guard(db,c,{workersStopped=false}={}){
  assertTestProject();
  assert.deepEqual(await db.$queryRaw`SELECT current_database() AS db,current_user AS role`,[{db:'p2_clinic_test',role:'p2_clinic'}]);
  assert.deepEqual(await db.$queryRaw`SELECT marker FROM public.p2_test_marker`,[{marker:'pet-phase2-p1-test:clinic:v1'}]);
  assert.deepEqual(await db.$queryRaw`SELECT obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=${c.schema}`,[{marker:c.marker}]);
  if(workersStopped){const conn=await amqp.connect(broker),ch=await conn.createChannel();try{for(const name of [topology(c.prefix).clinic,topology(c.prefix).clinicRead])assert.equal((await ch.checkQueue(name)).consumerCount,0,'Q5_DRAIN_WORKERS_FIRST');}finally{await ch.close();await conn.close();}}
}
