import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../generated/phase2-core/index.js';
import { ConfirmPublisher, type Topology } from '@nipopeto/messaging';
type Claimed = { id: string; envelope: unknown; attempts: number };
// batchSize/persistent default to the original one-event, one-connection relay;
// the runtime notification worker enables both (same fix as the Clinic relay,
// list study v1 K3-F1). Batches need a store with claimBatch.
export type RelayOptions = { batchSize?: number; persistent?: boolean };
export class OutboxRelay {
  private readonly store: OutboxStore;
  private readonly publisher: ConfirmPublisher;
  private readonly batchSize: number;
  // createdAfter (ISO instant) is a guarded-test scope like scopeAggregateId: a
  // run relays only its own rows from a shared trial schema.
  constructor(
    db: PrismaClient | OutboxStore,
    brokerUrl: string,
    private readonly scopeAggregateId?: string,
    private readonly createdAfter?: string,
    options: RelayOptions = {},
  ) {
    this.store = 'claim' in db ? db : new ProofOutboxStore(db);
    this.batchSize = options.batchSize ?? 1;
    if (
      !Number.isSafeInteger(this.batchSize) ||
      this.batchSize < 1 ||
      this.batchSize > 500 ||
      (this.batchSize > 1 && !this.store.claimBatch)
    )
      throw new Error('INVALID_RELAY_BATCH');
    this.publisher = new ConfirmPublisher(brokerUrl, 'core-relay', options.persistent ?? false);
  }
  get connection() {
    return this.publisher.connection;
  }
  close() {
    return this.publisher.close();
  }
  private async claim(leaseOwner: string): Promise<Claimed[]> {
    const scope = this.scopeAggregateId ?? null,
      after = this.createdAfter ?? null;
    if (this.batchSize > 1) return this.store.claimBatch!(leaseOwner, scope, after, this.batchSize);
    const one = await this.store.claim(leaseOwner, scope, after);
    return one ? [one] : [];
  }
  async once(workerId: string, destination: string | Topology, afterConfirm?: () => void) {
    const started = performance.now();
    const leaseOwner = `${workerId}:${randomUUID()}`;
    const claimed = await this.claim(leaseOwner);
    if (!claimed.length) return false;
    const { confirmed, failed, error } = await this.publisher.publish(claimed, destination, started);
    if (confirmed.length) {
      afterConfirm?.();
      for (const id of confirmed) await this.store.markPublished(id, leaseOwner);
    }
    if (failed.length) {
      if (!afterConfirm)
        for (const row of claimed.filter(r => failed.includes(r.id)))
          await this.store.retry(
            row.id,
            leaseOwner,
            new Date(Date.now() + Math.min(60000, 1000 * 2 ** Math.min(row.attempts, 6))),
          );
      throw error;
    }
    return true;
  }
}
export interface OutboxStore {
  claim(leaseOwner: string, scope: string | null, createdAfter?: string | null): Promise<Claimed | null>;
  claimBatch?(leaseOwner: string, scope: string | null, createdAfter: string | null, limit: number): Promise<Claimed[]>;
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
