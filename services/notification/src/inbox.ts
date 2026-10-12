import type { PrismaClient } from './generated/client/index.js';
import { parseEnvelope, type NotificationPayload } from '@nipopeto/contracts';
export class NotificationInbox {
  constructor(private readonly db: PrismaClient) {}
  async apply(raw: string, fault?: () => void) {
    const event = parseEnvelope(raw);
    if (event.eventType !== 'notification.requested.v1') throw new Error('UNSUPPORTED_EVENT');
    return this.db.$transaction(async tx => {
      const inserted = await tx.$executeRaw`INSERT INTO "InboxEvent" ("consumerName","eventId","createdAt") VALUES ('notification-v1',${event.eventId},now()) ON CONFLICT DO NOTHING`;
      if (!inserted) return false;
      const p = event.payload as unknown as NotificationPayload;
      await tx.notification.create({ data: {
        id: p.notificationId, recipientOwnerId: p.recipientOwnerId, recipientRole: p.recipientRole ?? 'owner',
        type: p.type ?? 'general', title: p.title, message: p.message, status: p.status ?? 'sent',
        actionUrl: p.actionUrl, relatedPetId: p.relatedPetId, relatedAppointmentId: p.relatedAppointmentId,
        relatedBookingId: p.relatedBookingId, sentByStaffId: p.sentByStaffId,
        createdAt: new Date(p.createdAt ?? event.occurredAt), sentAt: new Date(p.sentAt ?? event.occurredAt),
      } });
      fault?.();
      return true;
    });
  }
}
