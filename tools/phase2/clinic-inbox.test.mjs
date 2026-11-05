import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ClinicInbox } from '../../services/clinic/dist/infrastructure/messaging/inbox.js';
import { classifyClinicFailure } from '../../services/clinic/dist/infrastructure/messaging/messagingErrors.js';

// K4 C4: what Clinic's real inbox does with a billing event that names no appointment. Nothing can heal such an event,
// so the inbox refuses it before it opens a transaction or writes an InboxEvent row, and the broker dead-letters it at
// once (UNSUPPORTED_EVENT is a permanent failure). No Docker; needs `npm run phase2:build`. Only the P1 proof topology
// ever produced these events; tools/phase2/fixtures/p1-proof/proofInbox.ts keeps the old handling for that proof.

// A database double that records every call and never touches anything. `inboxEvent.findUnique` finds no row.
// `$transaction` does not run its callback: reaching it is the fact under test.
function fakeDb() {
  const calls = [];
  const leaf = name => (...args) => { calls.push(name); return name === 'inboxEvent.findUnique' ? Promise.resolve(null) : Promise.resolve(undefined); };
  const db = new Proxy({}, {
    get: (_, key) => {
      if (key === '$transaction') return async () => { calls.push('$transaction'); return 'transaction-opened'; };
      if (typeof key !== 'string' || key === 'then') return undefined;
      if (key.startsWith('$')) return leaf(key);
      return new Proxy({}, { get: (__, method) => (typeof method === 'string' ? leaf(`${key}.${method}`) : undefined) });
    },
  });
  return { db, calls };
}
const billingEvent = (payload, eventType = 'billing.invoice-issued.v1') => JSON.stringify({
  eventId: randomUUID(), eventType, schemaVersion: 1, producer: 'core', aggregateType: 'billing-operation', aggregateId: randomUUID(),
  aggregateVersion: 1, occurredAt: new Date().toISOString(), correlationId: randomUUID(), payload,
});

test('a billing event without appointmentId is refused before any transaction or InboxEvent write', async () => {
  for (const [eventType, payload] of [
    ['billing.invoice-issued.v1', { operationId: randomUUID(), invoiceId: randomUUID() }],
    ['billing.operation-aborted.v1', { operationId: randomUUID() }],
  ]) {
    const { db, calls } = fakeDb();
    const error = await new ClinicInbox(db).apply(billingEvent(payload, eventType)).then(() => null, e => e);
    assert.equal(error?.message, 'UNSUPPORTED_EVENT', eventType);
    assert.equal(classifyClinicFailure(error), 'permanent', `${eventType}: dead-lettered at once, no retry ladder`);
    assert.ok(!calls.includes('$transaction'), `${eventType}: no transaction opened`);
    assert.deepEqual(calls, ['inboxEvent.findUnique'], `${eventType}: only the duplicate check ran, no InboxEvent write`);
  }
});

test('control: the same event naming an appointment does open a transaction', async () => {
  const { db, calls } = fakeDb();
  const result = await new ClinicInbox(db).apply(billingEvent({ operationId: randomUUID(), invoiceId: randomUUID(), appointmentId: randomUUID() }));
  assert.equal(result, 'transaction-opened');
  assert.deepEqual(calls, ['inboxEvent.findUnique', '$transaction']);
});

test('an event already in the inbox is acknowledged as a duplicate before the appointment check', async () => {
  const calls = [];
  const db = { inboxEvent: { findUnique: async () => { calls.push('inboxEvent.findUnique'); return { eventId: 'seen' }; } }, $transaction: async () => { calls.push('$transaction'); } };
  assert.equal(await new ClinicInbox(db).apply(billingEvent({ operationId: randomUUID() }, 'billing.operation-aborted.v1')), false);
  assert.deepEqual(calls, ['inboxEvent.findUnique']);
});
