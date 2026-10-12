import { randomUUID } from 'node:crypto';
import type { Prisma } from './generated/client/index.js';
import { parseEnvelope, type NotificationPayload, type Envelope } from '@nipopeto/contracts';
import {currentRequestId} from '@nipopeto/runtime';

// P2 proof adapter; future Clinic domains pass the same transaction used for
// their appointment/medical mutation. No Core client or domain repository here.
export async function writeNotification(tx: Pick<Prisma.TransactionClient, 'outboxEvent'>, payload: Omit<NotificationPayload, 'notificationId'>) {
  const id = randomUUID(), notificationId = randomUUID(), occurredAt = new Date().toISOString();
  const event: Envelope = {
    eventId: id, eventType: 'notification.requested.v1', schemaVersion: 1, producer: 'clinic',
    aggregateType: 'notification', aggregateId: notificationId, aggregateVersion: 1,
    occurredAt, correlationId: currentRequestId()??id,
    payload: { ...payload, notificationId, createdAt: payload.createdAt ?? occurredAt, sentAt: payload.sentAt ?? occurredAt },
  };
  parseEnvelope(JSON.stringify(event));
  await tx.outboxEvent.create({ data: { id, envelope: event as unknown as Prisma.InputJsonValue } });
  return notificationId;
}
