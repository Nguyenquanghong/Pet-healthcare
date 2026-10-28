import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {generateKeyPairSync} from 'node:crypto';
import {createApp} from '../../../../services/clinic/dist/app.js';
import {CoreDirectory} from '../../../../services/clinic/dist/directory.js';
import {createCoreApp} from '../../../../backend/dist/src/phase2/coreApp.js';
import {signToken,verifyToken} from '../../../../backend/dist/src/lib/token.js';

test('activity contract/current-admin authorization and cache hits work directly and through real Core proxy',{timeout:30000},async(t)=>{
  const keys=generateKeyPairSync('rsa',{modulusLength:2048});
  const names=['JWT_PRIVATE_KEY','JWT_PUBLIC_KEY','JWT_ISSUER','JWT_AUDIENCE','JWT_KEY_ID','PHASE2_RUNTIME_REQUIRED','CLINIC_ACTIVITY_MODE'];
  const previous=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  const servers=[];
  t.after(async()=>{for(const server of servers){server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));}for(const k of names)if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];});
  Object.assign(process.env,{JWT_PRIVATE_KEY:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),JWT_PUBLIC_KEY:keys.publicKey.export({type:'spki',format:'pem'}).toString(),JWT_ISSUER:'activity-test',JWT_AUDIENCE:'activity-test',JWT_KEY_ID:'activity-test',CLINIC_ACTIVITY_MODE:'cached'});delete process.env.PHASE2_RUNTIME_REQUIRED;
  const accounts=new Map(['admin','owner','staff','doctor'].map(role=>[role,{id:role,role,fullName:'Fixture '+role}]));let denyCore=false,failSql=false,queries=0;
  const coreDb={user:{findUnique:async({where})=>{if(denyCore)throw new Error('PRIVATE_DB');return accounts.get(where.id)??null;},findMany:async()=>[]},pet:{findMany:async()=>[]},$transaction:fn=>fn(coreDb)};
  const clinicDb={$transaction:async(fn,opts)=>{assert.equal(opts.isolationLevel,'RepeatableRead');return fn({$executeRawUnsafe:async()=>0,$queryRaw:async()=>{queries++;if(failSql)throw new Error('PRIVATE_SQL');return [{date:'2030-10-20',type:'general_checkup',status:'completed',n:4n}];}});}};
  let directory;
  const source={request:(...args)=>directory.request(...args),acceptsService:()=>false};
  const clinic=createApp(clinicDb,verifyToken,source).listen(0,'127.0.0.1');servers.push(clinic);await once(clinic,'listening');
  const clinicUrl=`http://127.0.0.1:${clinic.address().port}`;
  const credential='activity-directory-fixture-credential-32-chars';
  const core=createCoreApp(coreDb,{clinicUrl,clinicToken:credential,directoryToken:credential}).listen(0,'127.0.0.1');servers.push(core);await once(core,'listening');
  const coreUrl=`http://127.0.0.1:${core.address().port}`;directory=new CoreDirectory(coreUrl,credential);
  const tokens=Object.fromEntries([...accounts].map(([id,user])=>[id,signToken(id,user.role)]));
  const q='from=2030-09-21&to=2030-10-20';
  const get=(base,role='admin',query=q,headers={},path='/api/dashboard/clinic/activity')=>fetch(base+path+'?'+query,{headers:{...(role?{Authorization:'Bearer '+(tokens[role]??'bad')}:{}),...headers},signal:AbortSignal.timeout(5000)});
  try{
    const direct=await get(clinicUrl),body=await direct.json();assert.equal(direct.status,200);assert.equal(direct.headers.get('cache-control'),'no-store');assert.equal(body.current.total,4);assert.equal(body.current.buckets.length,30);assert.equal(body.meta.source,'source');
    const proxied=await get(coreUrl),cached=await proxied.json();assert.equal(proxied.status,200);assert.equal(cached.meta.source,'cached');assert.equal(proxied.headers.get('cache-control'),'no-store');
    assert.deepEqual(cached.current,body.current);assert.equal(queries,1);
    const forged=await get(coreUrl,'admin',q,{'X-Clinic-Read-Consistency':'projection','X-Clinic-Activity-Mode':'source'});
    assert.equal(forged.status,200);assert.equal((await forged.json()).meta.source,'cached');assert.equal(queries,1);
    for(const base of [clinicUrl,coreUrl]){
      assert.equal((await get(base,null)).status,401);assert.equal((await get(base,'invalid')).status,401);
      for(const role of ['owner','staff','doctor'])assert.equal((await get(base,role)).status,403);
      for(const path of ['/api/dashboard/clinic/activity/','/api/dashboard/CLINIC/activity']){
        const before=queries;
        const deniedStatus=base===coreUrl&&path.includes('CLINIC')?404:403; // Core allowlist is case-sensitive.
        for(const role of ['owner','staff','doctor'])assert.equal((await get(base,role,q,{},path)).status,deniedStatus,path+' '+role);
        assert.equal(queries,before,'alternate route spellings never reach activity SQL');
      }
      for(const query of [q+'&ownerId=other',q+'&petId=other',q+'&doctorId=other',q+'&from=2030-09-22',q+'&groupBy=sql',q+'&mode=source','from=2030-02-30&to=2030-03-01'])assert.equal((await get(base,'admin',query)).status,422);
    }
    accounts.set('admin',{id:'admin',role:'staff',fullName:'Revoked'});
    assert.equal((await get(clinicUrl)).status,403);assert.equal((await get(coreUrl)).status,403);assert.equal(queries,1);
    accounts.set('admin',{id:'admin',role:'admin',fullName:'Restored'});denyCore=true;
    assert.equal((await get(clinicUrl)).status,503);assert.equal((await get(coreUrl)).status,503);assert.equal(queries,1);denyCore=false;
    failSql=true;const unavailable=await get(coreUrl,'admin','from=2030-10-20&to=2030-10-20');
    assert.equal(unavailable.status,503);assert.equal(unavailable.headers.get('retry-after'),'1');assert.ok(!JSON.stringify(await unavailable.json()).includes('PRIVATE_SQL'));
  }finally{
    for(const server of [core,clinic]){server.closeAllConnections();await new Promise(r=>server.close(r));}
    for(const k of names)if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];
  }
});
