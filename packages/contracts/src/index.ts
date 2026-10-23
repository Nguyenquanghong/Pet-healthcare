import { Buffer } from 'node:buffer';
export * from './permissions.js';
export * from './notificationCategories.js';
export * from './bookingLifecycle.js';
export const eventTypes = ['notification.requested.v1', 'billing.invoice-issued.v1', 'billing.operation-aborted.v1', 'directory.owner-upserted.v1', 'directory.pet-upserted.v1', 'directory.staff-upserted.v1', 'clinic.appointment-read-changed.v1', 'identity.sessions-revoked.v1'] as const;
export type EventType = typeof eventTypes[number];
// F7: the event types each consumer applies, named one by one. A new type reaches a
// consumer only once it is listed here and the consumer handles it explicitly.
export const consumedEvents = {
  notification: ['notification.requested.v1', 'identity.sessions-revoked.v1'],
  clinic: ['directory.owner-upserted.v1', 'directory.pet-upserted.v1', 'directory.staff-upserted.v1', 'billing.invoice-issued.v1', 'billing.operation-aborted.v1'],
  'clinic-read-v1': ['clinic.appointment-read-changed.v1'],
} as const satisfies Record<string, readonly EventType[]>;
export type EventConsumer = keyof typeof consumedEvents;
export function consumes(consumer: EventConsumer, eventType: string): boolean {
  return (consumedEvents[consumer] as readonly string[]).includes(eventType);
}
export interface Envelope {
  eventId: string; eventType: EventType; schemaVersion: 1; producer: 'core' | 'clinic';
  aggregateType: string; aggregateId: string; aggregateVersion: number; occurredAt: string; correlationId: string;
  payload: Record<string, unknown>;
}
export type CoreState = 'PREPARING' | 'COMMITTED' | 'ABORTED';
export interface ReservationSnapshot { appointmentId: string; ownerId: string; petId: string; revision: number; type: string }
export interface BillingSourceSnapshot extends ReservationSnapshot {
  serviceName: string; clinicName: string; date: string; time: string;
}
export interface DirectoryEntry { id: string; sourceVersion: number; displayName: string; ownerId?: string; species?: string; phone?: string | null; breed?: string | null; deletedAt?: string | null }
export interface NotificationPayload {
  notificationId: string; recipientOwnerId: string | null; recipientRole?: 'owner' | 'admin';
  title: string; message: string; type?: string; status?: 'sent' | 'read';
  actionUrl?: string | null; relatedPetId?: string | null; relatedAppointmentId?: string | null;
  relatedBookingId?: string | null; sentByStaffId?: string | null; createdAt?: string; sentAt?: string;
}
// AQ-05: tokens of `userId` issued before `revokedBefore` (iat in whole seconds) are revoked.
export interface SessionRevocationPayload { userId: string; revokedBefore: string }
export function parseEnvelope(raw: string): Envelope {
  if (Buffer.byteLength(raw) > 32768) throw new Error('EVENT_TOO_LARGE');
  const e = JSON.parse(raw);
  if (!e || e.schemaVersion !== 1 || !eventTypes.includes(e.eventType) || !['core', 'clinic'].includes(e.producer)
    || !Number.isSafeInteger(e.aggregateVersion) || e.aggregateVersion < 1 || !Number.isFinite(Date.parse(e.occurredAt))
    || !['eventId', 'aggregateType', 'aggregateId', 'correlationId'].every(k => typeof e[k] === 'string' && e[k].length > 0 && e[k].length <= 128)
    || !e.payload || typeof e.payload !== 'object' || Array.isArray(e.payload)) throw new Error('INVALID_ENVELOPE');
  if (e.eventType === 'clinic.appointment-read-changed.v1') {
    const p = e.payload;
    if (e.producer !== 'clinic' || e.aggregateType !== 'appointment' || e.aggregateVersion > 2147483647
      || p.appointmentId !== e.aggregateId || p.sourceVersion !== e.aggregateVersion || typeof p.deleted !== 'boolean'
      || Object.keys(p).length !== 3 || !Object.keys(p).every(k => ['appointmentId','sourceVersion','deleted'].includes(k))
      || !Object.keys(e).every(k => ['eventId','eventType','schemaVersion','producer','aggregateType','aggregateId','aggregateVersion','occurredAt','correlationId','payload'].includes(k))) throw new Error('INVALID_APPOINTMENT_READ_CHANGE');
    return e;
  }
  if (e.eventType.startsWith('directory.')) {
    const p = e.payload;
    if (e.producer !== 'core' || p.id !== e.aggregateId || p.sourceVersion !== e.aggregateVersion
      || typeof p.displayName !== 'string' || !p.displayName || p.displayName.length > 200
      || !Object.keys(p).every(k => ['id', 'sourceVersion', 'displayName', 'ownerId', 'species', 'phone', 'breed', 'deletedAt'].includes(k))
      || !['phone','breed'].every(k => p[k] == null || typeof p[k] === 'string' && p[k].length <= 200)
      || (p.deletedAt != null && (typeof p.deletedAt !== 'string' || !Number.isFinite(Date.parse(p.deletedAt))))
      || (e.eventType === 'directory.pet-upserted.v1' && (typeof p.ownerId !== 'string' || !p.ownerId))
      || (p.ownerId !== undefined && (typeof p.ownerId !== 'string' || !p.ownerId))
      || (p.species !== undefined && !['dog', 'cat', 'rabbit', 'other'].includes(p.species))) throw new Error('INVALID_DIRECTORY');
    return e;
  }
  if (e.eventType === 'identity.sessions-revoked.v1') {
    const p = e.payload, at = typeof p.revokedBefore === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(p.revokedBefore) ? Date.parse(p.revokedBefore) : NaN;
    if (e.producer !== 'core' || e.aggregateType !== 'user' || p.userId !== e.aggregateId || !Number.isFinite(at)
      || e.aggregateVersion !== Math.floor(at / 1000) || Object.keys(p).length !== 2
      || !Object.keys(p).every(k => ['userId', 'revokedBefore'].includes(k))) throw new Error('INVALID_SESSION_REVOCATION');
    return e;
  }
  if (e.eventType.startsWith('billing.') && e.producer !== 'core') throw new Error('INVALID_PRODUCER');
  if (e.eventType === 'notification.requested.v1') {
    const p = e.payload;
    const role = p.recipientRole === undefined ? 'owner' : p.recipientRole;
    const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
    if (!text(p.notificationId, 128) || !text(p.title, 10000) || !text(p.message, 10000)
      || !(role === 'owner' ? text(p.recipientOwnerId, 200) : role === 'admin' && p.recipientOwnerId === null)
      || (p.type !== undefined && !text(p.type, 128))
      || (p.status !== undefined && !['sent', 'read'].includes(p.status))
      || !['actionUrl', 'relatedPetId', 'relatedAppointmentId', 'relatedBookingId', 'sentByStaffId'].every(k => p[k] == null || text(p[k], k === 'actionUrl' ? 2000 : 200))
      || !['createdAt', 'sentAt'].every(k => p[k] === undefined || (typeof p[k] === 'string' && /^\d{4}-\d\d-\d\dT/.test(p[k]) && Number.isFinite(Date.parse(p[k]))))
      || !Object.keys(p).every(k => ['notificationId', 'recipientOwnerId', 'recipientRole', 'title', 'message', 'type', 'status', 'actionUrl', 'relatedPetId', 'relatedAppointmentId', 'relatedBookingId', 'sentByStaffId', 'createdAt', 'sentAt'].includes(k))) throw new Error('INVALID_NOTIFICATION');
    return e;
  }
  const required = e.eventType === 'billing.invoice-issued.v1' ? ['operationId', 'invoiceId'] : ['operationId'];
  if (!required.every(k => typeof e.payload[k] === 'string' && e.payload[k].length > 0 && e.payload[k].length <= 128)
    || (e.payload.appointmentId !== undefined && (typeof e.payload.appointmentId !== 'string' || !e.payload.appointmentId || e.payload.appointmentId.length>128))
    || !Object.keys(e.payload).every(k=>['operationId','invoiceId','appointmentId'].includes(k))) throw new Error('INVALID_PAYLOAD');
  return e;
}
