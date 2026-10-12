import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient as CoreClient } from '../../backend/src/generated/phase2-core/index.js';
import { PrismaClient as ClinicClient } from '../../services/clinic/src/generated/client/index.js';
import { PrismaClient as NotificationClient } from '../../services/notification/src/generated/client/index.js';
import { CoreBilling } from '../../backend/src/phase2/billing.ts';
import { OutboxRelay } from '../../backend/src/phase2/relay.ts';
import { ClinicBilling } from '../../services/clinic/src/billing.ts';
import { NotificationInbox } from '../../services/notification/src/inbox.ts';
import amqp from 'amqplib';
import { declareTopology, topology, publishConfirmed, consumeEvents, replayEvent } from '@nipopeto/messaging';
import { ClinicInbox } from '../../services/clinic/src/inbox.ts';
import { OutboxRelay as ClinicRelay } from '../../services/clinic/src/relay.ts';
assert.equal(process.env.PHASE2_TEST_CONFIRM, 'pet-phase2-p1-test', 'Use phase2:test:integration; direct execution refused');
const urls = Object.fromEntries(['core', 'clinic', 'notification'].map(s => [s, `postgresql://p2_${s}:p2_${s}_fixture_only@127.0.0.1:55432/p2_${s}_test?schema=p1_proof`]));
const clients = { core: new CoreClient({ datasourceUrl: urls.core }), clinic: new ClinicClient({ datasourceUrl: urls.clinic }), notification: new NotificationClient({ datasourceUrl: urls.notification }) };
const broker = 'amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679';
const run = randomUUID();
const core = new CoreBilling(clients.core), clinic = new ClinicBilling(clients.clinic), inbox = new NotificationInbox(clients.notification);
let connection, channel;
const queue = `p2.proof.${run}`;
const extraQueues = new Set(), extraExchanges = new Set();
test.before(async () => {
  for (const [s, db] of Object.entries(clients)) {
    const identity = await db.$queryRaw`SELECT current_database() AS db, current_user AS role`;
    assert.equal(identity[0].db, `p2_${s}_test`); assert.equal(identity[0].role, `p2_${s}`);
    const marker = await db.$queryRaw`SELECT marker FROM public.p2_test_marker`;
    assert.equal(marker[0].marker, `pet-phase2-p1-test:${s}:v1`);
  }
  for (const s of ['core', 'clinic', 'notification']) {
    const path = s === 'core' ? 'backend/prisma/phase2/schema.prisma' : `services/${s}/prisma/schema.prisma`;
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', path], { env: { ...process.env, DATABASE_URL: urls[s] }, stdio: 'pipe' });
  }
  connection = await connectBroker(); connection.on('error', () => {}); channel = await connection.createConfirmChannel(); channel.on('error', () => {});
  await channel.assertQueue(queue, { durable: true });
});
test.after(async () => {
  const retained = [];
  try {
    if (channel) {
      for (const q of [...extraQueues, queue]) {
        const state = await channel.checkQueue(q);
        if (state.messageCount) retained.push(q); else await channel.deleteQueue(q);
      }
      if (!retained.length) for (const e of extraExchanges) await channel.deleteExchange(e);
    }
  } finally {
    await channel?.close().catch(() => {}); await connection?.close().catch(() => {});
    await Promise.all(Object.values(clients).map(db => db.$disconnect()));
  }
  assert.deepEqual(retained, [], 'Retain nonempty proof queues; investigate delivery failure');
});
const appointment = () => clients.clinic.proofAppointment.create({ data: { id: randomUUID(), ownerId: run, petId: randomUUID(), date: '2026-10-12', time: '09:00', type: 'examination', status: 'completed' } });
const begin = a => core.begin({ actorId: run, idempotencyKey: randomUUID(), appointmentId: a.id, expectedRevision: 1, amount: 100000 });
async function contend(db, first, second) {
  let ready, release;
  const locked = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const winner = first(async () => { ready(); await gate; });
  await locked;
  const loser = second();
  // Observe an actual PostgreSQL lock wait, not timing luck or a fake port.
  let waiting = false;
  try {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const rows = await db.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = current_user AND wait_event_type = 'Lock'`;
      if (rows[0].n > 0) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { release(); }
  const results = await Promise.allSettled([winner, loser]);
  assert.ok(waiting, 'Second transaction must really wait on PostgreSQL lock');
  return results;
}
test('DB role cannot connect to another service database', async () => {
  for (const source of Object.keys(urls)) for (const target of Object.keys(urls).filter(s => s !== source)) {
    const forbidden = new CoreClient({ datasourceUrl: urls[source].replace(`p2_${source}_test`, `p2_${target}_test`) });
    try { await assert.rejects(forbidden.$queryRaw`SELECT 1`); } finally { await forbidden.$disconnect(); }
  }
});
test('Clinic and Notification built runtimes start independently with their own DB', async () => {
  for (const [service, port] of [['clinic', 55101], ['notification', 55102]]) {
    const child = spawn(process.execPath, [`services/${service}/dist/index.js`], { env: { ...process.env, DATABASE_URL: urls[service], PORT: String(port) }, stdio: 'pipe' });
    let exited = false; child.once('exit', () => { exited = true; });
    try {
      let response;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !exited) {
        try { response = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(1000) }); if (response.ok) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(response?.ok, `${service} readiness`); assert.equal((await response.json()).service, service);
    } finally { child.kill(); await new Promise(resolve => { if (exited) resolve(); else child.once('exit', resolve); }); }
  }
});
test('real PostgreSQL partial slot uniqueness applies across examination/Spa', async () => {
  const petId = randomUUID();
  const create = type => clients.clinic.proofAppointment.create({ data: { id: randomUUID(), ownerId: run, petId, date: '2026-10-12', time: '10:00', type, status: 'confirmed' } });
  const results = await Promise.allSettled([create('examination'), create('spa_bath')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'P2002');
});
test('barriers prove both prepare/undo and commit/abort winners under real row contention', async () => {
  for (const first of ['prepare', 'undo']) {
    const a = await appointment(), op = await begin(a);
    const prepare = hook => clinic.prepare(op.id, a.id, 1, hook), undo = hook => clinic.undo(a.id, 1, hook);
    const result = await contend(clients.clinic, first === 'prepare' ? prepare : undo, first === 'prepare' ? undo : prepare);
    assert.equal(result[0].status, 'fulfilled'); assert.equal(result[1].status, 'rejected');
    await core.terminal(op.id, 'abort');
    if (first === 'prepare') await clinic.reconcile(op.id, { state: 'ABORTED' });
  }
  for (const first of ['commit', 'abort']) {
    const a = await appointment(), op = await begin(a), snapshot = await clinic.prepare(op.id, a.id, 1);
    const result = await contend(clients.core, hook => core.terminal(op.id, first, snapshot, undefined, hook), () => core.terminal(op.id, first === 'commit' ? 'abort' : 'commit', snapshot));
    const state = first === 'commit' ? 'COMMITTED' : 'ABORTED';
    assert.ok(result.every(r => r.status === 'fulfilled' && r.value.operation.state === state));
    const invoice = result[0].value.invoice;
    await clinic.reconcile(op.id, { state, invoiceId: invoice?.id });
    assert.equal(Boolean(invoice), state === 'COMMITTED');
  }
});
test('prepare vs undo; commit vs abort with independent DB connections', async () => {
  for (let i = 0; i < 12; i++) {
    const a = await appointment(), op = await begin(a);
    const race = await Promise.allSettled([clinic.prepare(op.id, a.id, 1), clinic.undo(a.id, 1)]);
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
    if (race[0].status === 'fulfilled') {
      const snapshot = race[0].value;
      const ordered = i % 2 ? ['abort', 'commit'] : ['commit', 'abort'];
      const outcomes = await Promise.all(ordered.map(action => core.terminal(op.id, action, snapshot)));
      assert.equal(outcomes[0].operation.state, outcomes[1].operation.state);
      const result = outcomes[0];
      await clinic.reconcile(op.id, { state: result.operation.state, invoiceId: result.invoice?.id });
      const invoice = await clients.core.proofInvoice.findUnique({ where: { operationId: op.id } });
      assert.equal(Boolean(invoice), result.operation.state === 'COMMITTED');
      if (result.operation.state === 'COMMITTED') await assert.rejects(clinic.undo(a.id, 1));
      else { assert.equal((await core.terminal(op.id, 'commit', snapshot)).operation.state, 'ABORTED'); await clinic.undo(a.id, 1); }
    } else { await core.terminal(op.id, 'abort'); assert.equal((await clients.clinic.proofAppointment.findUnique({ where: { id: a.id } })).status, 'confirmed'); }
  }
});
test('idempotency hash guard; HELD survives pending; late prepare after abort reconciles', async () => {
  const a = await appointment(), key = randomUUID();
  const input = { actorId: run, idempotencyKey: key, appointmentId: a.id, expectedRevision: 1, amount: 100000 };
  const barrier=await clients.core.$transaction(async tx=>{
    await tx.$executeRaw`LOCK TABLE "BillingOperation" IN SHARE MODE`;
    const requests=[core.begin(input),core.begin(input)];
    await until(async()=>{const [state]=await clients.core.$queryRaw`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock' AND query LIKE '%INSERT INTO "BillingOperation"%'`;return state.n>=2;},'both Core idempotency inserts waiting',2000);
    return{requests};
  });
  const [one,two]=await Promise.all(barrier.requests);assert.equal(one.id,two.id);
  await assert.rejects(core.begin({...input,idempotencyKey:randomUUID()}),/SOURCE_BUSY/);
  await assert.rejects(core.begin({ ...input, amount: 2 }));
  await core.terminal(one.id, 'abort');
  const snapshot = await clinic.prepare(one.id, a.id, 1);
  await clinic.reconcile(one.id, { state: 'PREPARING' }); await assert.rejects(clinic.undo(a.id, 1));
  assert.equal((await core.terminal(one.id, 'commit', snapshot)).operation.state, 'ABORTED');
  await clinic.reconcile(one.id, { state: 'ABORTED' }); await clinic.undo(a.id, 1);
  await assert.rejects(clinic.prepare(one.id, a.id, 1));
});
test('invoice and outbox rollback together at injected fault; retry returns same invoice', async () => {
  const a = await appointment(), op = await begin(a), snapshot = await clinic.prepare(op.id, a.id, 1);
  await assert.rejects(core.terminal(op.id, 'commit', snapshot, () => { throw new Error('TEST_CRASH'); }));
  assert.equal(await clients.core.proofInvoice.count({ where: { operationId: op.id } }), 0);
  assert.equal((await clients.core.billingOperation.findUnique({ where: { id: op.id } })).state, 'PREPARING');
  const first = await core.terminal(op.id, 'commit', snapshot), retry = await core.terminal(op.id, 'commit', snapshot);
  assert.equal(first.invoice.id, retry.invoice.id);
  await assert.rejects(clinic.undo(a.id, 1));
  await clinic.reconcile(op.id, { state: 'COMMITTED', invoiceId: first.invoice.id });
  await assert.rejects(clinic.reconcile(op.id, { state: 'ABORTED' }));
});
test('real broker confirm/crash before mark; DB rollback; commit before ACK redelivery; deleted notification replay', async () => {
  const id = randomUUID(), notificationId = randomUUID();
  const event = { eventId: id, eventType: 'notification.requested.v1', schemaVersion: 1, producer: 'core', aggregateType: 'appointment', aggregateId: run, aggregateVersion: 1, occurredAt: new Date().toISOString(), correlationId: run, payload: { notificationId, recipientOwnerId: run, title: 'Fixture', message: 'Synthetic P1 only' } };
  // Lease older billing events so the relay selects this synthetic notification.
  await clients.core.outboxEvent.updateMany({ where: { publishedAt: null }, data: { leaseUntil: new Date(Date.now() + 60000), leaseOwner: run } });
  await clients.core.outboxEvent.create({ data: { id, envelope: event } });
  const relay = new OutboxRelay(clients.core, broker);
  await assert.rejects(relay.once(run, queue, () => { throw new Error('CRASH_AFTER_CONFIRM'); }));
  assert.equal((await clients.core.outboxEvent.findUnique({ where: { id } })).publishedAt, null);
  await clients.core.outboxEvent.update({ where: { id }, data: { leaseUntil: new Date(0) } });
  await relay.once(run + '-retry', queue);
  const message = await channel.get(queue, { noAck: false }); assert.ok(message);
  const raw = message.content.toString('utf8');
  await assert.rejects(inbox.apply(raw, () => { throw new Error('DB_CRASH'); }));
  assert.equal(await clients.notification.inboxEvent.count({ where: { eventId: id } }), 0);
  await inbox.apply(raw);
  await channel.close(); // committed effect, original not ACKed
  channel = await connection.createConfirmChannel(); channel.on('error', () => {});
  let count = 0;
  while (true) { const duplicate = await channel.get(queue, { noAck: false }); if (!duplicate) break; await inbox.apply(duplicate.content.toString('utf8')); channel.ack(duplicate); count++; }
  assert.ok(count >= 2); assert.equal(await clients.notification.notification.count({ where: { id: notificationId } }), 1);
  await clients.notification.notification.delete({ where: { id: notificationId } }); await inbox.apply(raw);
  assert.equal(await clients.notification.notification.count({ where: { id: notificationId } }), 0);
  const missing = randomUUID(); await clients.core.outboxEvent.create({ data: { id: missing, envelope: { ...event, eventId: missing } } });
  await assert.rejects(relay.once(run, `p2.nonexistent.${run}`), /UNROUTABLE/);
  assert.equal((await clients.core.outboxEvent.findUnique({ where: { id: missing } })).publishedAt, null);
});
const notificationEvent = (aggregateId = randomUUID()) => ({ eventId: randomUUID(), eventType: 'notification.requested.v1', schemaVersion: 1, producer: 'core', aggregateType: 'appointment', aggregateId, aggregateVersion: 1, occurredAt: new Date().toISOString(), correlationId: run, payload: { notificationId: randomUUID(), recipientOwnerId: run, title: 'Fixture', message: 'Synthetic P1 only' } });
async function until(check, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`Timeout: ${label}`);
}
async function connectBroker() {
  // Docker process health does not prove the AMQP listener/auth handshake is ready.
  return until(async () => { try { return await amqp.connect(broker, { timeout: 1000 }); } catch { return false; } }, 'AMQP handshake readiness', 15000);
}
async function registerQueue(name) {
  const q = `p2.proof.${run}.${name}`;
  await channel.assertQueue(q, { durable: true }); await channel.assertQueue(`${q}.dlq`, { durable: true });
  extraQueues.add(q); extraQueues.add(`${q}.dlq`); return q;
}
async function send(q, event) { await publishConfirmed(channel, '', q, Buffer.from(JSON.stringify(event)), { messageId: event.eventId }); }
async function empty(q) { await until(async () => (await channel.checkQueue(q)).messageCount === 0, 'queue drain'); }

test('topic routes billing/directory to Clinic; projection never regresses or revives a tombstone', async () => {
  const t = topology(`p2.routes.${run}`); await declareTopology(broker, t);
  extraExchanges.add(t.exchange); for (const c of ['clinic', 'notification']) { extraQueues.add(t[c]); extraQueues.add(`${t[c]}.dlq`); }
  const ownerId = randomUUID(), clinicInbox = new ClinicInbox(clients.clinic);
  for (const version of [2, 3, 1]) {
    const event = { ...notificationEvent(ownerId), eventType: 'directory.owner-upserted.v1', aggregateType: 'owner', aggregateVersion: version, payload: { id: ownerId, sourceVersion: version, displayName: 'Synthetic owner', deletedAt: version === 3 ? new Date().toISOString() : null } };
    await clients.core.outboxEvent.create({ data: { id: event.eventId, envelope: event } });
    await new OutboxRelay(clients.core, broker, ownerId).once(run, t);
    const message = await until(() => channel.get(t.clinic, { noAck: false }), 'directory route');
    await clinicInbox.apply(message.content.toString()); await clinicInbox.apply(message.content.toString()); channel.ack(message);
  }
  const projection = await clients.clinic.directoryProjection.findUnique({ where: { kind_id: { kind: 'owner', id: ownerId } } });
  assert.equal(projection.sourceVersion, 3); assert.ok(projection.deletedAt);
  assert.equal((await channel.checkQueue(t.notification)).messageCount, 0);
  const a = await appointment(), op = await begin(a); const snap = await clinic.prepare(op.id, a.id, 1); const result = await core.terminal(op.id, 'commit', snap);
  await new OutboxRelay(clients.core, broker, op.id).once(run, t);
  const issued = await until(() => channel.get(t.clinic, { noAck: false }), 'billing route');
  await clinicInbox.apply(issued.content.toString()); channel.ack(issued);
  assert.equal((await clients.clinic.billingReservation.findUnique({ where: { operationId: op.id } })).invoiceId, result.invoice.id);
  const invalid = { ...notificationEvent(), eventType: 'billing.operation-aborted.v1', payload: { operationId: op.id } };
  await assert.rejects(clinicInbox.apply(JSON.stringify(invalid)));
  assert.equal(await clients.clinic.inboxEvent.count({ where: { eventId: invalid.eventId } }), 0);
});

test('actual consumer retries rolled-back DB work, isolates poison, exhausts to DLQ and replays one unchanged ID', async () => {
  const q = await registerQueue('retry'), event = notificationEvent(); let calls = 0;
  let consumer = await consumeEvents(broker, q, 'notification', raw => inbox.apply(raw, () => { if (++calls === 1) throw new Error('TRANSIENT_DB_FAULT'); }), { retryBaseMs: 25 });
  try { await send(q, event); await until(() => clients.notification.notification.findUnique({ where: { id: event.payload.notificationId } }), 'retry succeeds'); await empty(q); assert.equal(calls, 2); }
  finally { await consumer.close(); }
  let poisonCalls = 0;
  consumer = await consumeEvents(broker, q, 'notification', raw => { poisonCalls++; return inbox.apply(raw); });
  try {
    const poison = { ...notificationEvent(), schemaVersion: 99 }; await send(q, poison);
    const dead = await until(() => channel.get(`${q}.dlq`, { noAck: false }), 'poison DLQ');
    assert.equal(dead.properties.headers['p2-error-code'], 'INVALID_EVENT'); assert.equal(poisonCalls, 0); channel.ack(dead);
  } finally { await consumer.close(); }
  const exhausted = notificationEvent(); calls = 0;
  consumer = await consumeEvents(broker, q, 'notification', raw => { calls++; return inbox.apply(raw, () => { throw new Error('DB_ROLLBACK'); }); }, { retryBaseMs: 25 });
  try { await send(q, exhausted); await until(async () => (await channel.checkQueue(`${q}.dlq`)).messageCount === 1, 'retry exhausted'); assert.equal(calls, 3); }
  finally { await consumer.close(); }
  assert.equal(await clients.notification.inboxEvent.count({ where: { eventId: exhausted.eventId } }), 0);
  consumer = await consumeEvents(broker, q, 'notification', raw => inbox.apply(raw));
  try {
    const audit = await replayEvent(broker, q, exhausted.eventId); assert.equal(audit.eventId, exhausted.eventId);
    await until(() => clients.notification.notification.findUnique({ where: { id: exhausted.payload.notificationId } }), 'selected replay'); await empty(q);
    assert.equal(await clients.notification.inboxEvent.count({ where: { eventId: exhausted.eventId } }), 1);
  } finally { await consumer.close(); }
});

test('consumer crash before/after retry confirm and after DB commit retains originals; unroutable DLQ never ACKs', async () => {
  for (const stage of ['beforeRepublish', 'afterRepublishConfirm', 'afterCommit', 'missingDLQ']) {
    const q = await registerQueue(stage), event = notificationEvent(); let calls = 0;
    const options = { retryBaseMs: 25 };
    if (stage === 'missingDLQ') options.beforeRepublish = async () => { await channel.deleteQueue(`${q}.dlq`); };
    else options[stage] = () => { throw new Error('SIMULATED_CRASH'); };
    let consumer = await consumeEvents(broker, q, 'notification', raw => inbox.apply(raw, () => { calls++; if (stage !== 'afterCommit') throw new Error('DB_ROLLBACK'); }), options);
    const message = stage === 'missingDLQ' ? { ...event, schemaVersion: 99 } : event;
    let closed = false; consumer.done.then(() => { closed = true; });
    await send(q, message); await until(() => closed, 'fault closes original channel');
    await consumer.close();
    const pending = await channel.checkQueue(q); assert.equal(pending.messageCount, stage === 'afterRepublishConfirm' ? 2 : 1);
    if (stage === 'missingDLQ') {
      await channel.assertQueue(`${q}.dlq`, { durable: true });
      consumer = await consumeEvents(broker, q, 'notification', raw => inbox.apply(raw));
      try { const dead = await until(() => channel.get(`${q}.dlq`, { noAck: false }), 'retained poison DLQ'); channel.ack(dead); await empty(q); }
      finally { await consumer.close(); }
    } else {
      consumer = await consumeEvents(broker, q, 'notification', raw => inbox.apply(raw));
      try {
        await until(() => clients.notification.notification.findUnique({ where: { id: event.payload.notificationId } }), 'redelivery effect'); await empty(q);
        assert.equal(await clients.notification.notification.count({ where: { id: event.payload.notificationId } }), 1);
      } finally { await consumer.close(); }
    }
  }
});

async function spawnWorker(service, env) {
  const path = service === 'core' ? 'backend/dist/src/phase2/worker.js' : `services/${service}/dist/worker.js`;
  if(service==='clinic')env={...env,CORE_SERVICE_URL:'',CLINIC_PROOF_ONLY:'1'};
  const child = spawn(process.execPath, [path], { env: { ...process.env, ...env }, stdio: 'pipe' });
  let output = '', exited = false; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; }); child.once('exit', () => { exited = true; });
  const stop = async () => { if (!exited) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } };
  try { await until(() => { if (exited) throw new Error(`${service} worker exited before ready`); return output.includes('worker-ready'); }, 'worker ready'); }
  catch (error) { await stop(); throw error; }
  return { stop, logs: () => output };
}
test('three built workers route both producers, survive broker stop and recover durable backlog after restart', { timeout: 60000 }, async () => {
  const t = topology(`p2.workers.${run}`); await declareTopology(broker, t);
  extraExchanges.add(t.exchange); for (const c of ['clinic', 'notification']) { extraQueues.add(t[c]); extraQueues.add(`${t[c]}.dlq`); }
  const a = await appointment(), op = await begin(a), snap = await clinic.prepare(op.id, a.id, 1); await core.terminal(op.id, 'commit', snap);
  const workers = [], env = { BROKER_URL: broker, BROKER_PREFIX: `p2.workers.${run}`, OUTBOX_AGGREGATE_ID: op.id };
  let notificationWorker, stoppedBroker = false;
  const docker = (...args) => execFileSync('docker', ['compose', '-f', 'deploy/phase2/compose.test.yml', ...args], { stdio: 'pipe', timeout: 30000 });
  assert.equal(docker('exec', '-T', 'rabbitmq', 'hostname').toString().trim(), 'p2-rabbit-test', 'Stable node identity is required for durable volume reload');
  try {
    notificationWorker = await spawnWorker('notification', { ...env, DATABASE_URL: urls.notification }); workers.push(notificationWorker);
    workers.push(await spawnWorker('clinic', { ...env, DATABASE_URL: urls.clinic })); workers.push(await spawnWorker('core', { ...env, DATABASE_URL: urls.core }));
    const coreEvent = notificationEvent(op.id), clinicEvent = { ...notificationEvent(op.id), producer: 'clinic' };
    await clients.core.outboxEvent.create({ data: { id: coreEvent.eventId, envelope: coreEvent } }); await clients.clinic.outboxEvent.create({ data: { id: clinicEvent.eventId, envelope: clinicEvent } });
    for (const event of [coreEvent, clinicEvent]) await until(() => clients.notification.notification.findUnique({ where: { id: event.payload.notificationId } }), 'both worker producers');
    await until(async () => (await clients.clinic.billingReservation.findUnique({ where: { operationId: op.id } })).state === 'INVOICED', 'billing worker finalizes');
    await notificationWorker.stop();
    const queued = notificationEvent(op.id); await clients.core.outboxEvent.create({ data: { id: queued.eventId, envelope: queued } });
    await until(async () => (await clients.core.outboxEvent.findUnique({ where: { id: queued.eventId } })).publishedAt, 'backlog confirmed'); await until(async () => (await channel.checkQueue(t.notification)).messageCount >= 1, 'durable backlog');
    await channel.close(); await connection.close(); channel = undefined; connection = undefined;
    docker('stop', 'rabbitmq'); stoppedBroker = true;
    const pending = notificationEvent(op.id); await clients.core.outboxEvent.create({ data: { id: pending.eventId, envelope: pending } });
    await until(async () => (await clients.core.outboxEvent.findUnique({ where: { id: pending.eventId } })).lastErrorCode === 'DELIVERY_UNCONFIRMED', 'broker-down outbox retained');
    assert.equal((await clients.core.outboxEvent.findUnique({ where: { id: pending.eventId } })).publishedAt, null);
    docker('up', '-d', '--wait', 'rabbitmq'); stoppedBroker = false;
    connection = await connectBroker(); connection.on('error', () => {}); channel = await connection.createConfirmChannel(); channel.on('error', () => {});
    assert.equal(docker('exec', '-T', 'rabbitmq', 'hostname').toString().trim(), 'p2-rabbit-test');
    assert.ok((await channel.checkQueue(t.notification)).messageCount >= 1, 'Durable backlog survives restart');
    notificationWorker = await spawnWorker('notification', { ...env, DATABASE_URL: urls.notification }); workers.push(notificationWorker);
    for (const event of [queued, pending]) await until(() => clients.notification.notification.findUnique({ where: { id: event.payload.notificationId } }), 'restart catch-up', 20000);
    await empty(t.notification); await empty(t.clinic);
    assert.ok(workers.every(w => !/fixture_only|postgresql:|amqp:\/\//.test(w.logs())), 'Worker logs do not expose credentials');
  } finally {
    await Promise.all(workers.map(w => w.stop()));
    if (stoppedBroker) docker('up', '-d', '--wait', 'rabbitmq');
    if (!connection) { connection = await connectBroker(); connection.on('error', () => {}); channel = await connection.createConfirmChannel(); channel.on('error', () => {}); }
  }
});
