// D4 HTTP: summary/fallback metadata and current-admin authorization directly and
// through the real Core proxy (DB doubles). Real PostgreSQL parity is in the PG suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {generateKeyPairSync} from 'node:crypto';
import {createApp} from '../../../../services/clinic/dist/app.js';
import {CoreDirectory} from '../../../../services/clinic/dist/directory.js';
import {createCoreApp} from '../../../../backend/dist/src/phase2/coreApp.js';
import {signToken,verifyToken} from '../../../../backend/dist/src/lib/token.js';

test('summary metadata/headers survive Core proxy; ineligible falls back whole-response; auth/validation never fall back',{timeout:30000},async t=>{
  const keys=generateKeyPairSync('rsa',{modulusLength:2048});
  const names=['JWT_PRIVATE_KEY','JWT_PUBLIC_KEY','JWT_ISSUER','JWT_AUDIENCE','JWT_KEY_ID','PHASE2_RUNTIME_REQUIRED','CLINIC_ACTIVITY_MODE','CLINIC_READ_MODE','CLINIC_READ_PROJECTION'];
  const previous=Object.fromEntries(names.map(k=>[k,process.env[k]])),servers=[];
  t.after(async()=>{for(const s of servers){s.closeAllConnections();if(s.listening)await new Promise(r=>s.close(r));}for(const k of names)if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];});
  Object.assign(process.env,{JWT_PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),JWT_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'pem'}).toString(),JWT_ISSUER:'activity-test',JWT_AUDIENCE:'activity-test',JWT_KEY_ID:'activity-test',CLINIC_ACTIVITY_MODE:'summary',CLINIC_READ_MODE:'authoritative',CLINIC_READ_PROJECTION:'on'});delete process.env.PHASE2_RUNTIME_REQUIRED;
  const accounts=new Map(['admin','owner','staff','doctor'].map(role=>[role,{id:role,role,fullName:'Fixture '+role}]));
  const g='9f1c2b5e-7a4d-4c1e-9b3f-2d6a8e0c4b71';let reason,summaryQueries=0,sourceQueries=0,hold;
  const coreDb={user:{findUnique:async({where})=>accounts.get(where.id)??null,findMany:async()=>[]},pet:{findMany:async()=>[]},$transaction:fn=>fn(coreDb)};
  const clinicDb={clinicActivityControl:{findUnique:async()=>({servingMode:'summary'})},$transaction:async(fn,opts)=>{assert.equal(opts.isolationLevel,'RepeatableRead');assert.ok(opts.timeout<=2500&&opts.maxWait<=50);
    return fn({$executeRawUnsafe:async()=>0,readRebuildRun:{count:async()=>0},
      readProjectionControl:{findUnique:async()=>({activeGenerationId:g,servingMode:'authoritative',activeGeneration:{id:g,state:'ACTIVE',schemaVersion:2,verifiedAt:new Date(),projectionName:'appointments'}})},
      $queryRaw:async sql=>{if(sql.strings.join('').includes('AppointmentDailySummary'))summaryQueries++;else{sourceQueries++;if(hold)await hold;}return [{date:'2030-10-20',type:'general_checkup',status:'completed',n:4n}];}});}};
  const evidence={ineligibleReason:()=>reason,observed:()=>({checkedAt:Date.now()-500,lagMs:0})};
  let directory;const source={request:(...a)=>directory.request(...a),acceptsService:()=>false};
  const clinic=createApp(clinicDb,verifyToken,source,undefined,undefined,evidence).listen(0,'127.0.0.1');servers.push(clinic);await once(clinic,'listening');
  const clinicUrl=`http://127.0.0.1:${clinic.address().port}`,credential='activity-directory-fixture-credential-32-chars';
  const core=createCoreApp(coreDb,{clinicUrl,clinicToken:credential,directoryToken:credential}).listen(0,'127.0.0.1');servers.push(core);await once(core,'listening');
  const coreUrl=`http://127.0.0.1:${core.address().port}`;directory=new CoreDirectory(coreUrl,credential);
  const tokens=Object.fromEntries([...accounts].map(([id,u])=>[id,signToken(id,u.role)])),q='from=2030-09-21&to=2030-10-20';
  const get=(base,role='admin',query=q,headers={})=>fetch(base+'/api/dashboard/clinic/activity?'+query,{headers:{...(role?{Authorization:'Bearer '+(tokens[role]??'bad')}:{}),...headers},signal:AbortSignal.timeout(5000)});
  for(const base of [clinicUrl,coreUrl]){
    const r=await get(base),body=await r.json();assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
    assert.equal(body.meta.source,'summary');assert.equal(body.meta.generation,g);assert.equal(body.meta.degraded,false);assert.equal(body.current.total,4);
    assert.equal(r.headers.get('x-clinic-read-source'),'summary');assert.equal(r.headers.get('x-clinic-projection-generation'),g);assert.equal(r.headers.get('x-service-degraded'),null);
    // Client cannot pick a path or bypass the selector.
    const forged=await get(base,'admin',q,{'X-Clinic-Activity-Mode':'source','X-Clinic-Read-Consistency':'authoritative'});assert.equal((await forged.json()).meta.source,'summary');
    assert.equal((await get(base,'admin',q+'&mode=source')).status,422);
  }
  reason='summary_drift';
  for(const base of [clinicUrl,coreUrl]){
    const r=await get(base),body=await r.json();assert.equal(r.status,200);
    assert.deepEqual([body.meta.source,body.meta.generation,body.meta.degraded,body.meta.reason],['source',null,true,'summary_drift']);
    assert.equal(r.headers.get('x-clinic-read-source'),'source');assert.equal(r.headers.get('x-clinic-projection-generation'),null);assert.equal(r.headers.get('x-service-degraded'),'clinic-activity');
  }
  const before={summaryQueries,sourceQueries};
  for(const base of [clinicUrl,coreUrl]){
    assert.equal((await get(base,null)).status,401);assert.equal((await get(base,'invalid')).status,401);
    for(const role of ['owner','staff','doctor'])assert.equal((await get(base,role)).status,403);
    assert.equal((await get(base,'admin','from=2030-02-30&to=2030-03-01')).status,422);
  }
  reason=undefined;accounts.set('admin',{id:'admin',role:'staff',fullName:'Revoked'});
  assert.equal((await get(clinicUrl)).status,403);assert.equal((await get(coreUrl)).status,403);
  assert.deepEqual({summaryQueries,sourceQueries},before,'401/403/422 never reach summary or fallback SQL');
  accounts.set('admin',{id:'admin',role:'admin',fullName:'Restored'});
  // Fallback budget: two held source computations, third ineligible request => 503 Retry-After 1.
  reason='rows_freshness_missing';let release;hold=new Promise(r=>release=r);
  const held=[get(clinicUrl),get(clinicUrl)];await new Promise(r=>setTimeout(r,200));
  const busy=await get(coreUrl);assert.equal(busy.status,503);assert.equal(busy.headers.get('retry-after'),'1');
  release();hold=undefined;for(const r of await Promise.all(held))assert.equal((await r.json()).meta.reason,'rows_freshness_missing');
});
