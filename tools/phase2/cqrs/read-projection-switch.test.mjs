import test from 'node:test';
import assert from 'node:assert/strict';
import {readProjectionEnabled,assertReadProjectionConfig} from '../../../services/clinic/dist/readProjection.js';
import {trackAppointmentChange} from '../../../services/clinic/dist/readRevision.js';
import {committedVersions} from '../../../services/clinic/dist/readToken.js';
import {createApp} from '../../../services/clinic/dist/app.js';

// Fake transaction that fails on any access: the off switch must not touch the registry or outbox.
const forbidden=new Proxy({},{get:(_t,name)=>{throw new Error('must not access '+String(name));}});
const withEnv=async(values,run)=>{
  const keys=['CLINIC_READ_TOKEN_SECRET','CLINIC_READ_PROJECTION','CLINIC_READ_MODE','CLINIC_ACTIVITY_MODE','CLINIC_ACTIVITY_SUMMARY_EVIDENCE'],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  for(const k of keys)delete process.env[k];Object.assign(process.env,values);
  try{return await run();}finally{for(const k of keys)saved[k]===undefined?delete process.env[k]:process.env[k]=saved[k];}
};

test('projection maintenance defaults to off and rejects unknown values',()=>{
  assert.equal(readProjectionEnabled({}),false);
  assert.equal(readProjectionEnabled({CLINIC_READ_PROJECTION:''}),false);
  assert.equal(readProjectionEnabled({CLINIC_READ_PROJECTION:'off'}),false);
  assert.equal(readProjectionEnabled({CLINIC_READ_PROJECTION:'on'}),true);
  for(const value of ['ON','true','1',' on'])assert.throws(()=>readProjectionEnabled({CLINIC_READ_PROJECTION:value}),/INVALID_CLINIC_READ_PROJECTION/);
});

test('modes that need the projection fail fast while it is off, sources and cache do not',()=>{
  const off=extra=>assertReadProjectionConfig({...extra});
  off({});off({CLINIC_READ_MODE:'authoritative'});off({CLINIC_ACTIVITY_MODE:'source'});off({CLINIC_ACTIVITY_MODE:'cached'});
  for(const extra of [{CLINIC_READ_MODE:'projection'},{CLINIC_READ_MODE:'shadow'},{CLINIC_ACTIVITY_MODE:'summary'},{CLINIC_ACTIVITY_MODE:'control'},{CLINIC_ACTIVITY_SUMMARY_EVIDENCE:'1'}])
    assert.throws(()=>off(extra),/CLINIC_READ_PROJECTION_REQUIRED/,JSON.stringify(extra));
  for(const extra of [{CLINIC_READ_MODE:'projection'},{CLINIC_ACTIVITY_MODE:'control',CLINIC_ACTIVITY_SUMMARY_EVIDENCE:'1'}])
    assertReadProjectionConfig({...extra,CLINIC_READ_PROJECTION:'on'});
});

test('createApp refuses projection serving while the projection is off',async()=>withEnv({CLINIC_READ_MODE:'projection',CLINIC_READ_TOKEN_SECRET:'read-token-fixture-'.repeat(3)},()=>{
  assert.throws(()=>createApp({}),/CLINIC_READ_PROJECTION_REQUIRED/);
}));

test('write path records no revision, outbox event or read token version while off',async()=>withEnv({},async()=>{
  assert.equal(await trackAppointmentChange(forbidden,'appointment-1',{created:true}),undefined);
  assert.equal(await trackAppointmentChange(forbidden,'appointment-1',{deleted:true}),undefined);
  assert.deepEqual(await committedVersions(forbidden,'appointment-1'),{});
}));

test('write path records the revision and the read-changed event when on',async()=>withEnv({CLINIC_READ_PROJECTION:'on'},async()=>{
  const calls=[],tx={clinicReadRevision:{create:async x=>{calls.push(['revision',x.data]);}},outboxEvent:{create:async x=>{calls.push(['outbox',x.data.envelope.eventType]);}}};
  const result=await trackAppointmentChange(tx,'appointment-1',{created:true});
  assert.equal(result.version,1);
  assert.deepEqual(calls.map(c=>c[0]),['revision','outbox']);
  assert.equal(calls[1][1],'clinic.appointment-read-changed.v1');
}));
