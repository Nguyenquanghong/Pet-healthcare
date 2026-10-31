import amqp from 'amqplib';
import { consumes, parseEnvelope, type Envelope } from '@nipopeto/contracts';
import { logEvent } from './eventLog.js';
import { defaultClassify, failureCode, type ClassifyFailure, type FailureKind } from './failures.js';
import { publishConfirmed } from './publisher.js';
import { retryDelays, retryQueue, retryTarget } from './retry.js';
import { type ConsumerName } from './topology.js';
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
export async function consumeEvents(
  brokerUrl: string,
  queue: string,
  consumerName: ConsumerName,
  apply: (raw: string) => Promise<unknown>,
  options: ConsumerOptions = {},
) {
  // Validated before connecting: a bad ladder fails the start, not the first retry.
  const delays = options.retryDelaysMs
    ? retryDelays(options.retryDelaysMs.join(','))
    : options.retryBaseMs !== undefined
      ? retryDelays(`${options.retryBaseMs},${options.retryBaseMs * 2}`)
      : retryDelays();
  const classify = options.classify ?? defaultClassify;
  const connection = await amqp.connect(brokerUrl, { timeout: 5000 });
  connection.on('error', () => {});
  const channel = await connection.createConfirmChannel().catch(async error => {
    await connection.close().catch(() => {});
    throw error;
  });
  channel.on('error', () => {});
  const done = new Promise<void>(resolve => connection.once('close', resolve));
  let closing = false,
    disconnected = false;
  channel.once('close', () => {
    disconnected = true;
    if (!closing) void connection.close().catch(() => {});
  });
  const pending = new Set<Promise<void>>();
  const terminate = async () => {
    closing = true;
    await channel.close().catch(() => {});
    await connection.close().catch(() => {});
  };
  try {
    await channel.assertQueue(queue, { durable: true });
    await channel.assertQueue(`${queue}.dlq`, { durable: true });
    for (const delay of delays)
      await channel.assertQueue(retryQueue(queue, delay), {
        durable: true,
        messageTtl: delay,
        deadLetterExchange: '',
        deadLetterRoutingKey: queue,
      });
    await channel.prefetch(1);
  } catch (error) {
    await terminate();
    throw error;
  }
  async function handle(message: amqp.ConsumeMessage) {
    const started = performance.now();
    let observed: Envelope | undefined;
    let valid = false,
      reason = 'INVALID_EVENT',
      failure: FailureKind = 'permanent';
    try {
      const event = parseEnvelope(message.content.toString('utf8'));
      observed = event;
      valid = consumes(consumerName, event.eventType);
      if (!valid) reason = 'UNSUPPORTED_EVENT';
    } catch {}
    if (valid) {
      try {
        const applied = await apply(message.content.toString('utf8'));
        logEvent(consumerName, observed!, applied === false ? 'effect-duplicate' : 'effect-committed', started);
        try {
          await options.afterCommit?.();
        } catch {
          await terminate();
          return;
        }
        if (!disconnected) {
          channel.ack(message);
          logEvent(consumerName, observed!, 'acknowledged', started);
        }
        return;
      } catch (error) {
        reason = failureCode(error);
        try {
          failure = classify(error);
        } catch {
          failure = 'transient';
        }
      }
    }
    const header = message.properties.headers?.['p2-attempt'];
    const attempt = Number.isSafeInteger(header) && header >= 0 ? (header as number) : 0;
    // The message waits in a retry queue, not in this handler: the next message runs now.
    const target = retryTarget(queue, attempt, failure, delays);
    try {
      if (disconnected) return;
      await options.beforeRepublish?.();
      await publishConfirmed(channel, '', target.queue, message.content, {
        ...message.properties,
        headers: {
          ...message.properties.headers,
          'p2-attempt': attempt + 1,
          'p2-error-code': reason,
          'p2-failure': failure,
        },
      });
      if (observed)
        logEvent(consumerName, observed, target.delay === null ? 'dlq-confirmed' : 'retry-confirmed', started);
      await options.afterRepublishConfirm?.();
      if (!disconnected) channel.ack(message);
    } catch {
      await terminate();
    } // original remains unacknowledged
  }
  const result = await channel.consume(queue, message => {
    if (!message) {
      void terminate();
      return;
    }
    const work = handle(message)
      .catch(() => terminate())
      .finally(() => pending.delete(work));
    pending.add(work);
  });
  return {
    done,
    channel,
    connection,
    close: async () => {
      if (closing) {
        await done;
        return;
      }
      closing = true;
      if (!disconnected) await channel.cancel(result.consumerTag).catch(() => {});
      await Promise.allSettled([...pending]);
      await terminate();
    },
  };
}
