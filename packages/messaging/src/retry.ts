import { type FailureKind } from './failures.js';
import { type ConsumerQueue } from './topology.js';
// The delay before each retry. Default 1 s, 5 s, 30 s, 2 min, 10 min: about 12.6 minutes,
// enough for a restart or deploy of a service or the database, before the DLQ.
export const defaultRetryDelaysMs = [1000, 5000, 30000, 120000, 600000] as const;
export function retryDelays(raw = process.env.BROKER_RETRY_DELAYS_MS): number[] {
  if (raw === undefined || raw === '') return [...defaultRetryDelaysMs];
  const delays = raw.split(',').map(Number);
  if (
    delays.length > 6 ||
    delays.some((d, i) => !Number.isSafeInteger(d) || d < 1 || d > 3600000 || (i > 0 && d <= delays[i - 1]!))
  )
    throw new Error('INVALID_BROKER_RETRY_DELAYS');
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
export const runtimeQueues = (consumers: readonly ConsumerQueue[]) => ({
  consumers,
  retrySuffixes: retryDelays().map(ms => retryQueue('', ms)),
});
