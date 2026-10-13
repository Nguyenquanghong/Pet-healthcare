// Regression against the actual root Compose, with fresh project-scoped volumes.
// Never reads .env.docker, starts the user's project, seeds or deletes a volume.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { prepareNotifications } from './prepare-notifications.mjs';
import { preparePhase2 } from './prepare-phase2.mjs';

const strict = process.argv.includes('--phase2');
if(process.argv.slice(2).some(arg=>arg!=='--phase2'))throw new Error('Unknown argument');
const run = randomUUID(), project = (strict?'pet-split-test-':'pet-a01-test-') + run;
const dir = resolve('test-results/phase2/' + (strict?'split-':'a01-') + run);
mkdirSync(dir, { recursive:true });
const envFile = resolve(dir,'.env'), override = resolve(dir,'compose.json');
const log = resolve(dir,'docker.log'), checks = [];
const password = randomBytes(32).toString('hex');
const socket = createServer();
await new Promise((ok,fail)=>{socket.once('error',fail);socket.listen(0,'127.0.0.1',ok);});
const port = socket.address().port;
await new Promise(ok=>socket.close(ok));
writeFileSync(envFile, `POSTGRES_PASSWORD=${password}\nDATABASE_URL=postgresql://nipopeto:${password}@postgres:5432/nipopeto?schema=public\nPORT=${port}\n`,{flag:'wx',mode:0o600});
prepareNotifications(envFile);
if(strict)preparePhase2(envFile);
// JSON is YAML-compatible. !reset is needed to remove root's published PG port;
// use YAML for this single override so no test SQL endpoint is publicly exposed.
writeFileSync(override, `services:\n  postgres:\n    ports: !reset []\n`, {flag:'wx'});
const composeArgs = ['compose','--project-name',project,'--env-file',envFile,'-f',resolve('docker-compose.yml'),...(strict?['-f',resolve('docker-compose.phase2.yml')]:[]),'-f',override];
const baseEnv = {...process.env,COMPOSE_PARALLEL_LIMIT:'1'};
// Shell values override --env-file; isolate all interpolation inputs from host.
for (const key of Object.keys(baseEnv)) if (/^(JWT_|DATABASE_URL$|POSTGRES_PASSWORD$|NOTIFICATION_|CORE_|CLINIC_|RATE_LIMIT_|OBSERVABILITY_|PHASE2_|REDIS_|BROKER_|PORT$|FRONTEND_PORT$|CORS_ORIGIN$|VNPAY_|BANK_TRANSFER_|COMPOSE_)/.test(key)) delete baseEnv[key];
baseEnv.COMPOSE_PARALLEL_LIMIT = '1';
async function docker(args, input) {
  return new Promise((ok,fail)=>{
    const child=spawn('docker',args,{env:baseEnv,stdio:['pipe','pipe','pipe'],windowsHide:true});
    let output='';
    child.stdout.on('data',b=>{output+=b;}); child.stderr.on('data',b=>{output+=b;});
    child.once('error',fail);
    const timer=setTimeout(()=>{child.kill();fail(new Error('Docker command timed out'));},600000);
    child.once('close',code=>{clearTimeout(timer);if(code===0)ok(output);else{appendFileSync(log,output);const error=new Error(`Docker command failed (${code}); see private artifact log`);Object.defineProperty(error,'dockerOutput',{value:output});fail(error);}});
    child.stdin.end(input);
  });
}
const compose = (...args)=>docker([...composeArgs,...args]);
const exec = (service,args,input)=>docker([...composeArgs,'exec','-T',service,...args],input);
async function owned(service) {
  const id=(await compose('ps','-q',service)).trim();assert.match(id,/^[a-f0-9]{12,64}$/);
  const [container]=JSON.parse(await docker(['inspect',id]));
  assert.equal(container.Config.Labels['com.docker.compose.project'],project);
  assert.equal(container.Config.Labels['com.docker.compose.service'],service);
  assert.equal(container.State.Running,true);
  for(const mount of container.Mounts) if(mount.Type==='volume')assert.ok(mount.Name.startsWith(project+'_'));
}
const dbUser=service=>service==='postgres'?'nipopeto':service.split('-')[0];
const dbName=service=>service==='postgres'?'nipopeto':'nipopeto_'+dbUser(service);
const sql=(service,query)=>exec(service,['psql','-U',dbUser(service),'-d',dbName(service),'-v','ON_ERROR_STOP=1','-Atc',query]);
async function until(fn,label) {
  const end=Date.now()+30000;
  while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(ok=>setTimeout(ok,200));}
  throw new Error('Timeout: '+label);
}
const origin = `http://127.0.0.1:${port}`;
async function request(path, token, method='GET', body, key) {
  const res=await fetch(origin+'/api'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'content-type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  return {status:res.status,body:res.status===204?null:await res.json()};
}
function expect(response,status){assert.equal(response.status,status,JSON.stringify(response.body));return response.body;}
function passed(name){checks.push(name);console.log('PASS '+name);}
let result='FAIL';
try {
  // Refuse any existing project/volumes, even before starting migrations.
  assert.equal((await docker(['ps','-aq','--filter','label=com.docker.compose.project='+project])).trim(),'');
  assert.equal((await docker(['volume','ls','-q','--filter','label=com.docker.compose.project='+project])).trim(),'');
  const config=JSON.parse(await compose('config','--format','json'));
  assert.equal(config.services.api.environment.NOTIFICATION_SERVICE_URL,'http://notification-api:5102');
  assert.equal(config.services.api.environment.JWT_PRIVATE_KEY.startsWith('-----BEGIN PRIVATE KEY-----'),true);
  for(const name of ['notification-api','notification-worker']) {
    assert.equal(config.services[name].environment.JWT_PRIVATE_KEY,undefined);
    assert.equal(config.services[name].environment.JWT_SECRET,undefined);
    assert.equal(new URL(config.services[name].environment.DATABASE_URL).hostname,'notification-postgres');
  }
  assert.equal(config.services.postgres.ports,undefined);
  for(const name of ['notification-postgres','rabbitmq','notification-api'])assert.equal(config.services[name].ports,undefined);
  passed('Compose wiring, isolated DB and verifier-only Notification credentials');
  if(strict){
    for(const name of ['api','clinic-api','notification-api','clinic-worker','notification-worker','core-outbox','core-billing'])assert.equal(config.services[name].environment.PHASE2_RUNTIME_REQUIRED,'1');
    for(const name of ['clinic-api','clinic-worker']){
      assert.equal(config.services[name].environment.JWT_PRIVATE_KEY,undefined);
      assert.equal(config.services[name].environment.JWT_SECRET,undefined);
      assert.equal(new URL(config.services[name].environment.DATABASE_URL).hostname,'clinic-postgres');
    }
    for(const name of ['clinic-api','clinic-postgres','redis'])assert.equal(config.services[name].ports,undefined);
    passed('Strict runtime, separate Clinic DB and no signing key on Clinic');
  }
  console.log('Building shared Docker layers; project '+project);
  appendFileSync(log,await compose('build','api','migrate','notification-api','notification-migrate','notification-worker','core-outbox',...(strict?['clinic-api','clinic-migrate','clinic-worker','core-billing']:[])));
  console.log('Starting isolated Compose stack');
  appendFileSync(log,await compose('up','-d','--no-build','--pull','never','--wait','--wait-timeout','150','api','core-outbox','notification-worker',...(strict?['clinic-worker','core-billing']:[])));
  for(const service of ['postgres','notification-postgres','rabbitmq','api','notification-api','core-outbox','notification-worker',...(strict?['clinic-postgres','clinic-api','clinic-worker','core-billing','redis']:[])])await owned(service);
  for(const service of ['postgres','notification-postgres',...(strict?['clinic-postgres']:[])]) {
    const expected=dbName(service)+'|'+dbUser(service);
    assert.equal((await sql(service,'SELECT current_database(),current_user')).trim(),expected);
    await sql(service,`CREATE TABLE a01_test_marker (marker text PRIMARY KEY); INSERT INTO a01_test_marker VALUES ('${project}')`);
    assert.equal((await sql(service,'SELECT marker FROM a01_test_marker')).trim(),project);
  }
  passed('Root Compose migrations and containers start on fresh marked volumes');
  // Only after the marker and container/volume guards may a fixture be written.
  const admin=randomUUID(), userPassword=randomBytes(24).toString('hex');
  await exec('api',['node','--input-type=module','-'],`
    import assert from 'node:assert/strict';
    import {PrismaClient} from '@prisma/client';
    import {hashPasswordAsync} from './backend/dist/src/lib/password.js';
    const db=new PrismaClient();
    try{const rows=await db.$queryRawUnsafe('SELECT marker FROM a01_test_marker');assert.equal(rows[0].marker,${JSON.stringify(project)});
    await db.user.create({data:{id:${JSON.stringify(admin)},username:'a01_admin',fullName:'A01 fixture',role:'admin',...await hashPasswordAsync(${JSON.stringify(userPassword)})}});
    }finally{await db.$disconnect();}
  `);
  const adminToken=expect(await request('/auth/admin/login',null,'POST',{username:'a01_admin',password:userPassword}),200).token;
  const register=async name=>expect(await request('/auth/owner/register',null,'POST',{email:`${name}-${run}@example.test`,fullName:'A01 fixture',password:userPassword,confirmPassword:userPassword}),201);
  const owner=await register('owner'),other=await register('other');
  expect(await request('/notifications/unread-count'),401);
  assert.equal(expect(await request('/notifications/unread-count',owner.token),200).unread,0);
  passed('Login uses RSA; notification unread endpoint returns 200 instead of 503');
  const pet=expect(await request('/pets',owner.token,'POST',{name:'A01 synthetic pet',species:'dog'}),201).pet;
  const appointmentKey=randomUUID(),appointmentBody={petId:pet.id,type:'spa_bath',date:new Date(Date.now()+30*86400000).toISOString().slice(0,10),time:'10:00',serviceName:'A01 fixture'};
  const appointment=expect(await request('/appointments',owner.token,'POST',appointmentBody,appointmentKey),201).appointment;
  const findAppointment=async()=>expect(await request('/notifications',adminToken),200).items.filter(n=>n.relatedAppointmentId===appointment.id);
  const notices=await until(async()=>{const rows=await findAppointment();return rows.length?rows:false;},'outbox delivery');
  assert.equal(notices.length,1);
  assert.equal((await sql('postgres',`SELECT count(*) FROM notifications WHERE related_appointment_id='${appointment.id}'`)).trim(),'0');
  assert.equal((await sql('notification-postgres',`SELECT count(*) FROM "InboxEvent"`)).trim(),'1');
  passed('Appointment transaction -> '+(strict?'Clinic':'Core')+' outbox -> RabbitMQ -> Notification inbox, one effect and zero Core inserts');
  if(strict){
    assert.equal((await sql('postgres','SELECT count(*) FROM appointments')).trim(),'0');
    assert.equal((await sql('clinic-postgres',`SELECT count(*) FROM appointments WHERE id='${appointment.id}'`)).trim(),'1');
    assert.equal(expect(await request('/appointments',owner.token,'POST',appointmentBody,appointmentKey),201).appointment.id,appointment.id);
    expect(await request('/appointments',owner.token,'POST',appointmentBody,randomUUID()),409);
    await until(async()=>Number((await sql('clinic-postgres','SELECT count(*) FROM "DirectoryProjection"')).trim())>=4,'directory projection delivery');
    let current=appointment;
    for(const status of ['confirmed','checked_in','in_progress','completed'])current=expect(await request('/appointments/'+appointment.id+'/status',adminToken,'PATCH',{status,expectedRevision:current.statusRevision}),200).appointment;
    const checkoutKey=randomUUID(),checkoutBody={type:'appointment',relatedId:appointment.id};
    const invoice=expect(await request('/invoices/checkout',owner.token,'POST',checkoutBody,checkoutKey),200).invoice;
    assert.equal(expect(await request('/invoices/checkout',owner.token,'POST',checkoutBody,checkoutKey),200).invoice.id,invoice.id);
    await until(async()=>(await sql('clinic-postgres',`SELECT state FROM "AppointmentReservation" WHERE "appointmentId"='${appointment.id}'`)).trim()==='INVOICED','reservation finalization');
    assert.equal((await sql('postgres',`SELECT count(*) FROM invoices WHERE appointment_id='${appointment.id}'`)).trim(),'1');
    expect(await request('/appointments/'+appointment.id+'/undo-status',adminToken,'POST',{expectedRevision:current.statusRevision,reason:'Fixture undo must be rejected'}),409);
    passed('Clinic owns appointments, durable replay/slot conflict, directory projection, Core invoice and INVOICED reservation block undo');
  }
  const key=randomUUID(), payload={recipientOwnerId:owner.user.id,title:'A01 fixture notice',message:'Fixture only'};
  const sent=expect(await request('/notifications/send',adminToken,'POST',payload,key),201);
  const replay=expect(await request('/notifications/send',adminToken,'POST',payload,key),201);
  assert.equal(replay.notification.id,sent.notification.id);
  expect(await request('/notifications/send',adminToken,'POST',{...payload,title:'changed'},key),409);
  expect(await request('/notifications/send',owner.token,'POST',payload,randomUUID()),403);
  assert.equal(expect(await request('/notifications',other.token),200).pagination.total,0);
  expect(await request('/notifications/'+sent.notification.id+'/read',other.token,'PATCH',{}),404);
  const unreadBeforeRead=expect(await request('/notifications/unread-count',owner.token),200).unread;
  assert.ok(unreadBeforeRead>=1);
  expect(await request('/notifications/'+sent.notification.id+'/read',owner.token,'PATCH',{}),200);
  assert.equal(expect(await request('/notifications/unread-count',owner.token),200).unread,unreadBeforeRead-1);
  expect(await request('/notifications/read-all',owner.token,'PATCH',{}),200);
  passed('Manual send authorization, replay/conflict, owner isolation and persisted read count');
  await compose('restart','notification-worker');
  await new Promise(ok=>setTimeout(ok,1000));
  assert.equal((await findAppointment()).filter(n=>n.id===notices[0].id).length,1);
  await compose('stop','notification-api');
  expect(await request('/notifications/unread-count',owner.token),503);
  await compose('start','notification-api');
  await until(async()=>{try{return (await request('/notifications/unread-count',owner.token)).status===200;}catch{return false;}},'Notification recovery');
  assert.equal(expect(await request('/notifications/unread-count',owner.token),200).unread,0);
  passed('Worker restart preserves one effect; API outage fails closed and read state survives recovery');
  expect(await request('/owners?pageSize=1',adminToken),200);
  await sql('postgres',`UPDATE users SET role='owner' WHERE id='${admin}'`);
  expect(await request('/owners?pageSize=1',adminToken),403);
  await sql('postgres',`DELETE FROM users WHERE id='${admin}'`);
  expect(await request('/owners?pageSize=1',adminToken),401);
  expect(await request('/auth/me',adminToken),401);
  passed('Real DB role change and account deletion revoke Core access for the previously issued JWT');
  if(strict){
    await sql('postgres',`INSERT INTO booking_status_events (id,kind,booking_id,revision,action,from_status,to_status,actor_id,actor_name,actor_role,created_at) VALUES ('${randomUUID()}','appointment','${appointment.id}',1,'transition','pending','confirmed','${admin}','Fixture','admin',now())`);
    let blocked=false;
    try{await exec('api',['node','tools/docker/core-local-start.mjs']);}catch(error){assert.match(error.dockerOutput??'',/LOCAL_CLINIC_MIGRATION_REQUIRED/);blocked=true;}
    assert.equal(blocked,true);
    passed('Legacy clinical history alone blocks silent local cutover');
  }
  // A legacy row must block a subsequent cutover; only this disposable DB is mutated.
  await sql('postgres',`INSERT INTO notifications (id,recipient_owner_id,recipient_role,type,title,message,status,created_at,sent_at) VALUES ('${randomUUID()}','${owner.user.id}','owner','general','Fixture','Fixture','sent',now(),now())`);
  let blocked=false;
  try { await exec('api',['node','tools/docker/core-local-start.mjs']); }
  catch (error) { assert.match(error.dockerOutput??'',/LOCAL_NOTIFICATION_MIGRATION_REQUIRED/); blocked=true; }
  assert.equal(blocked,true);
  passed('Existing legacy inbox prevents silent cutover');
  result='PASS';
} catch (error) {
  writeFileSync(resolve(dir,'failure.log'),String(error.stack));
  throw error;
} finally {
  // Keep evidence/data; stop only the unique project created by this invocation.
  appendFileSync(log,await compose('logs','--no-color').catch(()=> 'Logs unavailable\n'));
  await compose('stop').catch(()=>{result='FAIL';console.error('Could not stop fixture project '+project);});
  writeFileSync(resolve(dir,'report.json'),JSON.stringify({run,project,result,checks,liveDatabaseTouched:false,volumesRetained:true},null,2));
  console.log('Evidence: '+dir+'; result='+result);
}
if(result!=='PASS')process.exitCode=1;
