import { Buffer } from 'node:buffer';
export const eventTypes = ['notification.requested.v1', 'billing.invoice-issued.v1', 'billing.operation-aborted.v1', 'directory.owner-upserted.v1', 'directory.pet-upserted.v1', 'directory.staff-upserted.v1'] as const;
export type EventType = typeof eventTypes[number];
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
export function parseEnvelope(raw: string): Envelope {
  if (Buffer.byteLength(raw) > 32768) throw new Error('EVENT_TOO_LARGE');
  const e = JSON.parse(raw);
  if (!e || e.schemaVersion !== 1 || !eventTypes.includes(e.eventType) || !['core', 'clinic'].includes(e.producer)
    || !Number.isSafeInteger(e.aggregateVersion) || e.aggregateVersion < 1 || !Number.isFinite(Date.parse(e.occurredAt))
    || !['eventId', 'aggregateType', 'aggregateId', 'correlationId'].every(k => typeof e[k] === 'string' && e[k].length > 0 && e[k].length <= 128)
    || !e.payload || typeof e.payload !== 'object' || Array.isArray(e.payload)) throw new Error('INVALID_ENVELOPE');
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
