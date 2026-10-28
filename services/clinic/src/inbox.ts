import type { PrismaClient } from './generated/client/index.js';
import { consumes, parseEnvelope, type DirectoryEntry } from '@nipopeto/contracts';
import { applyBillingTerminal } from './runtimeBilling.js';
import { billingOutcome } from './billingEvents.js';
export type ProjectionEntry = DirectoryEntry & { email?: string | null; microchipId?: string | null };
export class ClinicInbox {
  constructor(
    private readonly db: PrismaClient,
    private readonly hydrate?: (kind: string, p: DirectoryEntry) => Promise<ProjectionEntry>,
  ) {}
  async apply(raw: string) {
    const event = parseEnvelope(raw);
    const billing = billingOutcome(event.eventType);
    if (!consumes('clinic', event.eventType) || (event.eventType.startsWith('billing.') && !billing))
      throw new Error('UNSUPPORTED_EVENT');
    // A committed inbox row already proves completion. Duplicate delivery must
    // not depend on Core being available again merely to ACK the same event.
    if (
      await this.db.inboxEvent.findUnique({
        where: { consumerName_eventId: { consumerName: 'clinic-v1', eventId: event.eventId } },
      })
    )
      return false;
    const kind = event.eventType.split('.')[1]!.replace('-upserted', '');
    const original = event.payload as unknown as DirectoryEntry;
    // Full search fields are fetched outside the SQL transaction. Wire events
    // remain small even when an existing name exceeds the message byte limit.
    const projection =
      event.eventType.startsWith('directory.') && this.hydrate && !original.deletedAt
        ? await this.hydrate(kind, original)
        : original;
    return this.db.$transaction(async tx => {
      const inserted =
        await tx.$executeRaw`INSERT INTO "InboxEvent" ("consumerName","eventId","createdAt") VALUES ('clinic-v1',${event.eventId},now()) ON CONFLICT DO NOTHING`;
      if (!inserted) return false;
      if (event.eventType.startsWith('directory.')) {
        const p = projection as ProjectionEntry;
        const deletedAt = p.deletedAt ? new Date(p.deletedAt) : null;
        await tx.$executeRaw`INSERT INTO "DirectoryProjection" (kind,id,"sourceVersion","displayName","ownerId",species,phone,breed,email,"microchipId","deletedAt") VALUES (${kind},${p.id},${p.sourceVersion},${p.displayName},${p.ownerId ?? null},${p.species ?? null},${p.phone ?? null},${p.breed ?? null},${p.email ?? null},${p.microchipId ?? null},${deletedAt})
          ON CONFLICT (kind,id) DO UPDATE SET "sourceVersion" = EXCLUDED."sourceVersion", "displayName" = EXCLUDED."displayName", "ownerId" = EXCLUDED."ownerId", species = EXCLUDED.species, phone=EXCLUDED.phone,breed=EXCLUDED.breed,email=EXCLUDED.email,"microchipId"=EXCLUDED."microchipId","updatedAt"=now(), "deletedAt" = EXCLUDED."deletedAt" WHERE "DirectoryProjection"."sourceVersion" < EXCLUDED."sourceVersion"`;
      } else {
        const p = event.payload as Record<string, string>;
        if (p.appointmentId) {
          await applyBillingTerminal(tx, p.operationId!, {
            state: billing!.terminal,
            appointmentId: p.appointmentId,
            invoiceId: p.invoiceId,
          });
          return true;
        }
        const r = await tx.billingReservation.findUniqueOrThrow({ where: { operationId: p.operationId } });
        await tx.$queryRaw`SELECT id FROM "ProofAppointment" WHERE id = ${r.appointmentId} FOR UPDATE`;
        const current = await tx.billingReservation.findUniqueOrThrow({ where: { operationId: p.operationId } });
        const state = billing!.reservation;
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
      }
      return true;
    });
  }
}
