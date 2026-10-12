import amqp from 'amqplib';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from './generated/client/index.js';
import { parseEnvelope } from '@nipopeto/contracts';
import { publishConfirmed, logEvent, type Topology } from '@nipopeto/messaging';
export class OutboxRelay {
  constructor(private readonly db: PrismaClient, private readonly brokerUrl: string, private readonly scopeAggregateId?: string) {}
  async once(workerId: string, destination: string | Topology, afterConfirm?: () => void) {
    const started=performance.now();
    const leaseOwner = `${workerId}:${randomUUID()}`;
    const scope = this.scopeAggregateId ?? null;
    const claimed = await this.db.$transaction(async tx => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "OutboxEvent" WHERE "publishedAt" IS NULL AND "nextAttemptAt" <= now() AND ("leaseUntil" IS NULL OR "leaseUntil" < now()) AND (${scope}::text IS NULL OR envelope->>'aggregateId' = ${scope}) ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!rows[0]) return null;
      return tx.outboxEvent.update({ where: { id: rows[0].id }, data: { leaseOwner, leaseUntil: new Date(Date.now() + 30000), attempts: { increment: 1 } } });
    });
    if (!claimed) return false;
    let connection: amqp.ChannelModel | undefined;
    try {
      const raw = JSON.stringify(claimed.envelope), event = parseEnvelope(raw);
      connection = await amqp.connect(this.brokerUrl, { timeout: 5000 });
      connection.on('error', () => {});
      const channel = await connection.createConfirmChannel();
      channel.on('error', () => {});
      await publishConfirmed(channel, typeof destination === 'string' ? '' : destination.exchange, typeof destination === 'string' ? destination : event.eventType, Buffer.from(raw), { messageId: claimed.id, contentType: 'application/json' });
      logEvent('clinic-relay',event,'publish-confirmed',started);
      afterConfirm?.();
      await this.db.outboxEvent.updateMany({ where: { id: claimed.id, leaseOwner, leaseUntil: { gt: new Date() } }, data: { publishedAt: new Date(), leaseOwner: null, leaseUntil: null, lastErrorCode: null } });
      return true;
    } catch (error) {
      if (!afterConfirm) await this.db.outboxEvent.updateMany({ where: { id: claimed.id, leaseOwner }, data: { leaseOwner: null, leaseUntil: null, nextAttemptAt: new Date(Date.now() + Math.min(60000, 1000 * 2 ** Math.min(claimed.attempts, 6))), lastErrorCode: 'DELIVERY_UNCONFIRMED' } });
      throw error;
    } finally { await connection?.close().catch(() => {}); }
  }
}
