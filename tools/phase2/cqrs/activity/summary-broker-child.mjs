// Fault process for the guarded D2 broker cases only. Never an API/env failpoint.
// Pauses either inside the V2 transaction (after a counter write) or after commit
// before ACK, so the parent can SIGKILL at that exact point.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PrismaClient} from '../../../../services/clinic/src/generated/client/index.js';
import {AppointmentProjector} from '../../../../services/clinic/dist/appointmentProjector.js';
import {consumeEvents,topology} from '../../../../packages/messaging/dist/index.js';
const c=JSON.parse(readFileSync(process.env.ACTIVITY_D2_CONTEXT,'utf8')),hex=c.run.replaceAll('-','');
assert.equal(c.schema,'activity_d2_'+hex);assert.equal(c.marker,'clinic-activity-d2:'+c.run);assert.equal(c.roles.projector,'act_d2_p_'+hex);
const mode=process.argv[2];assert.ok(['before-commit','after-commit'].includes(mode));
const url=new URL('postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test');url.searchParams.set('schema',c.schema);url.searchParams.set('connection_limit','1');
const base=new PrismaClient({datasourceUrl:url.href});
assert.deepEqual(await base.$queryRaw`SELECT current_database() AS db,current_user AS role`,[{db:'p2_clinic_test',role:'p2_clinic'}]);
assert.deepEqual(await base.$queryRaw`SELECT marker FROM public.p2_test_marker`,[{marker:'pet-phase2-p1-test:clinic:v1'}]);
const [scope]=await base.$queryRaw`SELECT obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=${c.schema}`;assert.equal(scope.marker,c.marker);
const db=new Proxy(base,{get(t,k){if(k==='$transaction')return (work,options)=>t.$transaction(async tx=>{await tx.$executeRawUnsafe(`SET LOCAL ROLE "${c.roles.projector}"`);return work(tx);},options);const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
const paused=async stage=>{process.send?.({stage});await new Promise(()=>{});};
const projector=new AppointmentProjector(db,mode==='before-commit'?stage=>stage==='summary-incremented'?paused('before-commit'):Promise.resolve():undefined);
const worker=await consumeEvents('amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679',topology('p2.activity-d2.'+c.run).clinicRead,'clinic-read-v1',raw=>projector.apply(raw),
  mode==='after-commit'?{afterCommit:()=>paused('after-commit')}:{});
process.send?.({stage:'ready'});await worker.done;await base.$disconnect();
