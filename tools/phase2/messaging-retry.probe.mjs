// P03 step 1 and 7: measure how @nipopeto/messaging retries, before and after the
// change, with the production retry settings (no test overrides), on the test broker.
//   directory-outage    Core answers 503 while directory events arrive at Clinic
//                       (1 event for 5 s, then 50 events for 10 s): how many end in
//                       the DLQ, when all are settled.
//   revocation          latency of a session revocation alone, behind 500
//                       notifications, and behind one message that keeps failing.
// Writes test-results/phase2/p03-<label>/result.json. Test project only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import amqp from 'amqplib';
import { declareTopology, topology, publishConfirmed, consumeEvents } from '@nipopeto/messaging';
import { PrismaClient as ClinicClient } from '../../services/clinic/src/generated/client/index.js';
import { PrismaClient as NotificationClient } from '../../services/notification/src/generated/client/index.js';
import { ClinicInbox } from '../../services/clinic/dist/inbox.js';
import { DirectorySync } from '../../services/clinic/dist/directorySync.js';
import { NotificationInbox } from '../../services/notification/dist/inbox.js';
import { assertTestProject } from './test-project.mjs';

assertTestProject();
const label = process.argv[2];
if (!/^[a-z0-9-]{1,40}$/.test(label ?? '')) throw new Error('usage: node --import tsx tools/phase2/messaging-retry.probe.mjs <label>');
const broker = 'amqp://p2_test:p2_broker_fixture_only@127.0.0.1:5679';
const clinic = new ClinicClient({ datasourceUrl: 'postgresql://p2_clinic:p2_clinic_fixture_only@127.0.0.1:55432/p2_clinic_test?schema=p1_proof' });
const notification = new NotificationClient({ datasourceUrl: 'postgresql://p2_notification:p2_notification_fixture_only@127.0.0.1:55432/p2_notification_test?schema=p1_proof' });
for (const [service, db] of Object.entries({ clinic, notification })) {
  const [marker] = await db.$queryRaw`SELECT marker FROM public.p2_test_marker`;
  assert.equal(marker.marker, `pet-phase2-p1-test:${service}:v1`);
}
const run = randomUUID(), prefix = `p3.retry-probe.${run.slice(0, 8)}`, routes = topology(prefix);
const now = () => performance.now();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeoutMs, step = 10) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) { if (await check()) return true; await pause(step); }
  return false;
}
const envelope = (eventType, aggregateType, aggregateId, aggregateVersion, payload) => ({
  eventId: randomUUID(), eventType, schemaVersion: 1, producer: 'core', aggregateType, aggregateId, aggregateVersion,
  occurredAt: new Date().toISOString(), correlationId: run, payload,
});
const ownerEvent = id => envelope('directory.owner-upserted.v1', 'owner', id, 1, { id, sourceVersion: 1, displayName: 'P03 probe owner' });
const notificationEvent = () => envelope('notification.requested.v1', 'notification', run, 1, { notificationId: randomUUID(), recipientOwnerId: randomUUID(), title: run, message: 'P03 probe' });
function revocationEvent(userId) {
  const at = new Date(Math.floor(Date.now() / 1000) * 1000);
  return envelope('identity.sessions-revoked.v1', 'user', userId, Math.floor(at.getTime() / 1000), { userId, revokedBefore: at.toISOString() });
}

const connection = await amqp.connect(broker); connection.on('error', () => {});
const channel = await connection.createConfirmChannel(); channel.on('error', () => {});
await declareTopology(broker, routes);
// Routed by event type through the exchange, as the outbox relays publish.
const publish = event => publishConfirmed(channel, routes.exchange, event.eventType, Buffer.from(JSON.stringify(event)), { messageId: event.eventId, contentType: 'application/json' });
const ready = async queue => (await channel.checkQueue(queue)).messageCount;
const result = { label, startedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=no', '--', 'packages/messaging', 'services'], { encoding: 'utf8' }).trim().length > 0,
  retrySettings: process.env.BROKER_RETRY_DELAYS_MS ?? 'default', queues: Object.keys(routes).filter(k => k !== 'exchange') };
const consumers = [], ownerIds = [], userIds = [];
let core;
try {
  // ---- directory outage ---------------------------------------------------------
  let downUntil = 0, coreCalls = 0;
  core = createServer((req, res) => {
    coreCalls++;
    const id = new URL(req.url, 'http://core').searchParams.get('id');
    if (Date.now() < downUntil) { res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"restarting"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ kind: 'owner', items: [{ id, sourceVersion: 1, displayName: 'P03 probe owner' }], nextCursor: null }));
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => core.once('listening', resolve));
  const sync = new DirectorySync(`http://127.0.0.1:${core.address().port}`, 'p03-probe-token-'.padEnd(40, 'x'));
  const inbox = new ClinicInbox(clinic, (kind, entry) => sync.hydrate(kind, entry));
  consumers.push(await consumeEvents(broker, routes.clinic, 'clinic', raw => inbox.apply(raw)));
  result.directoryOutage = [];
  for (const [events, outageMs] of [[1, 5000], [50, 10000]]) {
    const ids = []; for (let i = 0; i < events; i++) ids.push(randomUUID());
    ownerIds.push(...ids);
    const dlqBefore = await ready(`${routes.clinic}.dlq`), callsBefore = coreCalls;
    downUntil = Date.now() + outageMs;
    const started = now();
    for (const id of ids) await publish(ownerEvent(id));
    const applied = () => clinic.directoryProjection.count({ where: { kind: 'owner', id: { in: ids } } });
    const deadLettered = async () => (await ready(`${routes.clinic}.dlq`)) - dlqBefore;
    const done = await until(async () => (await applied()) + (await deadLettered()) === events, 180000, 100);
    result.directoryOutage.push({ events, outageMs, settled: done, settledAfterMs: done ? Math.round(now() - started) : null,
      applied: await applied(), deadLettered: await deadLettered(), coreCalls: coreCalls - callsBefore });
    await until(async () => Date.now() >= downUntil, outageMs + 1000, 50);
  }

  // ---- session revocation latency ----------------------------------------------------
  const poison = new Set();
  const notificationInbox = new NotificationInbox(notification);
  const apply = raw => { if (poison.has(JSON.parse(raw).eventId)) throw new Error('PROBE_APPLY_FAILED'); return notificationInbox.apply(raw); };
  // The queues the Notification worker consumes, whatever this version declares.
  for (const queue of [routes.notification, ...(routes.identity ? [routes.identity] : [])]) consumers.push(await consumeEvents(broker, queue, 'notification', apply));
  async function revocationLatency() {
    const userId = randomUUID(); userIds.push(userId);
    const started = now(); await publish(revocationEvent(userId));
    const seen = await until(async () => !!await notification.sessionRevocation.findUnique({ where: { userId } }), 60000);
    return seen ? Math.round(now() - started) : null;
  }
  const notifications = () => notification.notification.count({ where: { title: run } });
  async function drained(expected) { return until(async () => (await notifications()) >= expected, 120000, 50); }
  const alone = []; for (let i = 0; i < 5; i++) alone.push(await revocationLatency());
  let expected = 0; const behindBacklog = [];
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 500; i++) await publish(notificationEvent());
    expected += 500; behindBacklog.push(await revocationLatency()); await drained(expected);
  }
  // One message that keeps failing, then 20 good ones and a revocation.
  const failing = notificationEvent(); poison.add(failing.eventId); await publish(failing);
  const blockedStart = now();
  for (let i = 0; i < 20; i++) await publish(notificationEvent());
  expected += 20;
  const revokedBehindFailure = await revocationLatency();
  const goodDone = await drained(expected);
  result.revocation = { aloneMs: alone, behind500NotificationsMs: behindBacklog, behindFailingMessageMs: revokedBehindFailure,
    twentyBehindFailingMessageMs: goodDone ? Math.round(now() - blockedStart) : null };
  const failedSettled = await until(async () => (await ready(`${routes.notification}.dlq`)) === 1, 15000, 50);
  result.revocation.failingMessageInDlqAfterMs = failedSettled ? Math.round(now() - blockedStart) : `not in DLQ ${Math.round(now() - blockedStart)} ms after publish`;
} finally {
  await Promise.allSettled(consumers.map(c => c.close()));
  core?.close();
  // Every queue of this run, retry queues included, then the exchange.
  const queues = JSON.parse(execFileSync('docker', ['compose', '-f', 'deploy/phase2/compose.test.yml', 'exec', '-T', 'rabbitmq', 'rabbitmqctl', 'list_queues', '--formatter', 'json', 'name'], { encoding: 'utf8', timeout: 30000 }))
    .map(q => q.name).filter(name => name.startsWith(prefix + '.'));
  for (const name of queues) await channel.deleteQueue(name).catch(() => {});
  await channel.deleteExchange(routes.exchange).catch(() => {});
  await connection.close().catch(() => {});
  await clinic.directoryProjection.deleteMany({ where: { kind: 'owner', id: { in: ownerIds } } });
  await notification.notification.deleteMany({ where: { title: run } });
  await notification.sessionRevocation.deleteMany({ where: { userId: { in: userIds } } });
  await Promise.all([clinic.$disconnect(), notification.$disconnect()]);
}
result.finishedAt = new Date().toISOString();
const dir = `test-results/phase2/p03-${label}`;
mkdirSync(dir, { recursive: true }); writeFileSync(`${dir}/result.json`, JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
