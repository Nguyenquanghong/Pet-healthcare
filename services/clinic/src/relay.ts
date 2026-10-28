import type { PrismaClient } from './generated/client/index.js';
import { BaseOutboxRelay, type ClaimedOutbox, type OutboxRelayStore, type RelayOptions } from '@nipopeto/messaging';
export type { RelayOptions };
// The only event Clinic writes now is notification.requested.v1; batching still saves the
// connection per event. The loop is shared with Core in @nipopeto/messaging.
class ClinicOutboxStore implements OutboxRelayStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly scope: string | null,
  ) {}
  claim(leaseOwner: string, limit: number) {
    const scope = this.scope;
    return this.db.$transaction(async tx => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "OutboxEvent" WHERE "publishedAt" IS NULL AND "nextAttemptAt" <= now() AND ("leaseUntil" IS NULL OR "leaseUntil" < now()) AND (${scope}::text IS NULL OR envelope->>'aggregateId' = ${scope}) ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT ${limit}`;
      if (!rows[0]) return [] as ClaimedOutbox[];
      const ids = rows.map(r => r.id);
      await tx.outboxEvent.updateMany({
        where: { id: { in: ids } },
        data: { leaseOwner, leaseUntil: new Date(Date.now() + 30000), attempts: { increment: 1 } },
      });
      const leased = await tx.outboxEvent.findMany({
        where: { id: { in: ids } },
        select: { id: true, envelope: true, attempts: true },
      });
      const byId = new Map(leased.map(r => [r.id, r]));
      return ids.map(id => byId.get(id)!);
    });
  }
  async markPublished(ids: string[], leaseOwner: string) {
    await this.db.outboxEvent.updateMany({
      where: { id: { in: ids }, leaseOwner, leaseUntil: { gt: new Date() } },
      data: { publishedAt: new Date(), leaseOwner: null, leaseUntil: null, lastErrorCode: null },
    });
  }
  async retry(id: string, leaseOwner: string, nextAttemptAt: Date) {
    await this.db.outboxEvent.updateMany({
      where: { id, leaseOwner },
      data: { leaseOwner: null, leaseUntil: null, nextAttemptAt, lastErrorCode: 'DELIVERY_UNCONFIRMED' },
    });
  }
}
export class OutboxRelay extends BaseOutboxRelay {
  constructor(db: PrismaClient, brokerUrl: string, scopeAggregateId?: string, options: RelayOptions = {}) {
    super(new ClinicOutboxStore(db, scopeAggregateId ?? null), brokerUrl, 'clinic-relay', options);
  }
}
