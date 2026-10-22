import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import amqp from 'amqplib';
import { PrismaClient } from '../../services/clinic/src/generated/client/index.js';
import { OutboxRelay } from '../../services/clinic/dist/relay.js';
import { topology, declareTopology } from '@nipopeto/messaging';

// List study v1 K3-F1: one event per AMQP connection capped the Clinic relay near
// 11 events/s while the AB build stores two events per appointment write. Every
// row here shares this run's aggregateId and each relay is scoped to it, so rows
// left unpublished by other suites in the shared proof schema are never claimed.
assert.equal(process.env.PHASE2_TEST_CONFIRM, 'pet-phase2-p1-test', 'Use guarded phase2:test:clinic-relay');
const url = 'postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test?schema=p1_proof';
const broker = 'amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679';
const db = new PrismaClient({ datasourceUrl: url }), run = randomUUID(), routes = topology(`p2.relay.${run}`);
let connection, channel, foreignPending, clock = Date.now() - 3600000;
const report = { run, cases: {} };

const notification = (scope, i) => ({ eventId: randomUUID(), eventType: 'notification.requested.v1', schemaVersion: 1, producer: 'clinic', aggregateType: 'notification', aggregateId: scope, aggregateVersion: 1, occurredAt: new Date().toISOString(), correlationId: run, payload: { notificationId: randomUUID(), recipientOwnerId: randomUUID(), title: 'Relay fixture ' + i, message: 'Relay fixture' } });
const readChanged = (scope, version) => ({ eventId: randomUUID(), eventType: 'clinic.appointment-read-changed.v1', schemaVersion: 1, producer: 'clinic', aggregateType: 'appointment', aggregateId: scope, aggregateVersion: version, occurredAt: new Date().toISOString(), correlationId: run, payload: { appointmentId: scope, sourceVersion: version, deleted: false } });
// Strictly increasing createdAt gives a deterministic claim order.
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
  assert.equal(identity.db, 'p2_clinic_test'); assert.equal(identity.role, 'p2_clinic');
  const [marker] = await db.$queryRaw`SELECT marker FROM public.p2_test_marker`;
  assert.equal(marker.marker, 'pet-phase2-p1-test:clinic:v1');
  foreignPending = await db.outboxEvent.count({ where: { publishedAt: null } });
  await declareTopology(broker, routes);
  connection = await amqp.connect(broker); connection.on('error', () => {});
  channel = await connection.createChannel(); channel.on('error', () => {});
});
test.after(async () => {
  try {
    for (const q of [routes.notification, routes.clinic, routes.clinicRead]) for (const name of [q, q + '.dlq']) await channel.deleteQueue(name).catch(() => {});
    await channel.deleteExchange(routes.exchange).catch(() => {});
    mkdirSync('test-results/phase2', { recursive: true });
    writeFileSync(`test-results/phase2/clinic-relay-${run}.json`, JSON.stringify(report, null, 2));
  } finally { await channel?.close().catch(() => {}); await connection?.close().catch(() => {}); await db.$disconnect(); }
});

test('batched persistent relay publishes each claimed event once, in claim order, over one reused connection', async () => {
  const scope = randomUUID(), envelopes = [];
  for (let i = 0; i < 60; i++) envelopes.push(notification(scope, i), readChanged(scope, i + 1));
  const ids = await seed(envelopes);
  const relay = new OutboxRelay(db, broker, scope, { batchSize: 50, persistent: true });
  try {
    assert.equal(await relay.once('relay-batch', routes), true);
    const first = relay.connection; assert.ok(first, 'connection kept after a batch');
    assert.equal((await rowsOf(ids)).filter(r => r.publishedAt).length, 50, 'one call publishes one batch');
    assert.equal(await drain(relay, 'relay-batch'), 2);
    assert.equal(relay.connection, first, 'same connection reused across batches');
  } finally { await relay.close(); }
  assert.equal(relay.connection, undefined);
  const rows = await rowsOf(ids);
  assert.ok(rows.every(r => r.publishedAt && r.leaseOwner === null && r.leaseUntil === null && r.attempts === 1 && r.lastErrorCode === null));
  await settle(routes.clinicRead, 60);
  const notified = await take(routes.notification), read = await take(routes.clinicRead);
  assert.deepEqual(notified, envelopes.filter(e => e.eventType.startsWith('notification')).map(e => e.eventId), 'notification queue keeps claim order, no duplicates');
  assert.deepEqual(read, envelopes.filter(e => e.eventType.startsWith('clinic.')).map(e => e.eventId), 'read queue keeps aggregateVersion order');
});

test('unroutable events in a batch are retried with backoff while routable ones are marked published', async () => {
  const scope = randomUUID(), good = [notification(scope, 0), notification(scope, 1), notification(scope, 2)], bad = [readChanged(scope, 1), readChanged(scope, 2)];
  const ids = await seed([good[0], bad[0], good[1], bad[1], good[2]]);
  await channel.unbindQueue(routes.clinicRead, routes.exchange, 'clinic.appointment-read-changed.v1');
  const relay = new OutboxRelay(db, broker, scope, { batchSize: 10, persistent: true });
  try {
    await assert.rejects(relay.once('relay-unroutable', routes), /UNROUTABLE/);
    assert.equal(relay.connection, undefined, 'a failed batch drops the connection');
    const rows = new Map((await rowsOf(ids)).map(r => [r.id, r]));
    for (const e of good) assert.ok(rows.get(e.eventId).publishedAt);
    for (const e of bad) {
      const r = rows.get(e.eventId);
      assert.equal(r.publishedAt, null); assert.equal(r.leaseOwner, null); assert.equal(r.lastErrorCode, 'DELIVERY_UNCONFIRMED');
      assert.ok(r.nextAttemptAt > new Date(), 'backoff before retry'); assert.equal(r.attempts, 1);
    }
    assert.equal(await relay.once('relay-unroutable', routes), false, 'backed-off rows are not reclaimed early');
    await channel.bindQueue(routes.clinicRead, routes.exchange, 'clinic.appointment-read-changed.v1');
    await db.outboxEvent.updateMany({ where: { id: { in: bad.map(e => e.eventId) } }, data: { nextAttemptAt: new Date() } });
    assert.equal(await drain(relay, 'relay-unroutable'), 1);
  } finally { await relay.close(); }
  assert.ok((await rowsOf(bad.map(e => e.eventId))).every(r => r.publishedAt && r.attempts === 2));
  await settle(routes.clinicRead, 2);
  assert.equal((await take(routes.notification)).length, 3); assert.equal((await take(routes.clinicRead)).length, 2);
});

test('an invalid envelope in a batch is retried alone; valid neighbours are published', async () => {
  const scope = randomUUID(), poison = { ...notification(scope, 9), schemaVersion: 2 }, good = [notification(scope, 0), notification(scope, 1)];
  const ids = await seed([good[0], poison, good[1]]);
  const relay = new OutboxRelay(db, broker, scope, { batchSize: 10, persistent: true });
  try { await assert.rejects(relay.once('relay-poison', routes), /INVALID_ENVELOPE/); } finally { await relay.close(); }
  const rows = new Map((await rowsOf(ids)).map(r => [r.id, r]));
  assert.ok(good.every(e => rows.get(e.eventId).publishedAt));
  const bad = rows.get(poison.eventId); assert.equal(bad.publishedAt, null); assert.equal(bad.lastErrorCode, 'DELIVERY_UNCONFIRMED'); assert.ok(bad.nextAttemptAt > new Date());
  await settle(routes.notification, 2); assert.equal((await take(routes.notification)).length, 2);
  // Retire the fixture so the final untouched-rows check stays exact.
  await db.outboxEvent.update({ where: { id: poison.eventId }, data: { publishedAt: new Date(), lastErrorCode: 'TEST_RETIRED_INVALID_FIXTURE' } });
});

test('broker unreachable: the whole batch is released for retry and nothing is marked published', async () => {
  const scope = randomUUID(), ids = await seed([notification(scope, 0), notification(scope, 1), readChanged(scope, 1)]);
  const relay = new OutboxRelay(db, 'amqp://p2_test:p2_broker_fixture_only@127.0.0.1:1', scope, { batchSize: 10, persistent: true });
  await assert.rejects(relay.once('relay-down', routes));
  assert.equal(relay.connection, undefined);
  assert.ok((await rowsOf(ids)).every(r => r.publishedAt === null && r.leaseOwner === null && r.lastErrorCode === 'DELIVERY_UNCONFIRMED' && r.nextAttemptAt > new Date()));
  await db.outboxEvent.updateMany({ where: { id: { in: ids } }, data: { nextAttemptAt: new Date() } });
  const healthy = new OutboxRelay(db, broker, scope, { batchSize: 10, persistent: true });
  try { assert.equal(await drain(healthy, 'relay-down'), 1); } finally { await healthy.close(); }
  await settle(routes.clinicRead, 1);
  assert.equal((await take(routes.notification)).length, 2); assert.equal((await take(routes.clinicRead)).length, 1);
});

test('crash after confirm (afterConfirm throws) keeps the batch leased, unmarked and closes the connection', async () => {
  const scope = randomUUID(), ids = await seed([notification(scope, 0), notification(scope, 1)]);
  const relay = new OutboxRelay(db, broker, scope, { batchSize: 10 });
  await assert.rejects(relay.once('relay-crash', routes, () => { throw new Error('CRASH_AFTER_CONFIRM'); }), /CRASH_AFTER_CONFIRM/);
  assert.equal(relay.connection, undefined);
  const rows = await rowsOf(ids);
  assert.ok(rows.every(r => r.publishedAt === null && r.leaseOwner !== null && r.leaseUntil > new Date() && r.lastErrorCode === null), 'redelivery after lease expiry is the documented duplicate path');
  assert.equal(await relay.once('relay-crash', routes), false, 'leased rows are not reclaimed before expiry');
  await db.outboxEvent.updateMany({ where: { id: { in: ids } }, data: { leaseUntil: new Date(Date.now() - 1000) } });
  assert.equal(await drain(relay, 'relay-crash'), 1);
  await settle(routes.notification, 4);
  assert.equal((await take(routes.notification)).length, 4, 'confirmed before the crash, then republished: at-least-once');
});

test('two relays racing on the same rows publish every event exactly once', async () => {
  const scope = randomUUID(), envelopes = Array.from({ length: 200 }, (_, i) => notification(scope, i)), ids = await seed(envelopes);
  const relays = [1, 2].map(() => new OutboxRelay(db, broker, scope, { batchSize: 20, persistent: true }));
  try { await Promise.all(relays.map((r, i) => drain(r, 'relay-race-' + i))); } finally { await Promise.all(relays.map(r => r.close())); }
  assert.ok((await rowsOf(ids)).every(r => r.publishedAt && r.attempts === 1));
  await settle(routes.notification, 200);
  const seen = await take(routes.notification);
  assert.equal(seen.length, 200); assert.equal(new Set(seen).size, 200);
});

test('default options keep the original one-event, one-connection relay', async () => {
  const scope = randomUUID(), ids = await seed([notification(scope, 0), notification(scope, 1)]);
  const relay = new OutboxRelay(db, broker, scope);
  assert.equal(await relay.once('relay-default', routes), true);
  assert.equal(relay.connection, undefined, 'connection closed after each call');
  assert.equal((await rowsOf(ids)).filter(r => r.publishedAt).length, 1, 'one event per call');
  assert.equal(await drain(relay, 'relay-default'), 1);
  assert.throws(() => new OutboxRelay(db, broker, scope, { batchSize: 0 }), /INVALID_RELAY_BATCH/);
  await settle(routes.notification, 2); assert.equal((await take(routes.notification)).length, 2);
});

test('throughput: batched persistent relay outpaces the one-event relay on the same broker and DB', { timeout: 300000 }, async () => {
  const measure = async (options, n) => {
    const scope = randomUUID(), envelopes = [];
    for (let i = 0; i < n / 2; i++) envelopes.push(notification(scope, i), readChanged(scope, i + 1));
    await seed(envelopes);
    const relay = new OutboxRelay(db, broker, scope, options), started = performance.now();
    try { await drain(relay, 'relay-throughput'); } finally { await relay.close(); }
    const seconds = (performance.now() - started) / 1000;
    await settle(routes.clinicRead, n / 2); await take(routes.notification); await take(routes.clinicRead);
    return { events: n, seconds: Math.round(seconds * 100) / 100, eventsPerSecond: Math.round(n / seconds) };
  };
  const original = await measure({}, 400), batched = await measure({ batchSize: 50, persistent: true }, 2000);
  report.cases.throughput = { original, batched, ratio: Math.round(batched.eventsPerSecond / original.eventsPerSecond * 10) / 10, note: 'local Docker, shared host; functional comparison, not a benchmark' };
  process.stdout.write(JSON.stringify(report.cases.throughput) + '\n');
  assert.ok(batched.eventsPerSecond >= 3 * original.eventsPerSecond, JSON.stringify(report.cases.throughput));
  assert.equal(await db.outboxEvent.count({ where: { publishedAt: null } }), foreignPending, 'rows outside this run stay untouched');
});
