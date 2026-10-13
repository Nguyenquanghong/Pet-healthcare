// Historical diagnostic: reproduce the pre-A01 root Compose configuration.
// The repaired Compose is tested by tools/docker/test-notifications.mjs.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { assertTestProject } from '../../tools/phase2/test-project.mjs';
import { PrismaClient } from '@prisma/client';
import { createCoreApp } from '../../backend/dist/src/phase2/coreApp.js';
import { signToken } from '../../backend/dist/src/lib/token.js';
import { hashPasswordAsync } from '../../backend/dist/src/lib/password.js';

assertTestProject();
for (const name of ['JWT_PRIVATE_KEY','JWT_PUBLIC_KEY','JWT_ISSUER','JWT_AUDIENCE','JWT_KEY_ID','REDIS_URL','PHASE2_RUNTIME_REQUIRED']) delete process.env[name];
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const db = new PrismaClient({ datasourceUrl: 'postgresql://p2_core:p2_core_fixture_only@127.0.0.1:55432/p2_core_test?schema=core_runtime_test' });
let server;
const run = randomUUID();
try {
  const [identity] = await db.$queryRaw`SELECT current_database() AS db, current_user AS role`;
  assert.equal(identity.db, 'p2_core_test'); assert.equal(identity.role, 'p2_core');
  const [marker] = await db.$queryRaw`SELECT marker FROM public.p2_test_marker`;
  assert.equal(marker.marker, 'pet-phase2-p1-test:core:v1');
  const credential = await hashPasswordAsync(randomBytes(24).toString('hex'));
  const admin = await db.user.create({ data: { id: randomUUID(), username: 'audit_' + run, fullName: 'Synthetic audit admin', role: 'admin', ...credential } });
  const owner = await db.user.create({ data: { id: randomUUID(), email: `audit_${run}@example.test`, fullName: 'Synthetic audit owner', role: 'owner', ...credential } });
  const pet = await db.pet.create({ data: { ownerId: owner.id, name: 'Synthetic audit pet', species: 'dog', allergies: [] } });
  const tokens = { admin: signToken(admin.id, 'admin'), owner: signToken(owner.id, 'owner') };
  server = createCoreApp(db, {}).listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  async function request(path, { role = 'admin', method = 'GET', body } = {}) {
    const response = await fetch(origin + '/api' + path, { method, headers: { Authorization: 'Bearer ' + tokens[role], 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  }
  const date = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const appointment = await request('/appointments', { role: 'owner', method: 'POST', body: { petId: pet.id, type: 'spa_bath', date, time: '10:00', serviceName: 'Synthetic audit' } });
  assert.equal(appointment.status, 201);
  const unread = await request('/notifications/unread-count');
  const manual = await request('/notifications/send', { method: 'POST', body: { recipientOwnerId: owner.id, title: 'Synthetic audit', message: 'Fixture diagnostic' } });
  const pending = await db.outboxEvent.count({ where: { publishedAt: null, envelope: { path: ['payload', 'relatedAppointmentId'], equals: appointment.body.appointment.id } } });
  const delivered = await db.notification.count({ where: { relatedAppointmentId: appointment.body.appointment.id } });
  const beforeDelete = await request('/owners?pageSize=1');
  await db.user.delete({ where: { id: admin.id } }); // this run's synthetic user only
  const staleMe = await request('/auth/me');
  const staleOwners = await request('/owners?pageSize=1');
  const report = { run, target: 'isolated p2_core_test, historical pre-A01 root Compose configuration',
    findings: { unreadEndpointStatus: unread.status, manualSendStatus: manual.status, appointmentCreatedStatus: appointment.status,
      pendingNotificationEvents: pending, deliveredLegacyNotifications: delivered,
      deletedAdminToken: { beforeOwners: beforeDelete.status, afterMe: staleMe.status, afterOwners: staleOwners.status,
        classification: staleOwners.status === 401 ? 'Core account-deletion check verified' : 'Core accepts deleted-account JWT; review required' } },
    liveDatabaseTouched: false, applicationCodeChanged: false };
  writeFileSync(`test-results/phase2/audit-local-mode-${run}.json`, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report) + '\n');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.$disconnect();
}
