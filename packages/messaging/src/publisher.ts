import amqp, { type ConfirmChannel, type Options } from 'amqplib';
import { parseEnvelope } from '@nipopeto/contracts';
import { logEvent } from './eventLog.js';
import { type Topology } from './topology.js';
// Confirm and mandatory-return detection are both required.
export function publishConfirmed(
  channel: ConfirmChannel,
  exchange: string,
  routingKey: string,
  content: Buffer,
  properties: Options.Publish = {},
  timeoutMs = 5000,
) {
  return new Promise<void>((resolve, reject) => {
    let returned = false,
      settled = false;
    const onReturn = (message: amqp.Message) => {
      if (message.properties.messageId === properties.messageId) returned = true;
    };
    const onClose = () => finish(new Error('CHANNEL_CLOSED'));
    const timer = setTimeout(() => finish(new Error('CONFIRM_TIMEOUT')), timeoutMs);
    function finish(error?: Error | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.off('return', onReturn);
      channel.off('close', onClose);
      if (error) reject(error);
      else if (returned) reject(new Error('UNROUTABLE'));
      else resolve();
    }
    channel.on('return', onReturn);
    channel.once('close', onClose);
    try {
      channel.publish(exchange, routingKey, content, { ...properties, persistent: true, mandatory: true }, finish);
    } catch {
      finish(new Error('PUBLISH_FAILED'));
    }
  });
}
export type OutboxMessage = { id: string; envelope: unknown };
export type BatchResult = { confirmed: string[]; failed: string[]; error?: unknown };
// Publishes a batch of outbox rows over one confirm channel. Each row is still
// parsed, sent persistent+mandatory and confirmed on its own; a failed row never
// fails its neighbours. A fresh connection per event capped relays near
// 11 events/s (list study v1 K3-F1). persistent=false closes after every batch
// (original behaviour); any failure drops the connection so the next batch reconnects.
export class ConfirmPublisher {
  private model: amqp.ChannelModel | undefined;
  private channel: ConfirmChannel | undefined;
  constructor(
    private readonly brokerUrl: string,
    private readonly service: string,
    readonly persistent = false,
  ) {}
  get connection() {
    return this.model;
  }
  private async confirmChannel() {
    if (this.channel) return this.channel;
    const connection = await amqp.connect(this.brokerUrl, { timeout: 5000 });
    connection.on('error', () => {});
    try {
      const channel = await connection.createConfirmChannel();
      channel.on('error', () => {});
      // A closed channel or connection is never reused; the next call reconnects.
      const drop = () => {
        if (this.model === connection) {
          this.model = undefined;
          this.channel = undefined;
        }
      };
      channel.once('close', drop);
      connection.once('close', drop);
      this.model = connection;
      this.channel = channel;
      return channel;
    } catch (error) {
      await connection.close().catch(() => {});
      throw error;
    }
  }
  async publish(
    rows: OutboxMessage[],
    destination: string | Topology,
    started = performance.now(),
  ): Promise<BatchResult> {
    const confirmed: string[] = [],
      failed: string[] = [];
    let error: unknown;
    try {
      const channel = await this.confirmChannel();
      // Publish in claim order on one channel, then await every confirm/return.
      const results = await Promise.allSettled(
        rows.map(async row => {
          const raw = JSON.stringify(row.envelope),
            event = parseEnvelope(raw);
          await publishConfirmed(
            channel,
            typeof destination === 'string' ? '' : destination.exchange,
            typeof destination === 'string' ? destination : event.eventType,
            Buffer.from(raw),
            { messageId: row.id, contentType: 'application/json' },
          );
          logEvent(this.service, event, 'publish-confirmed', started);
        }),
      );
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') confirmed.push(rows[i]!.id);
        else {
          failed.push(rows[i]!.id);
          error ??= result.reason;
        }
      });
    } catch (caught) {
      failed.push(...rows.map(r => r.id));
      error = caught;
    }
    if (failed.length || !this.persistent) await this.close();
    return failed.length ? { confirmed, failed, error } : { confirmed, failed };
  }
  async close() {
    const connection = this.model;
    this.model = undefined;
    this.channel = undefined;
    await connection?.close().catch(() => {});
  }
}
