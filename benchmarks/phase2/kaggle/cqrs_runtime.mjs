// Q6 fixture adoption only. Call before starting any API/writer/projector.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export function configuration(mode){
  assert.ok(['O','A','B'].includes(mode),'Q6_CONFIGURATION');
  return {configuration:mode,readMode:mode==='B'?'projection':'authoritative',projectorEnabled:mode!=='O',shadowEnabled:false,
    apiPool:4,projectorPool:mode==='O'?0:1,freshnessPool:mode==='B'?1:0,capacityAccepted:false};
}
export function apiEnvironment(mode,secret){
  const config=configuration(mode);
  if(mode!=='O')assert.ok(typeof secret==='string'&&secret.length>=32,'Q6_TOKEN_SECRET');
  return {CLINIC_READ_MODE:config.readMode,CLINIC_READ_TOKEN_SECRET:mode==='O'?'':secret,CLINIC_SHADOW_EVERY:'0'};
}
export function validateTarget(url,context){
  assert.match(context.run,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,'Q6_RUN');
  assert.equal(url.hostname,'127.0.0.1');assert.equal(url.searchParams.get('connection_limit'),'1');
  if(context.kind==='phase2-kaggle-native-v1'){
    assert.equal(url.port,String(context.pgPort));assert.equal(url.username,'p8_clinic');assert.equal(url.pathname,'/p8_clinic');
    assert.equal(url.searchParams.get('schema'),'public');
    return {database:'p8_clinic',role:'p8_clinic',schema:'public'};
  }
  assert.equal(context.kind,'cqrs-q6-local-v1');assert.equal(url.port,'55432');
  assert.equal(url.pathname,'/p2_clinic_test');assert.equal(url.username,'p2_clinic');
  const schema='cqrs_q6_'+context.run.replaceAll('-','');assert.equal(url.searchParams.get('schema'),schema);
  return {database:'p2_clinic_test',role:'p2_clinic',schema};
}
export async function guard(db,url,context){
  const target=validateTarget(url,context);
  assert.deepEqual(await db.$queryRaw`SELECT current_database() AS database,current_user AS role,current_schema() AS schema`,[target]);
  if(context.kind==='phase2-kaggle-native-v1'){
    assert.deepEqual(await db.$queryRaw`SELECT run FROM p8_control.marker`,[{run:context.run}]);
  }else{
    assert.deepEqual(await db.$queryRaw`SELECT marker FROM public.p2_test_marker`,[{marker:'pet-phase2-p1-test:clinic:v1'}]);
    assert.deepEqual(await db.$queryRaw`SELECT obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=${target.schema}`,[{marker:'cqrs-q6:'+context.run}]);
  }
}
export async function prepareReadModel(mode,databaseUrl,context){
  const config=configuration(mode);
  // O must also work with the old source which has no CQRS modules or tables.
  if(mode==='O')return {...config,generation:null,rebuild:null};
  const url=new URL(databaseUrl);url.searchParams.set('connection_limit','1');validateTarget(url,context);
  const {PrismaClient}=await import('../../../services/clinic/src/generated/client/index.js');
  const {AppointmentRebuild}=await import('../../../services/clinic/dist/readRebuild.js');
  const db=new PrismaClient({datasourceUrl:url.href}),engine=new AppointmentRebuild(db);
  try{
    await guard(db,url,context);
    assert.equal(await db.readProjectionControl.count(),0,'Q6_FRESH_TRIAL_REQUIRED');
    assert.equal(await db.readRebuildRun.count(),0,'Q6_FRESH_TRIAL_REQUIRED');
    const run=randomUUID(),generation=randomUUID(),started=performance.now();
    await engine.claim(run,generation);
    while(!(await engine.batch(run)).done){}
    const diff=await engine.verify(run);await engine.activate(run);
    // Both A/B start with planner statistics for the bulk-built tables, just
    // as query_dataset analyzes the source fixture before starting services.
    // Do not depend on the autovacuum schedule of a short-lived trial.
    await db.$executeRawUnsafe('ANALYZE "AppointmentReadRow"');
    await db.$executeRawUnsafe('ANALYZE "ClinicReadRevision"');
    // Both trials have the same ACTIVE generation/control state. The API's
    // selector remains authoritative in A; B alone serves the projection.
    await db.readProjectionControl.update({where:{projectionName:'appointments'},data:{servingMode:'projection'}});
    return {...config,generation,rebuild:{seconds:(performance.now()-started)/1000,appointments:await db.appointment.count(),diff}};
  }finally{await engine.close().catch(()=>{});await db.$disconnect();}
}

export async function observeReadModel(db,mode){
  configuration(mode);if(mode==='O')return {configuration:mode,projectorEnabled:false};
  const control=await db.readProjectionControl.findUniqueOrThrow({where:{projectionName:'appointments'},include:{activeGeneration:true}});
  const [lag]=await db.$queryRaw`SELECT count(*)::int AS pending,
    COALESCE(max(EXTRACT(EPOCH FROM (clock_timestamp()-r."changedAt"))*1000),0)::float AS "oldestLagMs"
    FROM "ClinicReadRevision" r LEFT JOIN "AppointmentReadRow" p ON p.generation=${control.activeGenerationId} AND p."appointmentId"=r."aggregateId"
    WHERE r.kind='appointment' AND ((NOT r.deleted AND (p."appointmentId" IS NULL OR p."sourceVersion"<r.version OR p."deletedAt" IS NOT NULL))
      OR (r.deleted AND p."appointmentId" IS NOT NULL AND p."deletedAt" IS NULL))`;
  return {configuration:mode,projectorEnabled:true,generation:control.activeGenerationId,state:control.activeGeneration?.state,
    servingMode:control.servingMode,verified:!!control.activeGeneration?.verifiedAt,...lag};
}
