import amqp from 'amqplib';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from './generated/client/index.js';
import { parseEnvelope } from '@nipopeto/contracts';
import { publishConfirmed, logEvent, type Topology } from '@nipopeto/messaging';
// batchSize/persistent default to the original one-event, one-connection relay.
// The worker enables both: each appointment write stores two events, and a fresh
// AMQP connection per event capped the relay near 11 events/s (list study K3-F1).
export type RelayOptions = { batchSize?: number; persistent?: boolean };
type Claimed = { id: string; envelope: unknown; attempts: number };
export class OutboxRelay {
  private connection: amqp.ChannelModel | undefined;
  private channel: amqp.ConfirmChannel | undefined;
  private readonly batchSize: number;
  private readonly persistent: boolean;
  constructor(private readonly db: PrismaClient, private readonly brokerUrl: string, private readonly scopeAggregateId?: string, options: RelayOptions = {}) {
    this.batchSize = options.batchSize ?? 1; this.persistent = options.persistent ?? false;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 500) throw new Error('INVALID_RELAY_BATCH');
  }
  private async confirmChannel() {
    if (this.channel) return this.channel;
    const connection = await amqp.connect(this.brokerUrl, { timeout: 5000 });
    connection.on('error', () => {});
    try {
      const channel = await connection.createConfirmChannel();
      channel.on('error', () => {});
      // A closed channel or connection is never reused; the next call reconnects.
      const drop = () => { if (this.connection === connection) { this.connection = undefined; this.channel = undefined; } };
      channel.once('close', drop); connection.once('close', drop);
      this.connection = connection; this.channel = channel;
      return channel;
    } catch (error) { await connection.close().catch(() => {}); throw error; }
  }
  async close() {
    const connection = this.connection; this.connection = undefined; this.channel = undefined;
    await connection?.close().catch(() => {});
  }
  async once(workerId: string, destination: string | Topology, afterConfirm?: () => void) {
    const started=performance.now();
    const leaseOwner = `${workerId}:${randomUUID()}`;
    const scope = this.scopeAggregateId ?? null;
    const claimed = await this.db.$transaction(async tx => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "OutboxEvent" WHERE "publishedAt" IS NULL AND "nextAttemptAt" <= now() AND ("leaseUntil" IS NULL OR "leaseUntil" < now()) AND (${scope}::text IS NULL OR envelope->>'aggregateId' = ${scope}) ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT ${this.batchSize}`;
      if (!rows[0]) return [] as Claimed[];
      const ids = rows.map(r => r.id);
      await tx.outboxEvent.updateMany({ where: { id: { in: ids } }, data: { leaseOwner, leaseUntil: new Date(Date.now() + 30000), attempts: { increment: 1 } } });
      const leased = await tx.outboxEvent.findMany({ where: { id: { in: ids } }, select: { id: true, envelope: true, attempts: true } });
      const byId = new Map(leased.map(r => [r.id, r]));
      return ids.map(id => byId.get(id)!);
    });
    if (!claimed.length) return false;
    const confirmed: string[] = [], failed: Claimed[] = [];
    let firstError: unknown;
    try {
      const channel = await this.confirmChannel();
      // Publish in claim order on one channel, then await every confirm/return.
      // Per-row async keeps one invalid envelope from failing the whole batch.
      const results = await Promise.allSettled(claimed.map(async row => {
        const raw = JSON.stringify(row.envelope), event = parseEnvelope(raw);
        return await publishConfirmed(channel, typeof destination === 'string' ? '' : destination.exchange, typeof destination === 'string' ? destination : event.eventType, Buffer.from(raw), { messageId: row.id, contentType: 'application/json' })
          .then(() => logEvent('clinic-relay',event,'publish-confirmed',started));
      }));
      results.forEach((result, i) => { if (result.status === 'fulfilled') confirmed.push(claimed[i]!.id); else { failed.push(claimed[i]!); firstError ??= result.reason; } });
    } catch (error) { failed.push(...claimed); firstError = error; }
    try {
      if (confirmed.length) {
        afterConfirm?.();
        await this.db.outboxEvent.updateMany({ where: { id: { in: confirmed }, leaseOwner, leaseUntil: { gt: new Date() } }, data: { publishedAt: new Date(), leaseOwner: null, leaseUntil: null, lastErrorCode: null } });
      }
      if (failed.length) {
        if (!afterConfirm) for (const row of failed) await this.db.outboxEvent.updateMany({ where: { id: row.id, leaseOwner }, data: { leaseOwner: null, leaseUntil: null, nextAttemptAt: new Date(Date.now() + Math.min(60000, 1000 * 2 ** Math.min(row.attempts, 6))), lastErrorCode: 'DELIVERY_UNCONFIRMED' } });
        throw firstError;
      }
      return true;
    } finally { if (!this.persistent || failed.length) await this.close(); }
  }
}
