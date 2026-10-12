import amqp, { type ConfirmChannel, type Options } from 'amqplib';
import { parseEnvelope, type Envelope } from '@nipopeto/contracts';
// Transport metadata only. Untrusted non-UUID identifiers are never logged.
export function logEvent(service:string,event:Envelope,status:string,started=performance.now()){
  if(process.env.PHASE2_RUNTIME_REQUIRED!=='1')return;
  const id=(v:string)=>/^[0-9a-f-]{36}$/i.test(v)?v:'unknown';
  try{process.stdout.write(JSON.stringify({service,eventId:id(event.eventId),correlationId:id(event.correlationId),eventType:event.eventType,status,latencyMs:Math.round(performance.now()-started)})+'\n');}catch{}
}
export type ConsumerName = 'notification' | 'clinic';
export const topology = (prefix = 'nipopeto.v1') => ({ exchange: `${prefix}.events`, notification: `${prefix}.notification`, clinic: `${prefix}.clinic` });
export type Topology = ReturnType<typeof topology>;
export async function declareTopology(brokerUrl: string, t: Topology) {
  const connection = await amqp.connect(brokerUrl, { timeout: 5000 });
  connection.on('error', () => {});
  try {
    const channel = await connection.createChannel();
    await channel.assertExchange(t.exchange, 'topic', { durable: true });
    for (const consumer of ['notification', 'clinic'] as const) {
      await channel.assertQueue(t[consumer], { durable: true });
      await channel.assertQueue(`${t[consumer]}.dlq`, { durable: true });
    }
    await channel.bindQueue(t.notification, t.exchange, 'notification.requested.v1');
    await channel.bindQueue(t.clinic, t.exchange, 'directory.#');
    await channel.bindQueue(t.clinic, t.exchange, 'billing.#');
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
export interface ConsumerOptions {
  retryBaseMs?: number;
  // Test callbacks only; never exposed by HTTP/environment variables.
  afterCommit?: () => void | Promise<void>;
  beforeRepublish?: () => void | Promise<void>;
  afterRepublishConfirm?: () => void | Promise<void>;
}
export async function consumeEvents(brokerUrl: string, queue: string, consumerName: ConsumerName, apply: (raw: string) => Promise<unknown>, options: ConsumerOptions = {}) {
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
    await channel.prefetch(1);
  } catch (error) { await terminate(); throw error; }
  async function handle(message: amqp.ConsumeMessage) {
    const started=performance.now();let observed:Envelope|undefined;
    let valid = false, reason = 'INVALID_EVENT';
    try {
      const event = parseEnvelope(message.content.toString('utf8'));
      observed=event;
      valid = consumerName === 'notification' ? event.eventType === 'notification.requested.v1' : event.eventType.startsWith('billing.') || event.eventType.startsWith('directory.');
      if (!valid) reason = 'UNSUPPORTED_EVENT';
    } catch {}
    if (valid) {
      try {
        const applied=await apply(message.content.toString('utf8'));
        logEvent(consumerName,observed!,applied===false?'effect-duplicate':'effect-committed',started);
        try { await options.afterCommit?.(); } catch { await terminate(); return; }
        if (!disconnected){channel.ack(message);logEvent(consumerName,observed!,'acknowledged',started);}
        return;
      } catch { reason = 'PROCESSING_FAILED'; }
    }
    const header = message.properties.headers?.['p2-attempt'];
    const attempt = Number.isSafeInteger(header) && header >= 0 ? header as number : 0;
    const target = !valid || attempt >= 2 ? `${queue}.dlq` : queue;
    try {
      if (target === queue) await new Promise(resolve => setTimeout(resolve, (options.retryBaseMs ?? 1000) * (attempt + 1)));
      if (disconnected) return;
      await options.beforeRepublish?.();
      await publishConfirmed(channel, '', target, message.content, { ...message.properties, headers: { ...message.properties.headers, 'p2-attempt': attempt + 1, 'p2-error-code': reason } });
      if(observed)logEvent(consumerName,observed,target===queue?'retry-confirmed':'dlq-confirmed',started);
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
