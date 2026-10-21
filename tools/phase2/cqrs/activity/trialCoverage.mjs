import assert from 'node:assert/strict';
import {Prisma} from '../../../../services/clinic/src/generated/client/index.js';
import {activitySourceStatement} from '../../../../services/clinic/dist/infrastructure/queries/clinicActivity.js';

// Use the production bound statement. EXPLAIN never executes the SELECT here.
export function explainActivityStatement(filter){
  const source=activitySourceStatement(filter);
  // Source and harness may load separate generated Prisma runtimes. Preserve
  // strings/values explicitly; nested Sql instanceof checks can bind Sql as $1.
  return Prisma.sql(['EXPLAIN (FORMAT JSON) '+source.strings[0],...source.strings.slice(1)],...source.values);
}

// The monotonic window starts BEFORE the source snapshot, so staying inside it
// conservatively proves the entry cannot have reached its absolute TTL yet.
export async function verifyWarmCacheRoleRevocation({read,setRole,now=()=>performance.now()}){
  const start=now(),withinTtl=()=>assert.ok(now()-start>=0&&now()-start<5000,'WARM_CACHE_PROBE_EXPIRED');
  const cold=await read('direct');assert.equal(cold.status,200);assert.equal(cold.body.meta.source,'source');
  const warm=await read('gateway');assert.equal(warm.status,200);assert.equal(warm.body.meta.source,'cached');
  const stamp=warm.body.meta.cacheComputedAt;
  assert.equal(stamp,cold.body.meta.freshness.checkedAt);assert.ok(stamp);
  assert.ok(warm.body.meta.freshness.observedLagMs>=0&&warm.body.meta.freshness.observedLagMs<5000);
  withinTtl();
  try{
    await setRole('staff');
    for(const entrypoint of ['direct','gateway']){
      withinTtl();assert.equal((await read(entrypoint)).status,403);withinTtl();
    }
  }finally{await setRole('admin');}
  withinTtl();
  const restored=await read('gateway');withinTtl();
  assert.equal(restored.status,200);assert.equal(restored.body.meta.source,'cached');
  assert.equal(restored.body.meta.cacheComputedAt,stamp,'SAME_LIVE_CACHE_AFTER_RESTORE');
  return {status:'PASS',ttlMs:5000,warmCacheVerified:true,deniedDirect:403,deniedGateway:403,
    monotonicTtlWindowVerified:true,sameCacheEntryAfterRoleRestore:true};
}
