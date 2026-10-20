import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {configuration,apiEnvironment,validateTarget,prepareReadModel,guard} from '../../../benchmarks/phase2/kaggle/cqrs_runtime.mjs';

test('Q6 O works without CQRS database/client imports; A/B keep projector enabled',async()=>{
  const old=await prepareReadModel('O','not-a-database-url',{});
  assert.equal(old.generation,null);assert.equal(old.projectorEnabled,false);
  for(const mode of ['A','B']){assert.equal(configuration(mode).projectorEnabled,true);assert.equal(configuration(mode).shadowEnabled,false);}
  assert.equal(apiEnvironment('A','x'.repeat(32)).CLINIC_READ_MODE,'authoritative');
  assert.equal(apiEnvironment('B','x'.repeat(32)).CLINIC_READ_MODE,'projection');
  assert.throws(()=>configuration('shadow'));assert.throws(()=>apiEnvironment('B','short'));
});
test('Q6 DB targets reject wrong host database role schema and UUID before SQL',()=>{
  const run=randomUUID(),context={kind:'cqrs-q6-local-v1',run};
  const good=new URL('postgresql://p2_clinic:synthetic@127.0.0.1:55432/p2_clinic_test?connection_limit=1&schema=cqrs_q6_'+run.replaceAll('-',''));
  assert.equal(validateTarget(good,context).database,'p2_clinic_test');
  for(const [key,value] of [['hostname','example.com'],['pathname','/main'],['username','postgres'],['port','5432']]){
    const bad=new URL(good);bad[key]=value;assert.throws(()=>validateTarget(bad,context));
  }
  for(const [key,value] of [['schema','public'],['connection_limit','4']]){const bad=new URL(good);bad.searchParams.set(key,value);assert.throws(()=>validateTarget(bad,context));}
  assert.throws(()=>validateTarget(good,{...context,run:randomUUID()}));
});
test('Q6 marker mismatch stops before any fixture/rebuild write',async()=>{
  const run=randomUUID(),schema='cqrs_q6_'+run.replaceAll('-',''),context={kind:'cqrs-q6-local-v1',run};
  const url=new URL('postgresql://p2_clinic:synthetic@127.0.0.1:55432/p2_clinic_test?connection_limit=1&schema='+schema);
  let calls=0;
  const db={$queryRaw:async()=>++calls===1?[{database:'p2_clinic_test',role:'p2_clinic',schema}]:[{marker:'wrong'}]};
  await assert.rejects(guard(db,url,context));assert.equal(calls,2);
});
