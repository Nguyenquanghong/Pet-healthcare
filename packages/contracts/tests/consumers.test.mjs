import test from 'node:test';
import assert from 'node:assert/strict';
import { consumedEvents, consumes, eventTypes } from '../dist/index.js';

// F7: consumers name every event they apply; prefixes no longer admit new types.
test('every declared event type has a consumer and every consumed type is declared', () => {
  const consumed = Object.values(consumedEvents).flat();
  assert.deepEqual(eventTypes.filter(type => !consumed.includes(type)), []);
  assert.deepEqual(consumed.filter(type => !eventTypes.includes(type)), []);
  for (const list of Object.values(consumedEvents)) assert.equal(new Set(list).size, list.length);
});

test('consumes admits only the listed types, not a family prefix', () => {
  assert.equal(consumes('clinic', 'billing.operation-aborted.v1'), true);
  assert.equal(consumes('clinic', 'billing.invoice-voided.v1'), false);
  assert.equal(consumes('clinic', 'notification.requested.v1'), false);
  assert.equal(consumes('notification', 'identity.sessions-revoked.v1'), true);
  assert.equal(consumes('clinic-read-v1', 'directory.pet-upserted.v1'), false);
});
