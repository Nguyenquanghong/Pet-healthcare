import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseEnvelope} from '../../../packages/contracts/dist/index.js';
import {topology} from '../../../packages/messaging/dist/index.js';
import Ajv2020 from 'ajv/dist/2020.js';
const event={eventId:'e',eventType:'clinic.appointment-read-changed.v1',schemaVersion:1,producer:'clinic',aggregateType:'appointment',aggregateId:'a',aggregateVersion:3,
  occurredAt:'2026-10-15T00:00:00Z',correlationId:'c',payload:{appointmentId:'a',sourceVersion:3,deleted:false}};
test('read-change contract is minimal, bound to aggregate/version and rejects sensitive or unknown fields',()=>{
  assert.deepEqual(parseEnvelope(JSON.stringify(event)),event);
  for(const patch of [{producer:'core'},{aggregateType:'notification'},{aggregateVersion:2147483648},{unknown:1},
    ...[{appointmentId:'other'},{sourceVersion:2},{deleted:1},{internalNote:'PRIVATE'},{ownerId:'private'},{jwt:'private'}].map(p=>({payload:{...event.payload,...p}}))]){
    assert.throws(()=>parseEnvelope(JSON.stringify({...event,...patch})));
  }
  assert.deepEqual(parseEnvelope(JSON.stringify({...event,payload:{...event.payload,deleted:true}})).payload.deleted,true);
});
test('JSON Schema declares bounded version and the same payload allowlist; read queue is independent',()=>{
  const schema=JSON.parse(readFileSync('packages/contracts/events/v1/envelope.schema.json'));
  assert.ok(schema.properties.eventType.enum.includes(event.eventType));
  const branch=schema.allOf.find(b=>b.if.properties.eventType.const===event.eventType).then;
  assert.equal(branch.properties.producer.const,'clinic');assert.equal(branch.properties.aggregateType.const,'appointment');
  assert.equal(branch.properties.aggregateVersion.maximum,2147483647);
  assert.equal(branch.properties.payload.additionalProperties,false);
  assert.deepEqual(branch.properties.payload.required,['appointmentId','sourceVersion','deleted']);
  const t=topology('p2.q2.fixture');assert.equal(t.clinicRead,'p2.q2.fixture.clinic-read-v1');
  assert.equal(new Set([t.clinic,t.clinicRead,t.notification]).size,3);
});
test('independent Draft2020 validator enforces structural wire schema without leaking fields',()=>{
  const ajv=new Ajv2020({strict:false,formats:{'date-time':value=>Number.isFinite(Date.parse(value))}});
  const validate=ajv.compile(JSON.parse(readFileSync('packages/contracts/events/v1/envelope.schema.json')));
  assert.equal(validate(event),true,JSON.stringify(validate.errors));
  for(const patch of [{producer:'core'},{aggregateType:'notification'},{aggregateVersion:2147483648},{unknown:1},
    {payload:{appointmentId:'a',sourceVersion:3}},{payload:{...event.payload,deleted:1}},{payload:{...event.payload,internalNote:'PRIVATE'}}]){
    assert.equal(validate({...event,...patch}),false,JSON.stringify(patch));
  }
});
