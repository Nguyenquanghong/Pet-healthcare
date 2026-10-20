// Fault process used only by the guarded Q2 integration suite. Never an API/env failpoint.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PrismaClient} from '../../../services/clinic/src/generated/client/index.js';
import {AppointmentProjector} from '../../../services/clinic/dist/appointmentProjector.js';
import {consumeEvents,topology} from '../../../packages/messaging/dist/index.js';
const c=JSON.parse(readFileSync(process.env.CQRS_Q2_CONTEXT,'utf8'));
assert.match(c.schema,/^cqrs_q2_[0-9a-f]{32}$/);assert.equal(c.marker,'cqrs-q2:'+c.run);
const mode=process.argv[2];assert.ok(['before-commit','after-commit'].includes(mode));
const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',c.schema);
const db=new PrismaClient({datasourceUrl:url.href});
assert.deepEqual(await db.$queryRaw`SELECT current_database() AS db,current_user AS role`,[{db:'p2_clinic_test',role:'p2_clinic'}]);
assert.deepEqual(await db.$queryRaw`SELECT marker FROM public.p2_test_marker`,[{marker:'pet-phase2-p1-test:clinic:v1'}]);
const [scope]=await db.$queryRaw`SELECT obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=${c.schema}`;assert.equal(scope.marker,c.marker);
const paused=async stage=>{process.send?.({stage});await new Promise(()=>{});};
const projector=new AppointmentProjector(db,mode==='before-commit'?stage=>stage==='row-written'?paused('before-commit'):Promise.resolve():undefined);
const worker=await consumeEvents('amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679',topology('p2.cqrs-q2.'+c.run).clinicRead,'clinic-read-v1',raw=>projector.apply(raw),
  mode==='after-commit'?{afterCommit:()=>paused('after-commit')}:{});
process.send?.({stage:'ready'});await worker.done;await db.$disconnect();
