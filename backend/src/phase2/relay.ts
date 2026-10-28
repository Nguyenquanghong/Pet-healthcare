import type { PrismaClient } from '../generated/phase2-core/index.js';
import { BaseOutboxRelay, type ClaimedOutbox, type OutboxRelayStore, type RelayOptions } from '@nipopeto/messaging';
export type { RelayOptions };
// Batches need a store with claimBatch. The loop is shared with Clinic in @nipopeto/messaging.
class CoreRelayStore implements OutboxRelayStore {
  constructor(
    private readonly store: OutboxStore,
    private readonly scope: string | null,
    private readonly createdAfter: string | null,
  ) {}
  async claim(leaseOwner: string, limit: number): Promise<ClaimedOutbox[]> {
    if (limit > 1) return this.store.claimBatch!(leaseOwner, this.scope, this.createdAfter, limit);
    const one = await this.store.claim(leaseOwner, this.scope, this.createdAfter);
    return one ? [one] : [];
  }
  async markPublished(ids: string[], leaseOwner: string) {
    for (const id of ids) await this.store.markPublished(id, leaseOwner);
  }
  retry(id: string, leaseOwner: string, nextAttemptAt: Date) {
    return this.store.retry(id, leaseOwner, nextAttemptAt);
  }
}
export class OutboxRelay extends BaseOutboxRelay {
  // createdAfter (ISO instant) is a guarded-test scope like scopeAggregateId: a
  // run relays only its own rows from a shared trial schema.
  constructor(
    db: PrismaClient | OutboxStore,
    brokerUrl: string,
    scopeAggregateId?: string,
    createdAfter?: string,
    options: RelayOptions = {},
  ) {
    const store: OutboxStore = 'claim' in db ? db : new ProofOutboxStore(db);
    if ((options.batchSize ?? 1) > 1 && !store.claimBatch) throw new Error('INVALID_RELAY_BATCH');
    super(new CoreRelayStore(store, scopeAggregateId ?? null, createdAfter ?? null), brokerUrl, 'core-relay', options);
  }
}
export interface OutboxStore {
  claim(leaseOwner: string, scope: string | null, createdAfter?: string | null): Promise<ClaimedOutbox | null>;
  claimBatch?(
    leaseOwner: string,
    scope: string | null,
    createdAfter: string | null,
    limit: number,
  ): Promise<ClaimedOutbox[]>;
  markPublished(id: string, leaseOwner: string): Promise<void>;
  retry(id: string, leaseOwner: string, nextAttemptAt: Date): Promise<void>;
}
class ProofOutboxStore implements OutboxStore {
  constructor(private readonly db: PrismaClient) {}
  claim(leaseOwner: string, scope: string | null, createdAfter: string | null = null) {
    return this.db.$transaction(async tx => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "OutboxEvent" WHERE "publishedAt" IS NULL AND "nextAttemptAt" <= now() AND ("leaseUntil" IS NULL OR "leaseUntil" < now()) AND (${scope}::text IS NULL OR envelope->>'aggregateId' = ${scope}) AND (${createdAfter}::text IS NULL OR "createdAt" >= (${createdAfter}::timestamptz AT TIME ZONE 'UTC')) ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!rows[0]) return null;
      return tx.outboxEvent.update({
        where: { id: rows[0].id },
        data: { leaseOwner, leaseUntil: new Date(Date.now() + 30000), attempts: { increment: 1 } },
      });
    });
  }
  async markPublished(id: string, leaseOwner: string) {
    await this.db.outboxEvent.updateMany({
      where: { id, leaseOwner, leaseUntil: { gt: new Date() } },
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
