import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import amqp from 'amqplib';
import { PrismaClient } from '../../services/notification/src/generated/client/index.js';
import { createApp } from '../../services/notification/src/app.ts';
import { NotificationInbox } from '../../services/notification/src/inbox.ts';
import { declareTopology, topology, publishConfirmed, consumeEvents } from '@nipopeto/messaging';
import { actorVerifier } from '@nipopeto/runtime';
import { topologyQueues } from './test-project.mjs';

assert.equal(process.env.PHASE2_TEST_CONFIRM, 'pet-phase2-p1-test', 'Use guarded phase2:test:notification');
const url = 'postgresql://p2_notification:p2_notification_fixture_only@127.0.0.1:55432/p2_notification_test?schema=p1_proof';
const db = new PrismaClient({ datasourceUrl: url });
const run = randomUUID(), a = randomUUID(), b = randomUUID();
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), issuer: 'p2-fixture-core', audience: 'pet-healthcare' };
const verify = actorVerifier(config), inbox = new NotificationInbox(db);
const sign = (sub, role, options = {}) => jwt.sign({ role }, keys.privateKey, { algorithm: 'RS256', subject: sub, issuer: config.issuer, audience: config.audience, expiresIn: '5m', ...options });
const tokens = { a: sign(a, 'owner'), b: sign(b, 'owner'), admin: sign(randomUUID(), 'admin'), doctor: sign(randomUUID(), 'doctor') };
let server, base, connection, channel, consumer, upgradedFixture;
const routes = topology(`p2.notification-api.${run}`);
const fixture = (overrides = {}) => ({
  eventId: randomUUID(), eventType: 'notification.requested.v1', schemaVersion: 1, producer: 'core',
  aggregateType: 'notification', aggregateId: run, aggregateVersion: 1,
  occurredAt: '2026-10-11T01:00:00.000Z', correlationId: run,
  payload: { notificationId: randomUUID(), recipientOwnerId: a, title: run, message: 'Synthetic fixture', ...overrides },
});
async function request(path = '', { method = 'GET', token = tokens.a } = {}) {
  const response = await fetch(`${base}/api/notifications${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(3000) });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Fixture delivery timed out');
}
test.before(async () => {
  const [identity] = await db.$queryRaw`SELECT current_database() AS db, current_user AS role`;
  assert.equal(identity.db, 'p2_notification_test'); assert.equal(identity.role, 'p2_notification');
  const [marker] = await db.$queryRaw`SELECT marker FROM public.p2_test_marker`;
  assert.equal(marker.marker, 'pet-phase2-p1-test:notification:v1');
  const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'p1_proof' AND tablename = 'ProofNotification'`;
  if (tables.length) {
    upgradedFixture = randomUUID();
    await db.$executeRaw`INSERT INTO "ProofNotification" ("id","recipientOwnerId","title","message","read") VALUES (${upgradedFixture},${b},${run},'Migration fixture',true)`;
  }
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'services/notification/prisma/schema.prisma'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
  if (upgradedFixture) {
    const row = await db.notification.findUniqueOrThrow({ where: { id: upgradedFixture } });
    assert.equal(row.status, 'read'); assert.equal(row.recipientOwnerId, b); assert.equal(row.title, run);
  }
  server = createApp(db, verify).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
  const deadline = Date.now() + 10000;
  while (!connection) {
    try { connection = await amqp.connect('amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679'); }
    catch { if (Date.now() > deadline) throw new Error('Fixture broker unavailable'); await new Promise(r => setTimeout(r, 100)); }
  }
  connection.on('error', () => {}); channel = await connection.createConfirmChannel(); channel.on('error', () => {});
  await declareTopology('amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679', routes);
  consumer = await consumeEvents('amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679', routes.notification, 'notification', raw => inbox.apply(raw));
});
test.after(async () => {
  const retained = [];
  try {
    await consumer?.close();
    if (channel) {
      for (const name of topologyQueues(routes, [routes.notification, routes.identity, routes.clinic])) {
        const state = await channel.checkQueue(name);
        if (state.messageCount) retained.push(name); else await channel.deleteQueue(name);
      }
      if (!retained.length) await channel.deleteExchange(routes.exchange);
    }
  } finally {
    await channel?.close().catch(() => {}); await connection?.close().catch(() => {});
    if (server) await new Promise(r => server.close(r)); await db.$disconnect();
  }
  assert.deepEqual(retained, [], 'Retain failed nonempty fixture queues');
});
test('real broker/inbox preserves all fields; rollback is atomic; replay after HTTP delete cannot resurrect', async () => {
  const event = fixture({ type: 'medical_record_updated', status: 'read', actionUrl: '/owner/medical-records', relatedPetId: 'fixture-pet', relatedAppointmentId: 'fixture-appointment', relatedBookingId: null, sentByStaffId: 'fixture-doctor', createdAt: '2026-01-02T03:04:05.000Z', sentAt: '2026-01-02T03:04:06.000Z' });
  await assert.rejects(inbox.apply(JSON.stringify(event), () => { throw new Error('TEST_ROLLBACK'); }));
  assert.equal(await db.notification.count({ where: { id: event.payload.notificationId } }), 0);
  assert.equal(await db.inboxEvent.count({ where: { eventId: event.eventId } }), 0);
  await publishConfirmed(channel, routes.exchange, event.eventType, Buffer.from(JSON.stringify(event)), { messageId: event.eventId, contentType: 'application/json' });
  const row = await until(() => db.notification.findUnique({ where: { id: event.payload.notificationId } }));
  for (const [key, value] of Object.entries(event.payload)) {
    if (key === 'notificationId') assert.equal(row.id, value);
    else if (key.endsWith('At')) assert.equal(row[key].toISOString(), value);
    else assert.equal(row[key], value);
  }
  const read = await request(`?id=${row.id}`); assert.equal(read.body.items[0].id, row.id);
  assert.equal((await request(`/${row.id}`, { method: 'DELETE' })).status, 204);
  await publishConfirmed(channel, routes.exchange, event.eventType, Buffer.from(JSON.stringify(event)), { messageId: event.eventId, contentType: 'application/json' });
  await until(async () => (await channel.checkQueue(routes.notification)).messageCount === 0);
  // A synchronous duplicate checks the durable inbox even if broker ACK is still in flight.
  assert.equal(await inbox.apply(JSON.stringify(event)), false);
  assert.equal(await db.notification.count({ where: { id: row.id } }), 0);
});
test('list/query/counts/pagination match legacy contract and never accept caller owner scope', async () => {
  const ids = [];
  for (let i = 0; i < 23; i++) {
    const event = fixture({ type: i < 5 ? 'appointment_created' : 'general', status: i < 3 ? 'read' : 'sent' });
    await inbox.apply(JSON.stringify(event)); ids.push(event.payload.notificationId);
  }
  await inbox.apply(JSON.stringify(fixture({ recipientOwnerId: b, title: `${run}-other-owner` })));
  await inbox.apply(JSON.stringify(fixture({ recipientOwnerId: null, recipientRole: 'admin', title: `${run}-admin` })));
  const page = await request(`?page=2&pageSize=10&ownerId=${b}`);
  assert.equal(page.status, 200); assert.equal(page.body.items.length, 10);
  assert.deepEqual(page.body.pagination, { page: 2, pageSize: 10, total: 23, totalPages: 3 });
  const expected = [...ids].sort().reverse().slice(10, 20); assert.deepEqual(page.body.items.map(x => x.id), expected);
  assert.ok(page.body.items.every(x => x.recipientOwnerId === a));
  assert.deepEqual(page.body.counts, { read: 3, sent: 20, 'category:appointments': 5, 'category:promo': 18, 'category:all': 23 });
  assert.ok(Object.values(page.body.related).every(x => Array.isArray(x) && !x.length));
  const filtered = await request(`?category=appointments&status=sent&q=${run.toUpperCase()}`);
  assert.equal(filtered.body.pagination.total, 2); assert.equal(filtered.body.counts.read, 3);
  assert.equal(filtered.body.counts['category:promo'], 18);
  for (const query of ['page=0', 'pageSize=101', 'page=1&page=2', 'status=pending', 'category=unknown', 'q=' + 'x'.repeat(101)]) assert.equal((await request(`?${query}`)).status, 422);
});
test('inbox tabs place a status update by the booking it names and cover billing and rescue', async () => {
  const c = randomUUID(), token = sign(c, 'owner');
  const sent = [['booking_status_updated', { relatedAppointmentId: randomUUID() }, 'appointments'], ['booking_status_updated', { relatedBookingId: randomUUID() }, 'hotel'],
    ['hotel_daily_update', {}, 'hotel'], ['invoice_paid', {}, 'billing'], ['transfer_rejected', {}, 'billing'], ['pet_rescue_report', {}, 'rescue'], ['general', {}, 'promo']];
  for (const [type, related] of sent) await inbox.apply(JSON.stringify(fixture({ recipientOwnerId: c, type, ...related })));
  const all = await request('', { token });
  assert.deepEqual(all.body.counts, { sent: 7, 'category:appointments': 1, 'category:hotel': 2, 'category:billing': 2, 'category:rescue': 1, 'category:promo': 1, 'category:all': 7 });
  for (const tab of ['appointments', 'hotel', 'medical', 'billing', 'rescue', 'promo']) {
    const page = await request(`?category=${tab}`, { token });
    assert.equal(page.status, 200, tab);
    assert.deepEqual(page.body.items.map(x => x.type).sort(), sent.filter(s => s[2] === tab).map(s => s[0]).sort(), tab);
    assert.equal(page.body.counts['category:all'], 7, 'tab counts ignore the selected tab');
  }
  const hotel = await request('?category=hotel&q=Synthetic', { token });
  assert.equal(hotel.body.pagination.total, 2, 'a search inside a tab keeps both filters');
});
test('read, read-all, delete and unread-count enforce owner/staff visibility', async () => {
  const other = (await request(`?q=${run}&status=sent`, { token: tokens.b })).body.items[0];
  assert.equal((await request(`/${other.id}/read`, { method: 'PATCH' })).status, 404);
  assert.equal((await request(`/${other.id}`, { method: 'DELETE' })).status, 404);
  const own = (await request('?status=sent')).body.items[0];
  const marked = await request(`/${own.id}/read`, { method: 'PATCH' });
  assert.equal(marked.body.notification.status, 'read');
  assert.equal((await request(`/${own.id}/read`, { method: 'PATCH' })).status, 200);
  assert.equal((await request('/unread-count')).body.unread, 19);
  assert.equal((await request('/read-all', { method: 'PATCH' })).status, 200);
  assert.equal((await request('/unread-count')).body.unread, 0);
  assert.equal((await db.notification.findUniqueOrThrow({ where: { id: other.id } })).status, 'sent');
  for (const token of [tokens.admin, tokens.doctor]) {
    const staff = await request(`?q=${run}`, { token });
    assert.equal(staff.body.items.length, 1); assert.equal(staff.body.items[0].recipientRole, 'admin');
    assert.equal((await request(`/${own.id}/read`, { method: 'PATCH', token })).status, 404);
    assert.equal((await request(`/${own.id}`, { method: 'DELETE', token })).status, 404);
  }
  const adminId = (await request(`?q=${run}`, { token: tokens.admin })).body.items[0].id;
  assert.equal((await request(`/${adminId}/read`, { method: 'PATCH' })).status, 404);
  assert.equal((await request(`/${adminId}/read`, { method: 'PATCH', token: tokens.doctor })).body.notification.status, 'read');
  assert.equal((await request('/read-all', { method: 'PATCH', token: tokens.admin })).status, 200);
  assert.equal((await db.notification.findUniqueOrThrow({ where: { id: other.id } })).status, 'sent');
  assert.equal((await request(`/${adminId}`, { method: 'DELETE', token: tokens.admin })).status, 204);
  assert.equal((await request(`/${adminId}`, { method: 'DELETE', token: tokens.admin })).status, 404);
  const count = await request('/unread-count'); assert.ok(Number.isFinite(Date.parse(count.body.asOf)));
});
test('public-key verification rejects missing, expired, wrong issuer/audience/role/key and symmetric tokens', async () => {
  assert.equal((await request('', { token: null })).status, 401);
  const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const invalid = [sign(a, 'owner', { expiresIn: -1 }), sign(a, 'owner', { issuer: 'other' }), sign(a, 'owner', { audience: 'other' }), sign(a, 'unknown'),
    jwt.sign({ role: 'owner' }, otherKeys.privateKey, { algorithm: 'RS256', subject: a, issuer: config.issuer, audience: config.audience, expiresIn: '5m' }),
    jwt.sign({ role: 'owner' }, 'fixture-hmac-secret', { algorithm: 'HS256', subject: a, issuer: config.issuer, audience: config.audience, expiresIn: '5m' }),
    jwt.sign({ role: 'owner' }, keys.privateKey, { algorithm: 'RS256', subject: a, issuer: config.issuer, audience: config.audience })];
  for (const token of invalid) assert.equal((await request('', { token })).status, 401);
});
test('DB failure returns unavailable instead of a false zero unread count; unconfigured API fails closed', async () => {
  const failed = { $transaction: async () => { throw new Error('Fixture credential must not leak'); } };
  const offline = createApp(failed, verify).listen(0, '127.0.0.1'); await new Promise(r => offline.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${offline.address().port}/api/notifications/unread-count`, { headers: { Authorization: `Bearer ${tokens.a}` } });
    assert.equal(res.status, 503); const body = await res.json(); assert.equal(body.unread, undefined); assert.equal(body.error, 'Notification service unavailable.');
  } finally { await new Promise(r => offline.close(r)); }
  const closed = createApp(db).listen(0, '127.0.0.1'); await new Promise(r => closed.once('listening', r));
  try { assert.equal((await fetch(`http://127.0.0.1:${closed.address().port}/api/notifications`)).status, 503); }
  finally { await new Promise(r => closed.close(r)); }
});
