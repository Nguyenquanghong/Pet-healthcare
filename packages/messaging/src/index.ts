import amqp, { type ConfirmChannel, type Options } from 'amqplib';
import { consumes, parseEnvelope, type Envelope, type EventConsumer } from '@nipopeto/contracts';
// Transport metadata only. Untrusted non-UUID identifiers are never logged.
export function logEvent(service:string,event:Envelope,status:string,started=performance.now()){
  if(process.env.PHASE2_RUNTIME_REQUIRED!=='1')return;
  const id=(v:string)=>/^[0-9a-f-]{36}$/i.test(v)?v:'unknown';
  try{process.stdout.write(JSON.stringify({service,eventId:id(event.eventId),correlationId:id(event.correlationId),eventType:event.eventType,status,latencyMs:Math.round(performance.now()-started)})+'\n');}catch{}
}
export type ConsumerName = EventConsumer;
export const topology = (prefix = 'nipopeto.v1') => ({ exchange: `${prefix}.events`, notification: `${prefix}.notification`, identity: `${prefix}.identity`, clinic: `${prefix}.clinic`, clinicRead: `${prefix}.clinic-read-v1` });
export type Topology = ReturnType<typeof topology>;
export async function declareTopology(brokerUrl: string, t: Topology) {
  const connection = await amqp.connect(brokerUrl, { timeout: 5000 });
  connection.on('error', () => {});
  try {
    const channel = await connection.createChannel();
    await channel.assertExchange(t.exchange, 'topic', { durable: true });
    for (const consumer of ['notification', 'identity', 'clinic', 'clinicRead'] as const) {
      await channel.assertQueue(t[consumer], { durable: true });
      await channel.assertQueue(`${t[consumer]}.dlq`, { durable: true });
    }
    await channel.bindQueue(t.notification, t.exchange, 'notification.requested.v1');
    // P03: revocations have their own queue. Removing the old binding is a no-op once it is gone.
    await channel.unbindQueue(t.notification, t.exchange, 'identity.sessions-revoked.v1');
    await channel.bindQueue(t.identity, t.exchange, 'identity.sessions-revoked.v1');
    await channel.bindQueue(t.clinic, t.exchange, 'directory.#');
    await channel.bindQueue(t.clinic, t.exchange, 'billing.#');
    await channel.bindQueue(t.clinicRead, t.exchange, 'clinic.appointment-read-changed.v1');
  } finally { await connection.close(); }
}
// Confirm and mandatory-return detection are both required.
export function publishConfirmed(channel: ConfirmChannel, exchange: string, routingKey: string, content: Buffer, properties: Options.Publish = {}, timeoutMs = 5000) {
  return new Promise<void>((resolve, reject) => {
    let returned = false, settled = false;
    const onReturn = (message: amqp.Message) => { if (message.properties.messageId === properties.messageId) returned = true; };
    const onClose = () => finish(new Error('CHANNEL_CLOSED'));
    const timer = setTimeout(() => finish(new Error('CONFIRM_TIMEOUT')), timeoutMs);
    function finish(error?: Error | null) {
      if (settled) return;
      settled = true; clearTimeout(timer); channel.off('return', onReturn); channel.off('close', onClose);
      if (error) reject(error); else if (returned) reject(new Error('UNROUTABLE')); else resolve();
    }
    channel.on('return', onReturn); channel.once('close', onClose);
    try { channel.publish(exchange, routingKey, content, { ...properties, persistent: true, mandatory: true }, finish); }
    catch { finish(new Error('PUBLISH_FAILED')); }
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
  constructor(private readonly brokerUrl: string, private readonly service: string, readonly persistent = false) {}
  get connection() { return this.model; }
  private async confirmChannel() {
    if (this.channel) return this.channel;
    const connection = await amqp.connect(this.brokerUrl, { timeout: 5000 });
    connection.on('error', () => {});
    try {
      const channel = await connection.createConfirmChannel();
      channel.on('error', () => {});
      // A closed channel or connection is never reused; the next call reconnects.
      const drop = () => { if (this.model === connection) { this.model = undefined; this.channel = undefined; } };
      channel.once('close', drop); connection.once('close', drop);
      this.model = connection; this.channel = channel;
      return channel;
    } catch (error) { await connection.close().catch(() => {}); throw error; }
  }
  async publish(rows: OutboxMessage[], destination: string | Topology, started = performance.now()): Promise<BatchResult> {
    const confirmed: string[] = [], failed: string[] = [];
    let error: unknown;
    try {
      const channel = await this.confirmChannel();
      // Publish in claim order on one channel, then await every confirm/return.
      const results = await Promise.allSettled(rows.map(async row => {
        const raw = JSON.stringify(row.envelope), event = parseEnvelope(raw);
        await publishConfirmed(channel, typeof destination === 'string' ? '' : destination.exchange, typeof destination === 'string' ? destination : event.eventType,
          Buffer.from(raw), { messageId: row.id, contentType: 'application/json' });
        logEvent(this.service, event, 'publish-confirmed', started);
      }));
      results.forEach((result, i) => { if (result.status === 'fulfilled') confirmed.push(rows[i]!.id); else { failed.push(rows[i]!.id); error ??= result.reason; } });
    } catch (caught) { failed.push(...rows.map(r => r.id)); error = caught; }
    if (failed.length || !this.persistent) await this.close();
    return failed.length ? { confirmed, failed, error } : { confirmed, failed };
  }
  async close() {
    const connection = this.model; this.model = undefined; this.channel = undefined;
    await connection?.close().catch(() => {});
  }
}
// ---- P03: retry without blocking the queue -----------------------------------------
// A failure retry can heal: a dependency not answering, a timeout, a lost connection.
export class TransientError extends Error { constructor(readonly code: string) { super(code); } }
// A failure no retry can heal: the same message fails the same way every time.
export class PermanentError extends Error { constructor(readonly code: string) { super(code); } }
export type FailureKind = 'transient' | 'permanent';
export type ClassifyFailure = (error: unknown) => FailureKind;
// Unknown failures are retried. Retrying a permanent one costs a few idempotent
// attempts inside the retry window and no longer blocks the queue; sending a transient
// one to the DLQ needs a manual replay. Each service names what is permanent.
export function permanentOn(codes: readonly string[], also: (error: unknown) => boolean = () => false): ClassifyFailure {
  return error => error instanceof PermanentError || (error instanceof Error && codes.includes(error.message)) || also(error) ? 'permanent' : 'transient';
}
export const defaultClassify = permanentOn([]);
// The code written to the p2-error-code header: an UPPER_CASE code (Prisma's P2002,
// ECONNREFUSED included), never free text that could carry data.
export function failureCode(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : 'PROCESSING_FAILED';
}
// The delay before each retry. Default 1 s, 5 s, 30 s, 2 min, 10 min: about 12.6 minutes,
// enough for a restart or deploy of a service or the database, before the DLQ.
export const defaultRetryDelaysMs = [1000, 5000, 30000, 120000, 600000] as const;
export function retryDelays(raw = process.env.BROKER_RETRY_DELAYS_MS): number[] {
  if (raw === undefined || raw === '') return [...defaultRetryDelaysMs];
  const delays = raw.split(',').map(Number);
  if (delays.length > 6 || delays.some((d, i) => !Number.isSafeInteger(d) || d < 1 || d > 3600000 || (i > 0 && d <= delays[i - 1]!))) throw new Error('INVALID_BROKER_RETRY_DELAYS');
  return delays;
}
// A retry queue holds a failed message for its delay, then dead-letters it back to the
// consumer queue through the default exchange. Nobody consumes it. The delay is in the
// name because a queue's TTL cannot change: another ladder declares other queues.
export const retryQueue = (queue: string, delayMs: number) => `${queue}.retry.${delayMs}ms`;
export function retryTarget(queue: string, attempt: number, kind: FailureKind, delays: readonly number[]) {
  const delay = kind === 'transient' ? delays[attempt] : undefined;
  return delay === undefined ? { queue: `${queue}.dlq`, delay: null } : { queue: retryQueue(queue, delay), delay };
}
// The queues a service's runtime reports in /metrics (queue_ready, retry_ready, dlq_ready).
export const runtimeQueues = (consumers: readonly ConsumerQueue[]) => ({ consumers, retrySuffixes: retryDelays().map(ms => retryQueue('', ms)) });
type ConsumerQueue = 'notification' | 'identity' | 'clinic' | 'clinic-read-v1';
export interface ConsumerOptions {
  // Delay before each retry; default BROKER_RETRY_DELAYS_MS, else defaultRetryDelaysMs.
  retryDelaysMs?: readonly number[];
  // Tests only: the former ladder of b and 2b ms (three attempts in all).
  retryBaseMs?: number;
  classify?: ClassifyFailure;
  // Test callbacks only; never exposed by HTTP/environment variables.
  afterCommit?: () => void | Promise<void>;
  beforeRepublish?: () => void | Promise<void>;
  afterRepublishConfirm?: () => void | Promise<void>;
}
export async function consumeEvents(brokerUrl: string, queue: string, consumerName: ConsumerName, apply: (raw: string) => Promise<unknown>, options: ConsumerOptions = {}) {
  // Validated before connecting: a bad ladder fails the start, not the first retry.
  const delays = options.retryDelaysMs ? retryDelays(options.retryDelaysMs.join(',')) : options.retryBaseMs !== undefined ? retryDelays(`${options.retryBaseMs},${options.retryBaseMs * 2}`) : retryDelays();
  const classify = options.classify ?? defaultClassify;
  const connection = await amqp.connect(brokerUrl, { timeout: 5000 });
  connection.on('error', () => {});
  const channel = await connection.createConfirmChannel().catch(async error => { await connection.close().catch(() => {}); throw error; });
  channel.on('error', () => {});
  const done = new Promise<void>(resolve => connection.once('close', resolve));
  let closing = false, disconnected = false;
  channel.once('close', () => { disconnected = true; if (!closing) void connection.close().catch(() => {}); });
  const pending = new Set<Promise<void>>();
  const terminate = async () => {
    closing = true;
    await channel.close().catch(() => {});
    await connection.close().catch(() => {});
  };
  try {
    await channel.assertQueue(queue, { durable: true });
    await channel.assertQueue(`${queue}.dlq`, { durable: true });
    for (const delay of delays) await channel.assertQueue(retryQueue(queue, delay), { durable: true, messageTtl: delay, deadLetterExchange: '', deadLetterRoutingKey: queue });
    await channel.prefetch(1);
  } catch (error) { await terminate(); throw error; }
  async function handle(message: amqp.ConsumeMessage) {
    const started=performance.now();let observed:Envelope|undefined;
    let valid = false, reason = 'INVALID_EVENT', failure: FailureKind = 'permanent';
    try {
      const event = parseEnvelope(message.content.toString('utf8'));
      observed=event;
      valid = consumes(consumerName, event.eventType);
      if (!valid) reason = 'UNSUPPORTED_EVENT';
    } catch {}
    if (valid) {
      try {
        const applied=await apply(message.content.toString('utf8'));
        logEvent(consumerName,observed!,applied===false?'effect-duplicate':'effect-committed',started);
        try { await options.afterCommit?.(); } catch { await terminate(); return; }
        if (!disconnected){channel.ack(message);logEvent(consumerName,observed!,'acknowledged',started);}
        return;
      } catch (error) {
        reason = failureCode(error);
        try { failure = classify(error); } catch { failure = 'transient'; }
      }
    }
    const header = message.properties.headers?.['p2-attempt'];
    const attempt = Number.isSafeInteger(header) && header >= 0 ? header as number : 0;
    // The message waits in a retry queue, not in this handler: the next message runs now.
    const target = retryTarget(queue, attempt, failure, delays);
    try {
      if (disconnected) return;
      await options.beforeRepublish?.();
      await publishConfirmed(channel, '', target.queue, message.content, { ...message.properties, headers: { ...message.properties.headers, 'p2-attempt': attempt + 1, 'p2-error-code': reason, 'p2-failure': failure } });
      if(observed)logEvent(consumerName,observed,target.delay===null?'dlq-confirmed':'retry-confirmed',started);
      await options.afterRepublishConfirm?.();
      if (!disconnected) channel.ack(message);
    } catch { await terminate(); } // original remains unacknowledged
  }
  const result = await channel.consume(queue, message => {
    if (!message) { void terminate(); return; }
    const work = handle(message).catch(() => terminate()).finally(() => pending.delete(work));
    pending.add(work);
  });
  return { done, channel, connection, close: async () => {
    if (closing) { await done; return; }
    closing = true;
    if (!disconnected) await channel.cancel(result.consumerTag).catch(() => {});
    await Promise.allSettled([...pending]);
    await terminate();
  } };
}
// Explicit one-event replay; no queue-wide drain and eventId remains unchanged.
export async function replayEvent(brokerUrl: string, queue: string, eventId: string) {
  const connection = await amqp.connect(brokerUrl, { timeout: 5000 });
  connection.on('error', () => {});
  try {
    const channel = await connection.createConfirmChannel();
    channel.on('error', () => {});
    const message = await channel.get(`${queue}.dlq`, { noAck: false });
    if (!message) return false;
    const event = parseEnvelope(message.content.toString('utf8'));
    if (event.eventId !== eventId) throw new Error('REQUESTED_EVENT_NOT_AT_HEAD');
    await publishConfirmed(channel, '', queue, message.content, { ...message.properties, headers: { ...message.properties.headers, 'p2-attempt': 0 } });
    channel.ack(message);
    await delay(100); // fixed local replay admission, at most one selected event
    return { eventId, queue, status: 'replayed' };
  } finally { await connection.close(); }
}
// P03: replay up to max DLQ messages in order, eventIds unchanged and p2-attempt reset.
// Stops, leaving the message at the head of the DLQ, at one that is not a valid event
// (it would only come back) or at an eventId already replayed by this call (it failed
// again meanwhile, so replaying further would loop).
export async function replayAll(brokerUrl: string, queue: string, max: number) {
  if (!Number.isSafeInteger(max) || max < 1 || max > 10000) throw new Error('INVALID_REPLAY_MAX');
  const connection = await amqp.connect(brokerUrl, { timeout: 5000 });
  connection.on('error', () => {});
  const replayed = new Set<string>();
  let stopped: 'max' | 'empty' | 'invalid' | 'repeat' = 'max';
  try {
    const channel = await connection.createConfirmChannel();
    channel.on('error', () => {});
    while (replayed.size < max) {
      const message = await channel.get(`${queue}.dlq`, { noAck: false });
      if (!message) { stopped = 'empty'; break; }
      let eventId: string;
      try { eventId = parseEnvelope(message.content.toString('utf8')).eventId; } catch { channel.nack(message, false, true); stopped = 'invalid'; break; }
      if (replayed.has(eventId)) { channel.nack(message, false, true); stopped = 'repeat'; break; }
      await publishConfirmed(channel, '', queue, message.content, { ...message.properties, headers: { ...message.properties.headers, 'p2-attempt': 0 } });
      channel.ack(message); replayed.add(eventId);
      await delay(20); // fixed admission: at most 50 replayed events per second
    }
    return { queue, replayed: [...replayed], stopped };
  } finally { await connection.close(); }
}
export function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
export async function reconnect(service: string, signal: AbortSignal, run: () => Promise<void>) {
  while (!signal.aborted) {
    try { await run(); }
    catch { if (!signal.aborted) process.stderr.write(JSON.stringify({ service, code: 'WORKER_RETRY' }) + '\n'); }
    await delay(1000, signal);
  }
}
export async function startWorker(service: string, work: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  let deadline:ReturnType<typeof setTimeout>|undefined;
  const stop = () => { if(controller.signal.aborted)return;controller.abort();deadline=setTimeout(() => process.exit(1), 10000);deadline.unref(); };
  const parentStop=(message:unknown)=>{if(message&&typeof message==='object'&&'type'in message&&message.type==='shutdown')stop();};
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.on('message',parentStop);
  try { await work(controller.signal); }
  catch { process.stderr.write(JSON.stringify({ service, code: 'WORKER_START_FAILED' }) + '\n'); process.exitCode = 1; }
  finally { if(deadline)clearTimeout(deadline);process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);process.removeListener('message',parentStop);if(process.connected)process.disconnect(); }
}
export function requireBrokerConfig() {
  if (!process.env.BROKER_URL) throw new Error('BROKER_URL_REQUIRED');
  const prefix = process.env.BROKER_PREFIX || 'nipopeto.v1';
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(prefix)) throw new Error('INVALID_BROKER_PREFIX');
  return { brokerUrl: process.env.BROKER_URL, topology: topology(prefix) };
}
