import type { PrismaClient } from '../../../../services/clinic/src/generated/client/index.js';
import { consumes, parseEnvelope, type DirectoryEntry } from '@nipopeto/contracts';
import { billingOutcome } from '../../../../services/clinic/src/infrastructure/messaging/billingEvents.ts';
import { ClinicInbox, type ProjectionEntry } from '../../../../services/clinic/src/infrastructure/messaging/inbox.ts';

// Proof-only: billing events that name no appointment. The real ClinicInbox sends
// them to the dead-letter queue (UNSUPPORTED_EVENT); the P1 proof still finalizes
// its BillingReservation from them. Everything else goes to the real inbox.
export class ProofClinicInbox {
  private readonly real: ClinicInbox;
  constructor(
    private readonly db: PrismaClient,
    hydrate?: (kind: string, p: DirectoryEntry) => Promise<ProjectionEntry>,
  ) {
    this.real = new ClinicInbox(db, hydrate);
  }
  async apply(raw: string) {
    const event = parseEnvelope(raw);
    const billing = billingOutcome(event.eventType);
    const p = event.payload as Record<string, string>;
    if (!consumes('clinic', event.eventType) || !event.eventType.startsWith('billing.') || !billing || p.appointmentId)
      return this.real.apply(raw);
    if (
      await this.db.inboxEvent.findUnique({
        where: { consumerName_eventId: { consumerName: 'clinic-v1', eventId: event.eventId } },
      })
    )
      return false;
    return this.db.$transaction(async tx => {
      const inserted =
        await tx.$executeRaw`INSERT INTO "InboxEvent" ("consumerName","eventId","createdAt") VALUES ('clinic-v1',${event.eventId},now()) ON CONFLICT DO NOTHING`;
      if (!inserted) return false;
      const r = await tx.billingReservation.findUniqueOrThrow({ where: { operationId: p.operationId } });
      await tx.$queryRaw`SELECT id FROM "ProofAppointment" WHERE id = ${r.appointmentId} FOR UPDATE`;
      const current = await tx.billingReservation.findUniqueOrThrow({ where: { operationId: p.operationId } });
      const state = billing.reservation;
      if (
        current.state !== 'HELD' &&
        (current.state !== state || (state === 'INVOICED' && current.invoiceId !== p.invoiceId))
      )
        throw new Error('TERMINAL_CONFLICT');
      if (current.state === 'HELD')
        await tx.billingReservation.update({
          where: { operationId: p.operationId },
          data: { state, invoiceId: p.invoiceId },
        });
      return true;
    });
  }
}
