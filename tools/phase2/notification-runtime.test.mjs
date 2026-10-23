import test from 'node:test';
import {waitForQueueIdle} from './test-project.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { PrismaClient as CoreClient } from '@prisma/client';
import { PrismaClient as NotificationClient } from '../../services/notification/src/generated/client/index.js';
import { PrismaClient as ClinicClient } from '../../services/clinic/src/generated/client/index.js';
import { createCoreApp } from '../../backend/dist/src/phase2/coreApp.js';
import { signToken } from '../../backend/dist/src/lib/token.js';
import { hashPasswordAsync } from '../../backend/dist/src/lib/password.js';
import { createApp } from '../../services/notification/dist/app.js';
import { actorVerifier } from '../../services/notification/dist/auth.js';
import { CoreSendAuthorization } from '../../services/notification/dist/coreAuthorization.js';
import { ManualSend } from '../../services/notification/dist/manualSend.js';
import { createPublicRescueDependencies } from '../../backend/dist/src/infrastructure/persistence/publicRescueRepository.js';
import { validate, responseSchema } from './openapi-validate.mjs';
import { PrismaHotelPendingExpiryStore } from '../../backend/dist/src/infrastructure/persistence/hotelPendingExpiryStore.js';
import { expiryBounds } from '../../backend/dist/src/domain/hotelPendingExpiry.js';
import { readFileSync as readSpec } from 'node:fs';
import { writeNotification as clinicNotification } from '../../services/clinic/dist/notificationOutbox.js';
import { OutboxRelay as ClinicRelay } from '../../services/clinic/dist/relay.js';
import { NotificationInbox } from '../../services/notification/dist/inbox.js';
import { PrismaInvoiceRepository } from '../../backend/dist/src/infrastructure/persistence/invoiceRepository.js';
import { PrismaPaymentRepository } from '../../backend/dist/src/infrastructure/persistence/paymentRepository.js';
import { exportNotifications, inspectImport, importNotifications, verifyImport } from './notification-migration.mjs';
import amqp from 'amqplib';
import { topology, declareTopology } from '@nipopeto/messaging';

assert.equal(process.env.PHASE2_TEST_CONFIRM, 'pet-phase2-p1-test', 'Use guarded phase2:test:notification-runtime');
const urls = {
  core: 'postgresql://p2_core:p2_core_fixture_only@127.0.0.1:55432/p2_core_test?schema=core_runtime_test',
  notification: 'postgresql://p2_notification:p2_notification_fixture_only@127.0.0.1:55432/p2_notification_test?schema=p1_proof',
  clinic: 'postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test?schema=p1_proof',
};
const core = new CoreClient({ datasourceUrl: urls.core }), notification = new NotificationClient({ datasourceUrl: urls.notification }), clinic = new ClinicClient({ datasourceUrl: urls.clinic });
const run = randomUUID(), credential = 'p2-private-fixture-' + randomUUID();
const broker = 'amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679', routes = topology(`p2.runtime.${run}`);
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const auth = { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), issuer: 'p2-core-runtime', audience: 'pet-healthcare' };
const date = new Date(Date.now() + 7 * 3600000 + 86400000).toISOString().slice(0, 10);
const owner = randomUUID(), other = randomUUID(), admin = randomUUID(), doctor = randomUUID(), staff = randomUUID();
let coreServer, notificationServer, coreUrl, notificationUrl, corePort, pet, connection, channel, stoppedBroker = false;
// The shared trial schema retains other runs' unpublished Core rows. The Core
// worker relays only rows created after this DB-clock instant (minus 1s skew);
// older rows are left untouched, never deleted or marked published.
let runStartedAt, olderPending;
const workers = [];
const tokens = {};
let aq05; // user and sessions from the AQ-05 password-change test, checked again at Notification after the relay

const docker = (...args) => execFileSync('docker', ['compose','-f','deploy/phase2/compose.test.yml',...args], { stdio: 'pipe', timeout: 30000 });
async function until(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 25)); }
  throw new Error(`Timeout: ${label}`);
}
async function listen(app, port = 0) { const server = app.listen(port, '127.0.0.1'); await once(server, 'listening'); return server; }
const close = server => server ? new Promise(r => server.close(r)) : Promise.resolve();
const startCore = async () => { coreServer = await listen(createCoreApp(core, { notificationUrl, notificationToken: credential }), corePort); };
async function request(path, { method = 'GET', token = tokens.owner, body, key, base = coreUrl, headers = {} } = {}) {
  const res = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(6000) });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}
const requireStatus = (result, expected) => { assert.equal(result.status, expected, JSON.stringify(result.body)); return result.body; };
async function brokerConnection() {
  let value;
  await until(async () => { try { value = await amqp.connect(broker, { timeout: 1000 }); return true; } catch { return false; } }, 'AMQP authenticated readiness', 15000);
  value.on('error', () => {}); return value;
}
async function startWorker(file, env) {
  const baseEnv = { ...process.env }; delete baseEnv.JWT_PRIVATE_KEY; delete baseEnv.JWT_SECRET;
  const child = spawn(process.execPath, [file], { env: { ...baseEnv, ...env }, stdio: 'pipe' });
  let output = '', exited = false;
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; }); child.once('exit', () => { exited = true; });
  const handle = { stop: async () => { if (!exited) { child.kill(); await once(child, 'exit'); } }, logs: () => output };
  workers.push(handle);
  await until(() => { if (exited) throw new Error('Built worker exited before ready'); return output.includes('worker-ready'); }, 'built worker ready');
  return handle;
}
test.before(async () => {
  for (const [service, db] of Object.entries({ core, notification, clinic })) {
    const [identity] = await db.$queryRaw`SELECT current_database() AS db, current_user AS role`;
    assert.equal(identity.db, `p2_${service}_test`); assert.equal(identity.role, `p2_${service}`);
    const [marker] = await db.$queryRaw`SELECT marker FROM public.p2_test_marker`;
    assert.equal(marker.marker, `pet-phase2-p1-test:${service}:v1`);
    const schema = service === 'core' ? 'backend/prisma/schema.prisma' : `services/${service}/prisma/schema.prisma`;
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js','migrate','deploy','--schema',schema], { env: { ...process.env, DATABASE_URL: urls[service] }, stdio: 'pipe' });
  }
  // AQ-10: this persistent test database accumulates active stays across runs; suites that do not test
  // capacity run with 1000 rooms per type. The capacity test below sets and restores its own values.
  await core.$executeRaw`UPDATE hotel_room_capacity SET capacity = 1000`; await core.$executeRaw`UPDATE hotel_room_nights SET capacity = 1000`;
  const [{ now }] = await core.$queryRaw`SELECT clock_timestamp() AS now`;
  runStartedAt = new Date(now.getTime() - 1000).toISOString();
  olderPending = await core.outboxEvent.findFirst({ where: { publishedAt: null, createdAt: { lt: new Date(runStartedAt) } }, select: { id: true } });
  process.env.JWT_PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  process.env.JWT_PUBLIC_KEY = auth.publicKey; process.env.JWT_ISSUER = auth.issuer; process.env.JWT_AUDIENCE = auth.audience;
  const password = await hashPasswordAsync('P2-fixture-password-only!');
  for (const [id, role] of [[owner,'owner'],[other,'owner'],[admin,'admin'],[doctor,'doctor'],[staff,'staff']]) await core.user.create({ data: { id, role, fullName: `Fixture ${run}`, email: `${id}@example.invalid`, ...password } });
  for (const [name,id,role] of [['owner',owner,'owner'],['other',other,'owner'],['admin',admin,'admin'],['doctor',doctor,'doctor'],['staff',staff,'staff']]) tokens[name] = signToken(id, role);
  pet = await core.pet.create({ data: { ownerId: owner, name: 'Synthetic P2 pet', species: 'dog', allergies: [], qrToken: randomUUID(), qrEnabled: true } });
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); corePort = reserve.address().port; await close(reserve); coreUrl = `http://127.0.0.1:${corePort}`;
  notificationServer = await listen(createApp(notification, actorVerifier(auth), new CoreSendAuthorization(coreUrl, credential, 1000)));
  notificationUrl = `http://127.0.0.1:${notificationServer.address().port}`;
  await startCore();
  await declareTopology(broker, routes); connection = await brokerConnection(); channel = await connection.createConfirmChannel(); channel.on('error', () => {});
});
test.after(async () => {
  const retained = [];
  try {
    await Promise.all(workers.map(w => w.stop()));
    if (stoppedBroker) { docker('up','-d','--wait','rabbitmq'); stoppedBroker = false; }
    if (!connection) { connection = await brokerConnection(); channel = await connection.createConfirmChannel(); channel.on('error', () => {}); }
    for (const q of [routes.notification,`${routes.notification}.dlq`,routes.clinic,`${routes.clinic}.dlq`]) {
      const state = await channel.checkQueue(q); if (state.messageCount) retained.push(q); else await channel.deleteQueue(q);
    }
    if (!retained.length) await channel.deleteExchange(routes.exchange);
  } finally {
    await channel?.close().catch(() => {}); await connection?.close().catch(() => {});
    await close(coreServer); await close(notificationServer);
    await Promise.all([core.$disconnect(),notification.$disconnect(),clinic.$disconnect()]);
  }
  assert.deepEqual(retained, [], 'Nonempty failed queues retained');
});

test('Core issues compatible RSA tokens; actual login, public gateway and private source authorization preserve all staff roles', async () => {
  const login = requireStatus(await request('/api/auth/owner/login', { method: 'POST', token: null, body: { email: `${owner}@example.invalid`, password: 'P2-fixture-password-only!' } }), 200);
  assert.equal(actorVerifier(auth)(login.token).sub, owner);
  for (const role of ['admin','doctor','staff']) requireStatus(await request('/api/notifications', { token: tokens[role] }), 200);
  const path = '/internal/notifications/authorize-send';
  requireStatus(await request(path, { method: 'POST', token: tokens.admin, body: { recipientOwnerId: owner } }), 401);
  requireStatus(await request(path, { method: 'POST', token: tokens.owner, body: { recipientOwnerId: owner }, headers: { 'X-Service-Token': credential } }), 403);
  const permitted = requireStatus(await request(path, { method: 'POST', token: tokens.staff, body: { recipientOwnerId: owner }, headers: { 'X-Service-Token': credential } }), 200);
  assert.deepEqual(permitted, { actorId: staff, actorRole: 'staff', recipientOwnerId: owner, authorized: true });
  assert.ok(!JSON.stringify(permitted).includes('password'));
});
test('manual send commits once under concurrent HTTP replicas/retries; key mismatch, actor scope and replay after delete', async () => {
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await close(reserve);
  const env = { ...process.env, DATABASE_URL: urls.notification, PORT: String(port), CORE_SERVICE_URL: coreUrl, NOTIFICATION_SERVICE_TOKEN: credential };
  delete env.JWT_PRIVATE_KEY; delete env.JWT_SECRET;
  const child = spawn(process.execPath, ['services/notification/dist/index.js'], { env, stdio: 'pipe' });
  let exited = false; child.once('exit', () => { exited = true; });
  const replica = `http://127.0.0.1:${port}`;
  try {
    await until(async () => { if (exited) throw new Error('Notification replica exited'); try { return (await fetch(replica + '/health/ready', { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, 'second Notification process ready');
  const key = randomUUID(), body = { recipientOwnerId: owner, title: run, message: 'Manual fixture' };
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => request('/api/notifications/send', { method: 'POST', token: tokens.admin, key, body, base: i % 2 ? replica : coreUrl })));
  const sent = results.map(r => requireStatus(r, 201)); assert.equal(new Set(sent.map(r => r.notification.id)).size, 1);
  assert.equal(await notification.requestDedup.count({ where: { actorId: admin, key } }), 1);
  const lostKey = randomUUID();
  // Real HTTP: server commits and sends headers; client discards the entire
  // response body before learning the resource ID, then retries the same key.
  await new Promise((resolve, reject) => {
    const req = httpRequest(replica + '/api/notifications/send', { method: 'POST', headers: { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': 'application/json', 'Idempotency-Key': lostKey } }, res => {
      try { assert.equal(res.statusCode, 201); res.destroy(); resolve(); }
      catch (error) { res.destroy(); reject(error); }
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  const committed = await notification.requestDedup.findUniqueOrThrow({ where: { actorId_operationType_key: { actorId: admin, operationType: 'notification.send', key: lostKey } } });
  const recovered = requireStatus(await request('/api/notifications/send', { method: 'POST', token: tokens.admin, key: lostKey, body }), 201);
  assert.equal(recovered.notification.id, committed.resourceId);
  assert.equal(await notification.notification.count({ where: { id: committed.resourceId } }), 1);
  requireStatus(await request('/api/notifications/send', { method: 'POST', token: tokens.admin, key, body: { ...body, message: 'Changed fixture' } }), 409);
  // AQ-05: doctors do not send manual notifications; the same key under another permitted actor is a new operation.
  assert.match(requireStatus(await request('/api/notifications/send', { method: 'POST', token: tokens.doctor, key, body }), 403).error, /nhân viên hoặc quản trị viên/);
  const otherActor = requireStatus(await request('/api/notifications/send', { method: 'POST', token: tokens.staff, key, body }), 201);
  assert.notEqual(otherActor.notification.id, sent[0].notification.id);
  requireStatus(await request(`/api/notifications/${sent[0].notification.id}`, { method: 'DELETE' }), 204);
  assert.deepEqual(requireStatus(await request('/api/notifications/send', { method: 'POST', token: tokens.admin, key, body }), 201), sent[0]);
  assert.equal(await notification.notification.count({ where: { id: sent[0].notification.id } }), 0);
  assert.equal(await core.notification.count({ where: { recipientOwnerId: owner } }), 0);
  } finally { if (!exited) { child.kill(); await once(child, 'exit'); } }
});
test('manual send checks current Core staff/recipient and validation; failures create no dedup/effect', async () => {
  const base = { recipientOwnerId: owner, title: run, message: 'Validation fixture' };
  const send = (body, token = tokens.admin, key = randomUUID()) => request('/api/notifications/send', { method: 'POST', token, key, body });
  requireStatus(await send(base, tokens.owner), 403);
  requireStatus(await send({ ...base, recipientOwnerId: randomUUID() }), 404);
  requireStatus(await send({ ...base, recipientOwnerId: staff }), 404);
  requireStatus(await request('/api/notifications/send', { method: 'POST', token: tokens.admin, body: base }), 422);
  requireStatus(await send([]), 422); requireStatus(await send({ ...base, title: ' ' }), 422);
  const withdrawn = await core.user.create({ data: { role: 'admin', fullName: run, passwordHash: 'fixture', passwordSalt: 'fixture' } });
  const staleToken = signToken(withdrawn.id, 'admin'); await core.user.update({ where: { id: withdrawn.id }, data: { role: 'owner' } });
  const key = randomUUID(); requireStatus(await send(base, staleToken, key), 403);
  assert.equal(await notification.requestDedup.count({ where: { actorId: withdrawn.id, key } }), 0);
});
test('Core outage fails new manual send closed; cached response survives timeout/retry; DB fault rolls back dedup/effect', async () => {
  const key = randomUUID(), body = { recipientOwnerId: owner, title: run, message: 'Outage fixture' };
  const original = requireStatus(await request('/api/notifications/send', { method: 'POST', token: tokens.staff, key, body }), 201);
  await close(coreServer); coreServer = undefined;
  try {
    const newKey = randomUUID();
    requireStatus(await request('/api/notifications/send', { base: notificationUrl, method: 'POST', token: tokens.staff, key: newKey, body }), 503);
    assert.equal(await notification.requestDedup.count({ where: { actorId: staff, key: newKey } }), 0);
    assert.deepEqual(requireStatus(await request('/api/notifications/send', { base: notificationUrl, method: 'POST', token: tokens.staff, key, body }), 201), original);
  } finally { await startCore(); }
  const failedKey = randomUUID();
  const service = new ManualSend(notification, new CoreSendAuthorization(coreUrl, credential));
  await assert.rejects(service.send({ sub: staff, role: 'staff' }, tokens.staff, body, failedKey, () => { throw new Error('P2_TRANSACTION_FAULT'); }));
  assert.equal(await notification.requestDedup.count({ where: { actorId: staff, key: failedKey } }), 0);
  const retry = await service.send({ sub: staff, role: 'staff' }, tokens.staff, body, failedKey);
  assert.equal(retry.notification.sentByStaffId, staff);
});
test('Core appointment/Spa, lifecycle, medical, hotel, rescue, invoice and payment writers only emit atomic outbox', async () => {
  const startedAt = new Date();
  const a = requireStatus(await request('/api/appointments', { method: 'POST', body: { petId: pet.id, type: 'spa_bath', date, time: '10:00', serviceName: 'Fixture bath' } }), 201).appointment;
  let current = a;
  for (const status of ['confirmed','checked_in']) current = requireStatus(await request(`/api/appointments/${a.id}/status`, { method: 'PATCH', token: tokens.staff, body: { status, expectedRevision: current.statusRevision } }), 200).appointment;
  requireStatus(await request(`/api/appointments/${a.id}/reminder`, { method: 'POST', token: tokens.staff }), 201);
  requireStatus(await request('/api/medical-records', { method: 'POST', token: tokens.doctor, body: { petId: pet.id, appointmentId: a.id, title: 'Fixture follow-up', doctorName: 'Fixture doctor', visitDate: date, diagnosis: 'Synthetic diagnosis', treatment: 'Synthetic treatment', internalNote: 'P2_PRIVATE_MEDICAL_MARKER' } }), 201);
  const invoice = requireStatus(await request('/api/invoices', { method: 'POST', token: tokens.admin, body: { type: 'appointment', relatedId: a.id, subtotal: 100000 } }), 201).invoice;
  requireStatus(await request(`/api/invoices/${invoice.id}/pay`, { method: 'PATCH', token: tokens.admin, body: { paymentMethod: 'cash' } }), 200);
  const checkOut = new Date(Date.now() + 7 * 3600000 + 3 * 86400000).toISOString().slice(0, 10);
  requireStatus(await request('/api/hotel-bookings', { method: 'POST', key: randomUUID(), body: { petId: pet.id, checkIn: date, checkOut, roomType: 'standard', services: [] } }), 201);
  requireStatus(await request(`/api/public/pets/${pet.qrToken}/rescue-reports`, { method: 'POST', token: null, body: { finderPhone: '000-fixture', location: 'Synthetic location' } }), 201);
  // AQ-01: the same finder again (here 3 concurrent retries) is merged under the pet lock: one row, one owner notice; another finder is new.
  const merged = await Promise.all([1, 2, 3].map(() => request(`/api/public/pets/${pet.qrToken}/rescue-reports`, { method: 'POST', token: null, body: { finderPhone: '000-fixture', location: 'Synthetic retry' } })));
  for (const r of merged) assert.match(requireStatus(r, 201).message, /already received/);
  requireStatus(await request(`/api/public/pets/${pet.qrToken}/rescue-reports`, { method: 'POST', token: null, body: { finderPhone: '001-fixture', location: 'Synthetic location' } }), 201);
  assert.deepEqual((await core.rescueReport.groupBy({ by: ['finderPhone'], where: { petId: pet.id }, _count: true, orderBy: { finderPhone: 'asc' } })).map(g => [g.finderPhone, g._count]), [['000-fixture', 1], ['001-fixture', 1]]);
  assert.equal((await core.outboxEvent.findMany({ where: { envelope: { path: ['payload','type'], equals: 'pet_rescue_report' } } })).filter(e => e.envelope.payload.relatedPetId === pet.id).length, 2);
  // The duplicate check is atomic only because the pet row lock serializes reports: a second unit of work
  // cannot take the lock until the first commits, and then sees its report.
  { const rescue = createPublicRescueDependencies(core), order = []; let release; const gate = new Promise(resolve => { release = resolve; });
    const first = rescue.unitOfWork.run(async repo => { await repo.lockPet(pet.id); order.push('first-locked'); await gate; await repo.createReport({ petId: pet.id, finderPhone: '002-fixture', location: 'Lock fixture', finderName: null, note: null }); order.push('first-inserted'); });
    await new Promise(resolve => setTimeout(resolve, 100));
    const second = rescue.unitOfWork.run(async repo => { await repo.lockPet(pet.id); order.push('second-locked'); return repo.hasRecentReport(pet.id, '002-fixture', new Date(Date.now() - 60000)); });
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.deepEqual(order, ['first-locked'], 'a concurrent report waits for the pet lock');
    release(); await first;
    assert.equal(await second, true, 'after the lock it sees the first report');
    assert.deepEqual(order, ['first-locked', 'first-inserted', 'second-locked']); }
  const extra = await core.invoice.create({ data: { invoiceCode: 'P2-' + randomUUID(), type: 'appointment', ownerId: owner, petId: pet.id, subtotal: 100000, totalAmount: 100000, paymentChannel: 'bank_transfer' } });
  const invoices = new PrismaInvoiceRepository(core);
  await invoices.reportTransfer(extra.id, owner, 'fixture-reference', { sub: owner, role: 'owner' });
  await invoices.rejectTransfer(extra.id, 'fixture-reason', { sub: admin, role: 'admin' });
  const online = await core.invoice.create({ data: { invoiceCode: 'P2-' + randomUUID(), type: 'appointment', ownerId: owner, petId: pet.id, subtotal: 100000, totalAmount: 100000, paymentChannel: 'online' } });
  const attempt = await core.paymentAttempt.create({ data: { id: randomUUID().replaceAll('-', ''), invoiceId: online.id, amount: 100000, expiresAt: new Date(Date.now() + 60000) } });
  assert.equal((await new PrismaPaymentRepository(core).confirm({ reference: attempt.id, amount: 100000, success: true, transactionNo: randomUUID(), responseCode: '00' })).RspCode, '00');
  const conflict = await core.invoice.create({ data: { invoiceCode: 'P2-' + randomUUID(), type: 'appointment', ownerId: owner, petId: pet.id, subtotal: 100000, totalAmount: 100000, paymentStatus: 'paid', paymentMethod: 'cash' } });
  const review = await core.paymentAttempt.create({ data: { id: randomUUID().replaceAll('-', ''), invoiceId: conflict.id, amount: 100000, expiresAt: new Date(Date.now() + 60000) } });
  assert.equal((await new PrismaPaymentRepository(core).confirm({ reference: review.id, amount: 100000, success: true, transactionNo: randomUUID(), responseCode: '00' })).RspCode, '00');
  const rows = await core.outboxEvent.findMany({ where: { envelope: { path: ['payload','relatedPetId'], equals: pet.id } } });
  assert.ok(rows.length >= 6);
  const all = await core.outboxEvent.findMany({ where: { createdAt: { gte: startedAt } } });
  for (const type of ['appointment_created','appointment_reminder','booking_status_updated','medical_record_updated','hotel_booking_created','pet_rescue_report','invoice_paid','transfer_reported','transfer_rejected','payment_review']) assert.ok(all.some(e => e.envelope.payload.type === type), `writer ${type}`);
  assert.ok(all.every(e => !JSON.stringify(e.envelope).includes('P2_PRIVATE_MEDICAL_MARKER')));
  assert.equal(await core.notification.count({ where: { recipientOwnerId: owner } }), 0);
});
test('real DB failure of outbox insert rolls back the domain write without leaking raw ORM payload', async () => {
  const failedPet = await core.pet.create({ data: { ownerId: owner, name: 'Rollback fixture', species: 'cat', allergies: [] } });
  const name = 'p2_reject_' + run.replaceAll('-', '');
  await core.$executeRawUnsafe(`ALTER TABLE "OutboxEvent" ADD CONSTRAINT "${name}" CHECK (envelope->'payload'->>'relatedPetId' IS DISTINCT FROM '${failedPet.id}') NOT VALID`);
  try {
    const failed = await request('/api/appointments', { method: 'POST', body: { petId: failedPet.id, type: 'general_checkup', date, time: '12:00', serviceName: 'Rollback fixture' } });
    requireStatus(failed, 503); assert.ok(!JSON.stringify(failed.body).includes('INSERT'));
    assert.equal(await core.appointment.count({ where: { petId: failedPet.id } }), 0);
    assert.equal(await core.outboxEvent.count({ where: { envelope: { path: ['payload','relatedPetId'], equals: failedPet.id } } }), 0);
  } finally { await core.$executeRawUnsafe(`ALTER TABLE "OutboxEvent" DROP CONSTRAINT "${name}"`); }
});
test('AQ-05 real password change through the API revokes the previous session; a new login works', async () => {
  const id = randomUUID(), email = `${id}@example.invalid`;
  await core.user.create({ data: { id, role: 'owner', fullName: `AQ-05 ${run}`, email, ...await hashPasswordAsync('P2-fixture-password-only!') } });
  const login = password => request('/api/auth/owner/login', { method: 'POST', token: null, body: { email, password } });
  const first = requireStatus(await login('P2-fixture-password-only!'), 200).token;
  requireStatus(await request('/api/pets', { token: first }), 200);
  await new Promise(r => setTimeout(r, 1100)); // change lands in a later second than the token's iat
  const changed = await request('/api/auth/me/password', { method: 'POST', token: first, body: { currentPassword: 'P2-fixture-password-only!', newPassword: 'AQ05-new-password!', confirmPassword: 'AQ05-new-password!' } });
  assert.equal(changed.status, 204);
  const revoked = await request('/api/pets', { token: first });
  assert.equal(revoked.status, 401); assert.match(revoked.body.error, /password was changed/i);
  requireStatus(await login('P2-fixture-password-only!'), 401);
  const second = requireStatus(await login('AQ05-new-password!'), 200).token;
  requireStatus(await request('/api/pets', { token: second }), 200);
  const changedAt = (await core.user.findUniqueOrThrow({ where: { id } })).passwordChangedAt;
  assert.ok(changedAt);
  // The same transaction wrote identity.sessions-revoked.v1 for the other services (trigger).
  const revocation = await core.outboxEvent.findFirstOrThrow({ where: { AND: [{ envelope: { path: ['eventType'], equals: 'identity.sessions-revoked.v1' } }, { envelope: { path: ['aggregateId'], equals: id } }] } });
  assert.deepEqual(revocation.envelope.payload, { userId: id, revokedBefore: changedAt.toISOString() });
  assert.equal(revocation.envelope.aggregateVersion, Math.floor(changedAt.getTime() / 1000));
  aq05 = { id, first, second };
});
test('AQ-10 hotel stays: API 409 plus a database exclusion constraint for writers that bypass the service', async () => {
  const stayPet = await core.pet.create({ data: { ownerId: owner, name: 'AQ-10 stay pet', species: 'dog', allergies: [] } });
  const day = n => new Date(Date.now() + 7 * 3600000 + n * 86400000).toISOString().slice(0, 10);
  const body = (from, to) => ({ petId: stayPet.id, checkIn: day(from), checkOut: day(to), roomType: 'standard', services: [] });
  requireStatus(await request('/api/hotel-bookings', { method: 'POST', key: randomUUID(), body: body(10, 13) }), 201);
  requireStatus(await request('/api/hotel-bookings', { method: 'POST', key: randomUUID(), body: body(12, 14) }), 409);
  const row = (from, to, status = 'pending') => ({ petId: stayPet.id, ownerId: owner, checkIn: new Date(day(from)), checkOut: new Date(day(to)), nights: to - from, roomType: 'standard', serviceKeys: [], totalAmount: 1, status });
  // Direct writes bypass the pet lock and interval check: the constraint still rejects overlaps.
  await assert.rejects(core.hotelBooking.create({ data: row(11, 12) }), /hotel_bookings_pet_active_stay_excl|23P01/);
  await core.hotelBooking.create({ data: row(13, 15) }); // half-open: check-out day can be the next check-in
  const cancelled = await core.hotelBooking.create({ data: row(10, 13, 'cancelled') });
  await assert.rejects(core.hotelBooking.update({ where: { id: cancelled.id }, data: { status: 'confirmed' } }), /hotel_bookings_pet_active_stay_excl|23P01/);
  await core.hotelBooking.create({ data: { ...row(10, 13), petId: pet.id } }); // another pet is independent
});
test('AQ-10 capacity: the database refuses the booking beyond rooms per type and night, under concurrency too', async () => {
  // Far-future vip nights, unique per run, so earlier runs never share them.
  const base = 3650 + Math.floor(Math.random() * 3000), day = n => new Date(Date.now() + 7 * 3600000 + (base + n) * 86400000).toISOString().slice(0, 10);
  const pets = await Promise.all([1, 2, 3, 4, 5, 6].map(i => core.pet.create({ data: { ownerId: owner, name: 'AQ-10 capacity pet ' + i, species: 'cat', allergies: [] } })));
  const body = (p, from, to) => ({ petId: p.id, checkIn: day(from), checkOut: day(to), roomType: 'vip', services: [] });
  const nights = async () => Object.fromEntries((await core.hotelRoomNight.findMany({ where: { roomType: 'vip', night: { gte: new Date(day(0)), lt: new Date(day(6)) } }, orderBy: { night: 'asc' } })).map(n => [n.night.toISOString().slice(0, 10), n.booked]));
  const created = [];
  try {
    for (const role of ['staff', 'doctor']) assert.match(requireStatus(await request('/api/hotel-capacity/vip', { method: 'PUT', token: tokens[role], body: { capacity: 1 } }), 403).error, /quản trị viên/);
    assert.equal(requireStatus(await request('/api/hotel-capacity/vip', { method: 'PUT', token: tokens.admin, body: { capacity: 1 } }), 200).capacity.capacity, 1);
    assert.deepEqual(requireStatus(await request('/api/hotel-capacity', { token: tokens.staff }), 200).items.map(i => i.roomType).sort(), ['deluxe', 'standard', 'vip']);
    created.push(requireStatus(await request('/api/hotel-bookings', { method: 'POST', key: randomUUID(), body: body(pets[0], 0, 3) }), 201).booking);
    assert.match(requireStatus(await request('/api/hotel-bookings', { method: 'POST', key: randomUUID(), body: body(pets[1], 2, 4) }), 409).error, /hết chỗ/);
    created.push(requireStatus(await request('/api/hotel-bookings', { method: 'POST', key: randomUUID(), body: body(pets[1], 3, 5) }), 201).booking); // half-open: check-out night is free
    assert.deepEqual(await nights(), { [day(0)]: 1, [day(1)]: 1, [day(2)]: 1, [day(3)]: 1, [day(4)]: 1 });
    assert.match(requireStatus(await request('/api/hotel-capacity/vip', { method: 'PUT', token: tokens.admin, body: { capacity: 0 } }), 409).error, /đã đặt/);
    // Cancelling frees the nights; reopening a stay (admin undo) needs a free room again.
    const first = created[0];
    const cancelled = requireStatus(await request(`/api/hotel-bookings/${first.id}/cancel`, { method: 'PATCH', token: tokens.admin, body: { expectedRevision: first.statusRevision } }), 200).booking;
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(await nights(), { [day(0)]: 0, [day(1)]: 0, [day(2)]: 0, [day(3)]: 1, [day(4)]: 1 });
    // Five writers race for the one free night; the row lock + CHECK let exactly one in.
    const race = await Promise.all(pets.slice(2, 6).concat(pets[0]).map(p => request('/api/hotel-bookings', { method: 'POST', key: randomUUID(), body: body(p, 1, 2) })));
    assert.deepEqual(race.map(r => r.status).sort(), [201, 409, 409, 409, 409]);
    created.push(...race.filter(r => r.status === 201).map(r => r.body.booking));
    // A writer that bypasses the service (direct insert) is refused by the same CHECK.
    await assert.rejects(core.hotelBooking.create({ data: { petId: pets[1].id, ownerId: owner, checkIn: new Date(day(1)), checkOut: new Date(day(2)), nights: 1, roomType: 'vip', serviceKeys: [], totalAmount: 1 } }), /hotel_room_nights_capacity_check/);
    // The counters always equal the active stays they summarize.
    const [drift] = await core.$queryRaw`SELECT count(*)::int AS n FROM hotel_room_nights n WHERE n.booked <> (SELECT count(*) FROM hotel_bookings b WHERE b.room_type = n.room_type AND b.status IN ('pending','confirmed','in_stay') AND b.check_in <= n.night AND b.check_out > n.night)`;
    assert.equal(drift.n, 0);
  } finally {
    await core.hotelBooking.deleteMany({ where: { petId: { in: pets.map(p => p.id) } } });
    await core.$executeRaw`UPDATE hotel_room_capacity SET capacity = 1000`; await core.$executeRaw`UPDATE hotel_room_nights SET capacity = 1000`;
  }
});
test('AQ-10 pending expiry: an unconfirmed stay past 48 h or noon of its check-in day is cancelled by the system and frees its nights', async () => {
  const store = new PrismaHotelPendingExpiryStore(core), now = new Date(), hour = 3600000;
  const date = ms => new Date(new Date(ms).toISOString().slice(0, 10) + 'T00:00:00.000Z');
  const pets = await Promise.all([1, 2, 3, 4].map(i => core.pet.create({ data: { ownerId: owner, name: 'AQ-10 expiry pet ' + i, species: 'dog', allergies: [] } })));
  const far = 4000 * 86400000 + Math.floor(Math.random() * 1000) * 86400000;
  const row = (pet, checkIn, createdAt, status = 'pending') => core.hotelBooking.create({ data: { petId: pet.id, ownerId: owner, checkIn, checkOut: new Date(checkIn.getTime() + 2 * 86400000), nights: 2, roomType: 'deluxe', serviceKeys: [], totalAmount: 1, status, createdAt } });
  const old = await row(pets[0], date(now.getTime() + far), new Date(now.getTime() - 49 * hour));
  const today = await row(pets[1], date(now.getTime() - 86400000), now); // check-in already passed its noon
  const fresh = await row(pets[2], date(now.getTime() + far + 10 * 86400000), now);
  const confirmed = await row(pets[3], date(now.getTime() + far + 20 * 86400000), new Date(now.getTime() - 72 * hour), 'confirmed');
  const booked = async b => (await core.hotelRoomNight.findMany({ where: { roomType: 'deluxe', night: { gte: b.checkIn, lt: b.checkOut } } })).map(n => n.booked);
  try {
    const before = await booked(old);
    const due = await store.duePending(expiryBounds(now), 100000);
    assert.ok(due.includes(old.id) && due.includes(today.id), 'both expired stays are due');
    assert.ok(!due.includes(fresh.id) && !due.includes(confirmed.id), 'a fresh or confirmed stay is not');
    assert.equal(await store.expire(old.id, now), true);
    assert.equal(await store.expire(old.id, now), false, 'expiring twice changes nothing');
    assert.equal(await store.expire(fresh.id, now), false);
    assert.equal(await store.expire(confirmed.id, now), false);
    assert.equal(await store.expire(today.id, now), true);
    const after = await core.hotelBooking.findUniqueOrThrow({ where: { id: old.id } });
    assert.equal(after.status, 'cancelled'); assert.equal(after.statusRevision, old.statusRevision + 1);
    assert.deepEqual((await booked(old)).map((n, i) => before[i] - n), [1, 1], 'its two nights are freed');
    const event = await core.bookingStatusEvent.findFirstOrThrow({ where: { kind: 'hotel', bookingId: old.id } });
    assert.deepEqual([event.action, event.fromStatus, event.toStatus, event.actorRole, event.revision], ['expired', 'pending', 'cancelled', 'system', after.statusRevision]);
    const notice = (await core.outboxEvent.findMany({ where: { envelope: { path: ['payload', 'relatedBookingId'], equals: old.id } } }))[0];
    assert.equal(notice?.envelope.payload.recipientOwnerId, owner);
    assert.equal((await core.hotelBooking.findUniqueOrThrow({ where: { id: fresh.id } })).status, 'pending');
    assert.equal((await core.hotelBooking.findUniqueOrThrow({ where: { id: confirmed.id } })).status, 'confirmed');
  } finally {
    await core.hotelBooking.deleteMany({ where: { petId: { in: pets.map(p => p.id) } } });
  }
});
test('AQ-07: real responses through Core match the public OpenAPI contract the frontend types are generated from', async () => {
  const spec = JSON.parse(readSpec(new URL('../../backend/openapi.json', import.meta.url), 'utf8'));
  const reads = { owner: ['/api/auth/me', '/api/pets?pageSize=100', '/api/appointments?pageSize=100', '/api/hotel-bookings', '/api/medical-records?pageSize=100', '/api/invoices', '/api/notifications?pageSize=100', '/api/bootstrap'],
    admin: ['/api/auth/me', '/api/pets?pageSize=100', '/api/owners?pageSize=100', '/api/appointments?pageSize=100', '/api/hotel-bookings', '/api/medical-records?pageSize=100', '/api/invoices', '/api/notifications?pageSize=100', '/api/bootstrap?view=dashboard', '/api/hotel-care-notes', '/api/hotel-capacity'] };
  const problems = [], checked = {};
  for (const [role, paths] of Object.entries(reads)) for (const path of paths) {
    const body = requireStatus(await request(path, { token: tokens[role] }), 200);
    const found = validate(spec, responseSchema(spec, 'GET', path, 200), body, role + ' GET ' + path);
    problems.push(...found);
    for (const key of ['items', 'pets', 'appointments', 'medicalRecords', 'notifications', 'invoices', 'hotelBookings']) if (Array.isArray(body[key])) checked[key] = (checked[key] ?? 0) + body[key].length;
  }
  assert.deepEqual(problems.slice(0, 30), [], problems.length + ' contract problems');
  for (const key of ['items', 'appointments']) assert.ok(checked[key] > 0, 'the check saw real ' + key);
});
test('legacy export/dry-run/import/verify preserve IDs/status/timestamps; resume and deleted/read rows never regress', async () => {
  const source = [];
  for (const status of ['sent','read']) source.push(await core.notification.create({ data: { recipientOwnerId: owner, recipientRole: 'owner', type: 'general', title: run, message: 'Historical fixture', status, actionUrl: '/owner/notifications', relatedPetId: pet.id, sentByStaffId: staff, createdAt: new Date('2024-02-03T04:05:06.007Z'), sentAt: new Date('2024-02-03T04:05:07.008Z') } }));
  const snapshot = await exportNotifications(core, source.map(r => r.id));
  assert.equal((await inspectImport(notification, snapshot)).pending, 2);
  await assert.rejects(importNotifications(notification, snapshot, row => { if (row.id === snapshot.rows[1].id) throw new Error('IMPORT_TRANSACTION_FAULT'); }));
  assert.equal((await inspectImport(notification, snapshot)).pending, 1);
  assert.equal((await importNotifications(notification, snapshot)).imported, 1);
  assert.equal((await verifyImport(notification, snapshot)).exact, 2);
  await notification.notification.update({ where: { id: source[0].id }, data: { status: 'read' } });
  await notification.notification.delete({ where: { id: source[1].id } });
  assert.equal((await importNotifications(notification, snapshot)).replayed, 2);
  const verified = await verifyImport(notification, snapshot); assert.equal(verified.readAdvanced, 1); assert.equal(verified.deletedAfterImport, 1);
  await assert.rejects(importNotifications(notification, { ...snapshot, rows: snapshot.rows.map(r => ({ ...r, message: 'tampered' })) }), /CHECKSUM/);
  const collision = { ...snapshot, rows: [{ ...snapshot.rows[0], id: randomUUID() }] }; delete collision.sha256; collision.sha256 = createHash('sha256').update(JSON.stringify(collision)).digest('hex');
  await notification.notification.create({ data: { id: collision.rows[0].id, recipientOwnerId: owner, title: 'Collision fixture', message: 'Retain target' } });
  await assert.rejects(importNotifications(notification, collision), /TARGET_ID_COLLISION/);
  mkdirSync('test-results/phase2', { recursive: true });
  const file = `test-results/phase2/${run}.notifications.json`;
  for (const command of ['export','dry-run','import','verify']) execFileSync(process.execPath, ['tools/phase2/migrate-notifications.mjs',command,file], { env: process.env, stdio: 'pipe' });
  writeFileSync(`test-results/phase2/${run}.migration-summary.json`, JSON.stringify(verified, null, 2), { flag: 'wx' });
});
test('broker/consumer outage cannot roll back committed Core HTTP write; manual send does not wait broker; both producer stores catch up', { timeout: 60000 }, async () => {
  const clinicId = randomUUID(), clinicEventId = await clinic.$transaction(async tx => {
    await tx.proofAppointment.create({ data: { id: clinicId, ownerId: owner, petId: randomUUID(), date, time: '16:00', type: 'examination', status: 'completed' } });
    return clinicNotification(tx, { recipientOwnerId: owner, title: run, message: 'Clinic proof transaction', type: 'appointment_reminder' });
  });
  const rollbackAppointment = randomUUID();
  await assert.rejects(clinic.$transaction(async tx => {
    await tx.proofAppointment.create({ data: { id: rollbackAppointment, ownerId: owner, petId: randomUUID(), date, time: '16:30', type: 'examination', status: 'completed' } });
    await clinicNotification(tx, { recipientOwnerId: owner, title: run, message: 'Rollback clinic' }); throw new Error('CLINIC_TRANSACTION_FAULT');
  }));
  assert.equal(await clinic.proofAppointment.count({ where: { id: rollbackAppointment } }), 0);
  assert.equal(await clinic.outboxEvent.count({ where: { envelope: { path: ['payload','message'], equals: 'Rollback clinic' } } }), 0);
  await channel.close(); await connection.close(); channel = undefined; connection = undefined;
  docker('stop','rabbitmq'); stoppedBroker = true;
  const a = requireStatus(await request('/api/appointments', { method: 'POST', body: { petId: pet.id, type: 'general_checkup', date, time: '17:00', serviceName: 'Broker outage fixture' } }), 201).appointment;
  assert.ok(await core.appointment.findUnique({ where: { id: a.id } }));
  const pending = await core.outboxEvent.findFirstOrThrow({ where: { envelope: { path: ['payload','relatedAppointmentId'], equals: a.id } } }); assert.equal(pending.publishedAt, null);
  const outagePet = await core.pet.create({ data: { ownerId: owner, name: 'Broker outage hotel pet', species: 'cat', allergies: [] } });
  const checkOut = new Date(Date.now() + 7 * 3600000 + 3 * 86400000).toISOString().slice(0,10);
  const hotel = requireStatus(await request('/api/hotel-bookings', { method: 'POST', key: randomUUID(), body: { petId: outagePet.id, checkIn: date, checkOut, roomType: 'standard', services: [] } }), 201).booking;
  assert.ok(await core.hotelBooking.findUnique({ where: { id: hotel.id } }));
  const cash = await core.invoice.create({ data: { invoiceCode: 'P2-' + randomUUID(), type: 'appointment', ownerId: owner, petId: outagePet.id, subtotal: 100000, totalAmount: 100000 } });
  const paid = requireStatus(await request(`/api/invoices/${cash.id}/pay`, { method: 'PATCH', token: tokens.admin, body: { paymentMethod: 'cash' } }), 200);
  assert.equal(paid.invoice.paymentStatus, 'paid');
  const extraEvents = await core.outboxEvent.findMany({ where: { OR: [
    { envelope: { path: ['payload','relatedBookingId'], equals: hotel.id } },
    { envelope: { path: ['payload','message'], string_contains: cash.invoiceCode } },
  ] } });
  assert.ok(extraEvents.length >= 2); assert.ok(extraEvents.every(row => row.publishedAt === null));
  const manual = requireStatus(await request('/api/notifications/send', { method: 'POST', token: tokens.staff, key: randomUUID(), body: { recipientOwnerId: owner, title: run, message: 'No broker needed' } }), 201);
  assert.ok(await notification.notification.findUnique({ where: { id: manual.notification.id } }));
  docker('up','-d','--wait','rabbitmq'); stoppedBroker = false;
  connection = await brokerConnection(); channel = await connection.createConfirmChannel(); channel.on('error', () => {});
  await declareTopology(broker, routes);
  const env = { BROKER_URL: broker, BROKER_PREFIX: `p2.runtime.${run}` };
  const runtime = await startWorker('backend/dist/src/phase2/notificationWorker.js', { ...env, DATABASE_URL: urls.core, OUTBOX_CREATED_AFTER: runStartedAt });
  // Consumer starts later: broker accepts a durable backlog without rolling back Core.
  await until(async () => (await core.outboxEvent.findUnique({ where: { id: pending.id } })).publishedAt, 'Core outbox confirm');
  assert.ok((await channel.checkQueue(routes.notification)).messageCount > 0);
  const consumer = await startWorker('services/notification/dist/worker.js', { ...env, DATABASE_URL: urls.notification });
  const directoryConsumer = await startWorker('services/clinic/dist/worker.js', { ...env, DATABASE_URL: urls.clinic, CORE_SERVICE_URL:'',CLINIC_PROOF_ONLY:'1' });
  await new ClinicRelay(clinic, broker, clinicEventId).once(run, routes);
  await until(() => notification.notification.findUnique({ where: { id: pending.envelope.payload.notificationId } }), 'Core domain notification catch-up', 20000);
  await until(() => notification.notification.findUnique({ where: { id: clinicEventId } }), 'Clinic transactional notification catch-up');
  for (const row of extraEvents) await until(() => notification.notification.findUnique({ where: { id: row.envelope.payload.notificationId } }), 'hotel/payment notification catch-up');
  // AQ-05 residual closed: the earlier password change reached Notification through the same relay;
  // its old session is refused there directly and through the Core gateway, the new one is not.
  assert.ok(aq05, 'AQ-05 test ran first');
  await until(() => notification.sessionRevocation.findUnique({ where: { userId: aq05.id } }), 'session revocation catch-up');
  // Direct (nginx split routes /api/notifications straight to Notification): Notification's own check.
  const direct = await request('/api/notifications', { token: aq05.first, base: notificationUrl });
  assert.equal(direct.status, 401); assert.equal(direct.body.code, 'SESSION_REVOKED');
  // Through the Core gateway, Core's currentAccount already refuses it before proxying.
  const gateway = await request('/api/notifications', { token: aq05.first, base: coreUrl });
  assert.equal(gateway.status, 401); assert.match(gateway.body.error, /password was changed/i);
  for (const base of [notificationUrl, coreUrl]) requireStatus(await request('/api/notifications', { token: aq05.second, base }), 200);
  await runtime.stop(); await waitForQueueIdle([routes.notification,routes.clinic]); await directoryConsumer.stop(); await consumer.stop();
  assert.ok(workers.every(w => !/fixture_only|postgresql:|amqp:\/\//.test(w.logs())), 'No credential URLs in worker logs');
  if (olderPending) assert.equal((await core.outboxEvent.findUnique({ where: { id: olderPending.id } })).publishedAt, null, 'rows older than the run stay unpublished');
});
test('Core worker refuses the created-after test scope outside the guarded project or with a malformed instant', async () => {
  for (const env of [{ OUTBOX_CREATED_AFTER: new Date().toISOString(), PHASE2_TEST_CONFIRM: '' }, { OUTBOX_CREATED_AFTER: 'yesterday' }]) {
    const baseEnv = { ...process.env, BROKER_URL: broker, BROKER_PREFIX: `p2.runtime.${run}`, DATABASE_URL: urls.core, ...env }; delete baseEnv.JWT_PRIVATE_KEY; delete baseEnv.JWT_SECRET;
    const child = spawn(process.execPath, ['backend/dist/src/phase2/notificationWorker.js'], { env: baseEnv, stdio: 'pipe' });
    let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const timer = setTimeout(() => child.kill(), 10000);
    const [code] = await once(child, 'exit'); clearTimeout(timer);
    // Same env with the guard and a valid instant reaches worker-ready in the catch-up test.
    assert.notEqual(code, 0); assert.ok(!output.includes('worker-ready')); assert.ok(output.includes('WORKER_START_FAILED'), output.slice(0, 400));
  }
});
