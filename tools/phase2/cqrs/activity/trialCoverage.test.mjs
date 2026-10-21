import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyWarmCacheRoleRevocation,explainActivityStatement} from './trialCoverage.mjs';
import {parseActivityFilter} from '../../../../services/clinic/dist/application/queries/clinicActivity.js';
import {activitySourceStatement} from '../../../../services/clinic/dist/infrastructure/queries/clinicActivity.js';
import {startTrialFrontend} from './trialBrowser.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

function probe({expire=false,bypass=false,changeStamp=false}={}){
  let time=0,role='admin',reads=0;const roles=[];
  return {roles,args:{now:()=>time,setRole:async value=>{role=value;roles.push(value);if(value==='staff'&&expire)time=5000;},
    read:async()=>{reads++;time+=10;
      if(role==='staff')return {status:bypass?200:403};
      return {status:200,body:{meta:{source:reads===1?'source':'cached',cacheComputedAt:changeStamp&&reads>2?'changed':'snapshot',freshness:{checkedAt:'snapshot',observedLagMs:10}}}};
    }}};
}
test('warm cache denial is tied to an unexpired entry that survives role restoration',async()=>{
  const p=probe(),proof=await verifyWarmCacheRoleRevocation(p.args);assert.equal(proof.sameCacheEntryAfterRoleRestore,true);assert.deepEqual(p.roles,['staff','admin']);
});
test('expiry cannot be counted as warm-cache auth proof and the role is restored',async()=>{
  const p=probe({expire:true});await assert.rejects(()=>verifyWarmCacheRoleRevocation(p.args),/WARM_CACHE_PROBE_EXPIRED/);assert.deepEqual(p.roles,['staff','admin']);
});
test('revoked-role data leak fails the probe and restores role',async()=>{
  const p=probe({bypass:true});await assert.rejects(()=>verifyWarmCacheRoleRevocation(p.args));assert.deepEqual(p.roles,['staff','admin']);
});
test('replacement cache snapshot is rejected as proof of the original warm entry',async()=>{
  const p=probe({changeStamp:true});await assert.rejects(()=>verifyWarmCacheRoleRevocation(p.args),/SAME_LIVE_CACHE_AFTER_RESTORE/);
});
test('plain EXPLAIN preserves all bound production query parameters and never enables ANALYZE',()=>{
  for(const category of ['all','clinic','spa']){
    const f=parseActivityFilter({from:'2030-09-21',to:'2030-10-20',category}),source=activitySourceStatement(f),explain=explainActivityStatement(f);
    assert.equal(explain.text,'EXPLAIN (FORMAT JSON) '+source.text);assert.deepEqual(explain.values,source.values);
    assert.doesNotMatch(explain.text,/ANALYZE|BUFFERS|TIMING|2030-10-20/i);
  }
});
test('trial static frontend serves real assets and SPA routes, blocks API shadowing/traversal/commands',async()=>{
  const dir=resolve('test-results/phase2/cqrs/activity/static-frontend-tests',randomUUID());mkdirSync(dir,{recursive:true});
  writeFileSync(resolve(dir,'index.html'),'<html>trial SPA</html>');writeFileSync(resolve(dir,'app.js'),'console.log("trial")');
  const server=await startTrialFrontend(dir),base='http://127.0.0.1:'+server.address().port;
  try{
    const spa=await fetch(base+'/admin/appointments?date=2030-10-20');assert.equal(spa.status,200);assert.match(await spa.text(),/trial SPA/);
    const asset=await fetch(base+'/app.js');assert.equal(asset.headers.get('content-type'),'text/javascript');assert.match(await asset.text(),/console.log/);
    assert.equal((await fetch(base+'/api/dashboard/clinic/activity')).status,503);
    assert.equal((await fetch(base+'/..%2fprivate.txt')).status,404);
    assert.equal((await fetch(base+'/admin',{method:'POST'})).status,405);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
