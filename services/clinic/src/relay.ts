import { randomUUID } from 'node:crypto';
import type { PrismaClient } from './generated/client/index.js';
import { ConfirmPublisher, type Topology } from '@nipopeto/messaging';
// batchSize/persistent default to the original one-event, one-connection relay.
// The worker enables both: a fresh AMQP connection per event capped the relay near
// 11 events/s (list study K3-F1, when each appointment write also stored a read-changed
// event for the CQRS projection that has since been removed). The only event Clinic
// writes now is notification.requested.v1; batching still saves the connection per event.
export type RelayOptions = { batchSize?: number; persistent?: boolean };
type Claimed = { id: string; envelope: unknown; attempts: number };
export class OutboxRelay {
  private readonly publisher: ConfirmPublisher;
  private readonly batchSize: number;
  constructor(
    private readonly db: PrismaClient,
    brokerUrl: string,
    private readonly scopeAggregateId?: string,
    options: RelayOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 1;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 500)
      throw new Error('INVALID_RELAY_BATCH');
    this.publisher = new ConfirmPublisher(brokerUrl, 'clinic-relay', options.persistent ?? false);
  }
  get connection() {
    return this.publisher.connection;
  }
  close() {
    return this.publisher.close();
  }
  async once(workerId: string, destination: string | Topology, afterConfirm?: () => void) {
    const started = performance.now();
    const leaseOwner = `${workerId}:${randomUUID()}`;
    const scope = this.scopeAggregateId ?? null;
    const claimed = await this.db.$transaction(async tx => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "OutboxEvent" WHERE "publishedAt" IS NULL AND "nextAttemptAt" <= now() AND ("leaseUntil" IS NULL OR "leaseUntil" < now()) AND (${scope}::text IS NULL OR envelope->>'aggregateId' = ${scope}) ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT ${this.batchSize}`;
      if (!rows[0]) return [] as Claimed[];
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
    if (!claimed.length) return false;
    const { confirmed, failed, error } = await this.publisher.publish(claimed, destination, started);
    if (confirmed.length) {
      afterConfirm?.();
      await this.db.outboxEvent.updateMany({
        where: { id: { in: confirmed }, leaseOwner, leaseUntil: { gt: new Date() } },
        data: { publishedAt: new Date(), leaseOwner: null, leaseUntil: null, lastErrorCode: null },
      });
    }
    if (failed.length) {
      if (!afterConfirm)
        for (const row of claimed.filter(r => failed.includes(r.id)))
          await this.db.outboxEvent.updateMany({
            where: { id: row.id, leaseOwner },
            data: {
              leaseOwner: null,
              leaseUntil: null,
              nextAttemptAt: new Date(Date.now() + Math.min(60000, 1000 * 2 ** Math.min(row.attempts, 6))),
              lastErrorCode: 'DELIVERY_UNCONFIRMED',
            },
          });
      throw error;
    }
    return true;
  }
}
