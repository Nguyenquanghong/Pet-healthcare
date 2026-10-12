import amqp from 'amqplib';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../generated/phase2-core/index.js';
import { parseEnvelope } from '@nipopeto/contracts';
import { publishConfirmed, logEvent, type Topology } from '@nipopeto/messaging';
export class OutboxRelay {
  private readonly store: OutboxStore;
  constructor(db: PrismaClient | OutboxStore, private readonly brokerUrl: string, private readonly scopeAggregateId?: string) {
    this.store = 'claim' in db ? db : new ProofOutboxStore(db);
  }
  async once(workerId: string, destination: string | Topology, afterConfirm?: () => void) {
    const started=performance.now();
    const leaseOwner = `${workerId}:${randomUUID()}`;
    const claimed = await this.store.claim(leaseOwner, this.scopeAggregateId ?? null);
    if (!claimed) return false;
    let connection: amqp.ChannelModel | undefined;
    try {
      const raw = JSON.stringify(claimed.envelope), event = parseEnvelope(raw);
      connection = await amqp.connect(this.brokerUrl, { timeout: 5000 });
      connection.on('error', () => {});
      const channel = await connection.createConfirmChannel();
      channel.on('error', () => {});
      await publishConfirmed(channel, typeof destination === 'string' ? '' : destination.exchange, typeof destination === 'string' ? destination : event.eventType, Buffer.from(raw), { messageId: claimed.id, contentType: 'application/json' });
      logEvent('core-relay',event,'publish-confirmed',started);
      afterConfirm?.();
      await this.store.markPublished(claimed.id, leaseOwner);
      return true;
    } catch (error) {
      if (!afterConfirm) await this.store.retry(claimed.id, leaseOwner, new Date(Date.now() + Math.min(60000, 1000 * 2 ** Math.min(claimed.attempts, 6))));
      throw error;
    } finally { await connection?.close().catch(() => {}); }
  }
}
export interface OutboxStore {
  claim(leaseOwner: string, scope: string | null): Promise<{ id: string; envelope: unknown; attempts: number } | null>;
  markPublished(id: string, leaseOwner: string): Promise<void>;
  retry(id: string, leaseOwner: string, nextAttemptAt: Date): Promise<void>;
}
class ProofOutboxStore implements OutboxStore {
  constructor(private readonly db: PrismaClient) {}
  claim(leaseOwner: string, scope: string | null) {
    return this.db.$transaction(async tx => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "OutboxEvent" WHERE "publishedAt" IS NULL AND "nextAttemptAt" <= now() AND ("leaseUntil" IS NULL OR "leaseUntil" < now()) AND (${scope}::text IS NULL OR envelope->>'aggregateId' = ${scope}) ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!rows[0]) return null;
      return tx.outboxEvent.update({ where: { id: rows[0].id }, data: { leaseOwner, leaseUntil: new Date(Date.now() + 30000), attempts: { increment: 1 } } });
    });
  }
  async markPublished(id: string, leaseOwner: string) {
    await this.db.outboxEvent.updateMany({ where: { id, leaseOwner, leaseUntil: { gt: new Date() } }, data: { publishedAt: new Date(), leaseOwner: null, leaseUntil: null, lastErrorCode: null } });
  }
  async retry(id: string, leaseOwner: string, nextAttemptAt: Date) {
    await this.db.outboxEvent.updateMany({ where: { id, leaseOwner }, data: { leaseOwner: null, leaseUntil: null, nextAttemptAt, lastErrorCode: 'DELIVERY_UNCONFIRMED' } });
  }
}
