import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTrialContext,trialUrl,guardDatabase,TrialScopeError} from './trialGuards.mjs';

const run='01234567-89ab-4def-8123-0123456789ab',hex=run.replaceAll('-','');
function context(){
  const c={kind:'clinic-activity-d1-native-v1',run,directory:'/tmp/clinic-activity-d1-'+run,
    pgData:'/tmp/clinic-activity-d1-'+run+'/pgdata',pgPort:25432,schema:'activity_'+hex,marker:'clinic-activity:'+run,
    fixtureRows:10000,seed:20261020,businessDate:'2030-10-20',benchmark:false,authorizedTrialSetup:true,sourceArchiveSha256:'a'.repeat(64),urls:{}};
  for(const component of ['core','clinic']){
    c.urls[component]={};
    for(const access of ['operator','api',...(component==='clinic'?['reader']:[])]){
      const role='activity_'+hex+'_'+(access==='operator'?'operator':access==='reader'?'reader':component);
      c.urls[component][access]=`postgresql://${role}:${'b'.repeat(48)}@127.0.0.1:25432/activity_${hex}_${component}?schema=${c.schema}&connection_limit=${access==='reader'?1:2}&pool_timeout=1`;
    }
  }
  return c;
}
test('disposable trial rejects unapproved scope, legacy targets, path/run/fixture drift and benchmarks before SQL',()=>{
  assert.equal(validateTrialContext(context()),hex);
  for(const delta of [{run:'../main'},{directory:'/tmp/pet-phase2-kaggle-'+run},{pgData:'/var/lib/postgresql/data'},
    {marker:'p8_control'},{schema:'public'},{fixtureRows:100000},{seed:1},{businessDate:'2028-02-01'},
    {benchmark:true},{authorizedTrialSetup:false},{pgPort:543},{sourceArchiveSha256:'wrong'}]){
    assert.throws(()=>validateTrialContext({...context(),...delta}),TrialScopeError);
  }
  const c=context();
  for(const replacement of ['postgresql://postgres:secret@127.0.0.1:25432/postgres?schema=public',
    c.urls.clinic.api.replace('127.0.0.1','example.com'),c.urls.clinic.api.replace(':25432/',':5432/'),
    c.urls.clinic.api.replace('schema=activity_'+hex,'schema=public'),c.urls.clinic.api+'&schema=public']){
    c.urls.clinic.api=replacement;assert.throws(()=>trialUrl(c,'clinic','api'),TrialScopeError);
  }
});
test('live identity gate requires exact database, role, schema, port, major, both markers and non-superuser flags',async()=>{
  const c=context();let calls=0;
  const records=[{db:'activity_'+hex+'_clinic',role:'activity_'+hex+'_operator',schema:c.schema,port:'25432',version:'160015'},
    {marker:c.marker},{marker:c.marker},{rolsuper:false,rolcreatedb:false,rolcreaterole:false}];
  const db={$queryRaw:async()=>[records[calls++]]};
  assert.equal((await guardDatabase(db,c,'clinic')).markerVerified,true);assert.equal(calls,4);
  for(const [index,delta] of [[0,{db:'p8_clinic'}],[0,{role:'postgres'}],[0,{schema:'public'}],[0,{port:'5432'}],
    [0,{version:'170001'}],[1,{marker:'other-run'}],[2,{marker:null}],[3,{rolsuper:true}],[3,{rolcreatedb:true}],[3,{rolcreaterole:true}]]){
    let n=0;const changed=structuredClone(records);Object.assign(changed[index],delta);
    await assert.rejects(guardDatabase({$queryRaw:async()=>[changed[n++]]},c,'clinic'),TrialScopeError);
    assert.equal(n,index+1);
  }
});
