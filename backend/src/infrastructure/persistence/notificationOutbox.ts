import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { parseEnvelope, type Envelope } from '@nipopeto/contracts';
import { BusinessError } from '../../domain/error.js';
import {currentRequestId} from '@nipopeto/runtime';

interface NotificationDraft {
  recipientOwnerId?: string | null; recipientRole?: string; type: string; title: string; message: string;
  actionUrl?: string | null; relatedPetId?: string | null; relatedAppointmentId?: string | null;
  relatedBookingId?: string | null; sentByStaffId?: string | null;
}
// Every domain caller passes its existing transaction. A reminder has no other
// write and can use its single atomic outbox insert directly.
export async function writeNotification(tx: Pick<Prisma.TransactionClient, 'outboxEvent'>, draft: NotificationDraft) {
  const id = randomUUID(), notificationId = randomUUID(), occurredAt = new Date().toISOString();
  const event: Envelope = {
    eventId: id, eventType: 'notification.requested.v1', schemaVersion: 1, producer: 'core',
    aggregateType: 'notification', aggregateId: notificationId, aggregateVersion: 1,
    occurredAt, correlationId: currentRequestId()??id,
    payload: { notificationId, recipientOwnerId: draft.recipientOwnerId ?? null, recipientRole: draft.recipientRole ?? 'owner',
      type: draft.type, title: draft.title, message: draft.message, status: 'sent',
      actionUrl: draft.actionUrl ?? null, relatedPetId: draft.relatedPetId ?? null,
      relatedAppointmentId: draft.relatedAppointmentId ?? null, relatedBookingId: draft.relatedBookingId ?? null,
      sentByStaffId: draft.sentByStaffId ?? null, createdAt: occurredAt, sentAt: occurredAt },
  };
  try { parseEnvelope(JSON.stringify(event)); }
  catch { throw new BusinessError(422, 'Notification request exceeds the supported event contract.'); }
  try { await tx.outboxEvent.create({ data: { id, envelope: event as unknown as Prisma.InputJsonValue } }); }
  catch { throw new BusinessError(503, 'Notification request could not be recorded. No domain change committed.'); }
  return notificationId;
}
