import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope } from '../dist/index.js';
import SwaggerParser from '@apidevtools/swagger-parser';
import { fileURLToPath } from 'node:url';
const valid = { eventId: 'e', eventType: 'billing.operation-aborted.v1', schemaVersion: 1, producer: 'core', aggregateType: 'billing-operation', aggregateId: 'o', aggregateVersion: 1, occurredAt: '2026-10-11T00:00:00Z', correlationId: 'c', payload: { operationId: 'o' } };
test('notification payload preserves owner/admin scope and legacy metadata without sensitive fields', () => {
  const owner = { ...valid, eventType: 'notification.requested.v1', payload: { notificationId: 'n', recipientOwnerId: 'o', title: 'Fixture', message: 'Fixture' } };
  const admin = { ...owner, payload: { ...owner.payload, recipientOwnerId: null, recipientRole: 'admin', status: 'read', type: 'general', createdAt: valid.occurredAt, sentAt: valid.occurredAt, actionUrl: '/admin/notifications', relatedPetId: 'pet', relatedBookingId: null } };
  for (const event of [owner, admin]) assert.deepEqual(parseEnvelope(JSON.stringify(event)), event);
  for (const patch of [{ recipientOwnerId: null }, { recipientRole: null }, { recipientRole: 'doctor' }, { status: 'pending' }, { createdAt: 'bad' }, { internalNote: 'private' }, { passwordHash: 'private' }]) assert.throws(() => parseEnvelope(JSON.stringify({ ...owner, payload: { ...owner.payload, ...patch } })));
  assert.throws(() => parseEnvelope(JSON.stringify({ ...admin, payload: { ...admin.payload, recipientOwnerId: 'owner' } })));
});
test('wire contract rejects unsupported schema, missing fields and oversized payload', () => {
  assert.deepEqual(parseEnvelope(JSON.stringify(valid)), valid);
  for (const patch of [{ schemaVersion: 2 }, { aggregateVersion: 0 }, { producer: 'browser' }, { payload: {} }, { occurredAt: 'bad' }, { payload: { operationId: 'o', data: 'x'.repeat(32768) } }]) assert.throws(() => parseEnvelope(JSON.stringify({ ...valid, ...patch })));
});
test('internal OpenAPI validates actual billing and Core directory/send contracts', async () => {
  const spec = await SwaggerParser.validate(fileURLToPath(new URL('../internal/openapi.json', import.meta.url)));
  assert.equal(Object.keys(spec.paths).length, 9);
  assert.equal(spec.components.securitySchemes.ServiceCredential.name,'X-Service-Token');
  assert.deepEqual(spec.components.schemas.Prepare.required,['appointmentId','expectedRevision']);
  assert.equal(spec.components.schemas.Prepare.properties.expectedRevision.minimum,0);
  assert.ok(spec.paths['/internal/billing-reservations/{operationId}'].put.security[0].ActorBearer);
  assert.equal(spec.paths['/internal/billing-reservations/{operationId}/release'].post.requestBody.content['application/json'].schema.additionalProperties,false);
});
test('Clinic OpenAPI covers 19 public operations, bootstrap and 5 private billing operations',async()=>{
  const spec=await SwaggerParser.validate(fileURLToPath(new URL('../../../services/clinic/openapi.json',import.meta.url)));
  // 19 public = the 17 of P3-P5 + GET /api/dashboard/clinic/activity (clinic-activity D1, admin-only)
  // + GET /api/medical-records/{id}/history (AQ-15 audit, staff-only).
  assert.equal(Object.values(spec.paths).flatMap(p=>Object.keys(p).filter(k=>['get','post','patch','put','delete'].includes(k))).length,25);
  const history=spec.paths['/api/medical-records/{id}/history'].get;
  assert.ok(history.security[0].BearerAuth);
  for(const status of ['200','401','403','404'])assert.ok(history.responses[status],status);
  assert.deepEqual(spec.components.schemas.MedicalRecordRevision.properties.action.enum,['create','update','delete']);
  const activity=spec.paths['/api/dashboard/clinic/activity'].get;
  assert.ok(activity.security[0].BearerAuth);
  for(const status of ['401','403','422','503'])assert.ok(activity.responses[status],status);
  assert.deepEqual(activity.parameters.map(p=>p.name).sort(),['category','from','groupBy','to']);
  for(const path of ['/api/appointments','/api/medical-records'])assert.ok(spec.paths[path].post.parameters.some(p=>p.name==='Idempotency-Key'&&p.required));
  assert.ok(spec.paths['/internal/clinic/bootstrap'].get.security[0].ServiceCredential);
  assert.ok(spec.paths['/api/dashboard/clinic'].get.responses['503']);
});
test('P5 public dashboard regions and partial bootstrap use explicit unavailable semantics',async()=>{
  const spec=await SwaggerParser.validate(fileURLToPath(new URL('../../../backend/openapi.json',import.meta.url)));
  for(const region of ['core','clinic'])assert.ok(spec.paths['/dashboard/'+region].get.responses['503']);
  const b=spec.components.schemas.Bootstrap.properties;
  assert.equal(b.summary.properties.unread.nullable,true);
  assert.equal(b.regions.properties.notifications.properties.asOf.nullable,true);
  assert.equal(spec.components.schemas.DirectoryStatus.properties.searchReady.type,'boolean');
});

test('runtime billing wire identifies actual appointment, rejects extra sensitive fields and keeps proof compatibility',()=>{
  const actual={...valid,payload:{operationId:'o',appointmentId:'a'}};
  assert.deepEqual(parseEnvelope(JSON.stringify(actual)),actual);
  assert.deepEqual(parseEnvelope(JSON.stringify({...actual,eventType:'billing.invoice-issued.v1',payload:{...actual.payload,invoiceId:'i'}})).payload,{operationId:'o',appointmentId:'a',invoiceId:'i'});
  for(const payload of [{...actual.payload,appointmentId:''},{...actual.payload,operationId:'x'.repeat(129)},{...actual.payload,internalNote:'private'}])assert.throws(()=>parseEnvelope(JSON.stringify({...actual,payload})));
});
test('Notification P2 OpenAPI validates six implemented paths including idempotent manual send', async () => {
  const spec = await SwaggerParser.validate(fileURLToPath(new URL('../../../services/notification/openapi.json', import.meta.url)));
  assert.equal(Object.keys(spec.paths).length, 6);
  assert.equal(spec.paths['/api/notifications/unread-count'].get.responses['200'].content['application/json'].schema.properties.unread.type, 'integer');
});
test('directory wire fields exclude credentials and require monotonic source version and Core producer', () => {
  for (const kind of ['owner', 'pet', 'staff']) {
    const event = { ...valid, eventType: `directory.${kind}-upserted.v1`, aggregateId: 'person', aggregateVersion: 2, payload: { id: 'person', sourceVersion: 2, displayName: 'Fixture', ...(kind === 'pet' ? { ownerId: 'owner' } : {}) } };
    assert.deepEqual(parseEnvelope(JSON.stringify(event)), event);
    for (const patch of [{ producer: 'clinic' }, { payload: { ...event.payload, sourceVersion: 1 } }, { payload: { ...event.payload, passwordHash: 'secret' } }, { payload: { ...event.payload, internalNote: 'medical note' } }, { payload: { ...event.payload, deletedAt: 'invalid' } }]) assert.throws(() => parseEnvelope(JSON.stringify({ ...event, ...patch })));
  }
});
