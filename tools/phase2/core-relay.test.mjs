import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import amqp from 'amqplib';
import { PrismaClient } from '@prisma/client';
import { OutboxRelay } from '../../backend/dist/src/phase2/relay.js';
import { RuntimeOutboxStore } from '../../backend/dist/src/infrastructure/persistence/runtimeOutboxStore.js';
import { topology, declareTopology } from '@nipopeto/messaging';
import { topologyQueues } from './test-project.mjs';

// Core relay gets the Clinic relay fix (list study v1 K3-F1) through the shared
// ConfirmPublisher. Rows share this run's aggregateId and every relay is scoped
// to it, so other suites' unpublished rows in core_runtime_test are never claimed.
assert.equal(process.env.PHASE2_TEST_CONFIRM, 'pet-phase2-p1-test', 'Use guarded phase2:test:core-relay');
const url = 'postgresql://p2_core:p2_core_fixture_only@127.0.0.1:55432/p2_core_test?schema=core_runtime_test';
const broker = 'amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679';
const db = new PrismaClient({ datasourceUrl: url }), store = new RuntimeOutboxStore(db), run = randomUUID(), routes = topology(`p2.core-relay.${run}`);
let connection, channel, foreignPending, clock = Date.now() - 3600000;

const notification = (scope, i) => ({ eventId: randomUUID(), eventType: 'notification.requested.v1', schemaVersion: 1, producer: 'core', aggregateType: 'notification', aggregateId: scope, aggregateVersion: 1, occurredAt: new Date().toISOString(), correlationId: run, payload: { notificationId: randomUUID(), recipientOwnerId: randomUUID(), title: 'Core relay fixture ' + i, message: 'Core relay fixture' } });
async function seed(envelopes) {
  const rows = envelopes.map(envelope => ({ id: envelope.eventId, envelope, createdAt: new Date(clock += 1) }));
  await db.outboxEvent.createMany({ data: rows });
  return rows.map(r => r.id);
}
async function drain(relay, label) { let calls = 0; while (await relay.once(label, routes)) calls++; return calls; }
async function take(queue) { const ids = []; for (;;) { const m = await channel.get(queue, { noAck: true }); if (!m) return ids; ids.push(m.properties.messageId); } }
async function settle(queue, expected) { const end = Date.now() + 5000; while (Date.now() < end) { if ((await channel.checkQueue(queue)).messageCount >= expected) return; await new Promise(r => setTimeout(r, 25)); } }
const rowsOf = ids => db.outboxEvent.findMany({ where: { id: { in: ids } } });

test.before(async () => {
  const [identity] = await db.$queryRaw`SELECT current_database() AS db, current_user AS role`;
  assert.equal(identity.db, 'p2_core_test'); assert.equal(identity.role, 'p2_core');
  const [marker] = await db.$queryRaw`SELECT marker FROM public.p2_test_marker`;
  assert.equal(marker.marker, 'pet-phase2-p1-test:core:v1');
  foreignPending = await db.outboxEvent.count({ where: { publishedAt: null } });
  await declareTopology(broker, routes);
  connection = await amqp.connect(broker); connection.on('error', () => {});
  channel = await connection.createChannel(); channel.on('error', () => {});
});
test.after(async () => {
  try {
    for (const name of topologyQueues(routes, [routes.notification, routes.identity, routes.clinic, routes.clinicRead])) await channel.deleteQueue(name).catch(() => {});
    await channel.deleteExchange(routes.exchange).catch(() => {});
  } finally { await channel?.close().catch(() => {}); await connection?.close().catch(() => {}); await db.$disconnect(); }
});

test('batched persistent Core relay publishes each event once, in claim order, over one reused connection', async () => {
  const scope = randomUUID(), envelopes = Array.from({ length: 120 }, (_, i) => notification(scope, i)), ids = await seed(envelopes);
  const relay = new OutboxRelay(store, broker, scope, undefined, { batchSize: 50, persistent: true });
  try {
    assert.equal(await relay.once('core-batch', routes), true);
    const first = relay.connection; assert.ok(first);
    assert.equal((await rowsOf(ids)).filter(r => r.publishedAt).length, 50);
    assert.equal(await drain(relay, 'core-batch'), 2);
    assert.equal(relay.connection, first, 'same connection reused across batches');
  } finally { await relay.close(); }
  assert.ok((await rowsOf(ids)).every(r => r.publishedAt && r.leaseOwner === null && r.attempts === 1 && r.lastErrorCode === null));
  await settle(routes.notification, 120);
  assert.deepEqual(await take(routes.notification), envelopes.map(e => e.eventId));
});

test('unroutable or invalid rows are retried alone with backoff; neighbours are published', async () => {
  const scope = randomUUID(), good = [notification(scope, 0), notification(scope, 1)], poison = { ...notification(scope, 9), schemaVersion: 2 };
  const ids = await seed([good[0], poison, good[1]]);
  const relay = new OutboxRelay(store, broker, scope, undefined, { batchSize: 10, persistent: true });
  try { await assert.rejects(relay.once('core-poison', routes), /INVALID_ENVELOPE/); } finally { await relay.close(); }
  assert.equal(relay.connection, undefined);
  const rows = new Map((await rowsOf(ids)).map(r => [r.id, r]));
  assert.ok(good.every(e => rows.get(e.eventId).publishedAt));
  const bad = rows.get(poison.eventId); assert.equal(bad.publishedAt, null); assert.equal(bad.lastErrorCode, 'DELIVERY_UNCONFIRMED'); assert.ok(bad.nextAttemptAt > new Date());
  await settle(routes.notification, 2); assert.equal((await take(routes.notification)).length, 2);
  await db.outboxEvent.update({ where: { id: poison.eventId }, data: { publishedAt: new Date(), lastErrorCode: 'TEST_RETIRED_INVALID_FIXTURE' } });
  const unroutable = randomUUID(), uid = await seed([notification(unroutable, 0)]);
  await channel.unbindQueue(routes.notification, routes.exchange, 'notification.requested.v1');
  const second = new OutboxRelay(store, broker, unroutable, undefined, { batchSize: 10, persistent: true });
  try { await assert.rejects(second.once('core-unroutable', routes), /UNROUTABLE/); } finally { await second.close(); }
  await channel.bindQueue(routes.notification, routes.exchange, 'notification.requested.v1');
  assert.equal((await rowsOf(uid))[0].publishedAt, null);
  await db.outboxEvent.updateMany({ where: { id: { in: uid } }, data: { nextAttemptAt: new Date() } });
  const third = new OutboxRelay(store, broker, unroutable, undefined, { batchSize: 10, persistent: true });
  try { assert.equal(await drain(third, 'core-unroutable'), 1); } finally { await third.close(); }
  await settle(routes.notification, 1); assert.equal((await take(routes.notification)).length, 1);
});

test('broker unreachable releases the whole batch; default options keep the original relay; batches need claimBatch', async () => {
  const scope = randomUUID(), ids = await seed([notification(scope, 0), notification(scope, 1)]);
  const down = new OutboxRelay(store, 'amqp://p2_test:p2_broker_fixture_only@127.0.0.1:1', scope, undefined, { batchSize: 10, persistent: true });
  await assert.rejects(down.once('core-down', routes));
  assert.ok((await rowsOf(ids)).every(r => r.publishedAt === null && r.leaseOwner === null && r.lastErrorCode === 'DELIVERY_UNCONFIRMED'));
  await db.outboxEvent.updateMany({ where: { id: { in: ids } }, data: { nextAttemptAt: new Date() } });
  const original = new OutboxRelay(store, broker, scope);
  assert.equal(await original.once('core-default', routes), true);
  assert.equal(original.connection, undefined, 'default closes after each call');
  assert.equal((await rowsOf(ids)).filter(r => r.publishedAt).length, 1, 'default claims one event');
  assert.equal(await drain(original, 'core-default'), 1);
  await settle(routes.notification, 2); assert.equal((await take(routes.notification)).length, 2);
  const noBatch = { claim: async () => null, markPublished: async () => {}, retry: async () => {} };
  assert.throws(() => new OutboxRelay(noBatch, broker, scope, undefined, { batchSize: 5 }), /INVALID_RELAY_BATCH/);
});

test('two batched Core relays racing publish every event exactly once', async () => {
  const scope = randomUUID(), ids = await seed(Array.from({ length: 150 }, (_, i) => notification(scope, i)));
  const relays = [1, 2].map(() => new OutboxRelay(store, broker, scope, undefined, { batchSize: 20, persistent: true }));
  try { await Promise.all(relays.map((r, i) => drain(r, 'core-race-' + i))); } finally { await Promise.all(relays.map(r => r.close())); }
  assert.ok((await rowsOf(ids)).every(r => r.publishedAt && r.attempts === 1));
  await settle(routes.notification, 150);
  const seen = await take(routes.notification); assert.equal(seen.length, 150); assert.equal(new Set(seen).size, 150);
  assert.equal(await db.outboxEvent.count({ where: { publishedAt: null } }), foreignPending, 'rows outside this run stay untouched');
});
