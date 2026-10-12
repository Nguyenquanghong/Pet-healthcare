import { createHash } from 'node:crypto';
import { parseEnvelope } from '@nipopeto/contracts';
import { NotificationInbox } from '../../services/notification/dist/inbox.js';

// Offline migration tooling only. Runtime services never construct one another's
// clients. These guards intentionally support the rehearsal databases only.
export async function assertTestDatabase(db, service, schema) {
  const [identity] = await db.$queryRaw`SELECT current_database() AS db, current_user AS role, current_schema() AS schema`;
  if (identity.db !== `p2_${service}_test` || identity.role !== `p2_${service}` || identity.schema !== schema) throw new Error('WRONG_TEST_DATABASE_IDENTITY');
  const [marker] = await db.$queryRaw`SELECT marker FROM public.p2_test_marker`;
  if (marker.marker !== `pet-phase2-p1-test:${service}:v1`) throw new Error('WRONG_TEST_DATABASE_MARKER');
}
const fields = ['id','recipientOwnerId','recipientRole','type','title','message','status','actionUrl','relatedPetId','relatedAppointmentId','relatedBookingId','sentByStaffId','createdAt','sentAt'];
const normalized = row => Object.fromEntries(fields.map(k => [k, row[k] instanceof Date ? row[k].toISOString() : row[k]]));
const digest = body => createHash('sha256').update(JSON.stringify(body)).digest('hex');
function event(row) {
  const { id, ...payload } = row;
  return { eventId: `legacy-notification:${id}`, eventType: 'notification.requested.v1', schemaVersion: 1, producer: 'core', aggregateType: 'notification', aggregateId: id, aggregateVersion: 1, occurredAt: row.createdAt, correlationId: 'p2-notification-import', payload: { notificationId: id, ...payload } };
}
export async function exportNotifications(core, ids) {
  await assertTestDatabase(core, 'core', 'core_runtime_test');
  const rows = await core.$transaction(tx => tx.notification.findMany({ where: ids ? { id: { in: ids } } : {}, orderBy: { id: 'asc' } }), { isolationLevel: 'RepeatableRead' });
  const body = { schemaVersion: 1, source: 'p2_core_test/core_runtime_test', exportedAt: new Date().toISOString(), rows: rows.map(normalized) };
  for (const row of body.rows) parseEnvelope(JSON.stringify(event(row)));
  return { ...body, sha256: digest(body) };
}
function validate(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.source !== 'p2_core_test/core_runtime_test' || !Array.isArray(snapshot.rows) || !Number.isFinite(Date.parse(snapshot.exportedAt))) throw new Error('INVALID_MIGRATION_SNAPSHOT');
  const body = { schemaVersion: snapshot.schemaVersion, source: snapshot.source, exportedAt: snapshot.exportedAt, rows: snapshot.rows };
  if (snapshot.sha256 !== digest(body)) throw new Error('SNAPSHOT_CHECKSUM_MISMATCH');
  if (new Set(snapshot.rows.map(row => row.id)).size !== snapshot.rows.length) throw new Error('DUPLICATE_SOURCE_NOTIFICATION');
  for (const row of snapshot.rows) {
    if (!Object.keys(row).every(k => fields.includes(k)) || !fields.every(k => Object.hasOwn(row, k))) throw new Error('INVALID_MIGRATION_FIELDS');
    parseEnvelope(JSON.stringify(event(row)));
  }
}
export async function inspectImport(notification, snapshot) {
  validate(snapshot); await assertTestDatabase(notification, 'notification', 'p1_proof');
  let pending = 0, alreadyImported = 0;
  for (const row of snapshot.rows) {
    const seen = await notification.inboxEvent.findUnique({ where: { consumerName_eventId: { consumerName: 'notification-v1', eventId: event(row).eventId } } });
    if (seen) { alreadyImported++; continue; }
    if (await notification.notification.findUnique({ where: { id: row.id } })) throw new Error('TARGET_ID_COLLISION');
    pending++;
  }
  return { sourceRows: snapshot.rows.length, pending, alreadyImported, sha256: snapshot.sha256 };
}
export async function importNotifications(notification, snapshot, fault) {
  const before = await inspectImport(notification, snapshot), inbox = new NotificationInbox(notification);
  let imported = 0, replayed = 0;
  for (const row of snapshot.rows) {
    if (await inbox.apply(JSON.stringify(event(row)), fault ? () => fault(row) : undefined)) imported++; else replayed++;
  }
  return { ...before, imported, replayed };
}
export async function verifyImport(notification, snapshot) {
  validate(snapshot); await assertTestDatabase(notification, 'notification', 'p1_proof');
  let exact = 0, readAdvanced = 0, deletedAfterImport = 0;
  for (const row of snapshot.rows) {
    const target = await notification.notification.findUnique({ where: { id: row.id } });
    const seen = await notification.inboxEvent.findUnique({ where: { consumerName_eventId: { consumerName: 'notification-v1', eventId: event(row).eventId } } });
    if (!seen) throw new Error('SOURCE_ROW_NOT_IMPORTED');
    if (!target) { deletedAfterImport++; continue; }
    const actual = normalized(target);
    if (Object.keys(row).some(k => k !== 'status' && row[k] !== actual[k]) || !(actual.status === row.status || row.status === 'sent' && actual.status === 'read')) throw new Error('MIGRATED_ROW_MISMATCH');
    if (actual.status === row.status) exact++; else readAdvanced++;
  }
  return { sourceRows: snapshot.rows.length, exact, readAdvanced, deletedAfterImport, sha256: snapshot.sha256 };
}
