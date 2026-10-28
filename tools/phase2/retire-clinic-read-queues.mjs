// Retire the broker queues of the removed CQRS read projection (migration A, d505faa).
// The consumer `clinic-read-v1` left the code in be2267b, so `declareTopology` no longer
// declares it, but RabbitMQ keeps the durable queues until someone deletes them:
//   <prefix>.clinic-read-v1, <prefix>.clinic-read-v1.dlq,
//   <prefix>.clinic-read-v1.retry.{1000,5000,30000,120000,600000}ms
// Same naming as topology() / retryQueue() in packages/messaging/src/index.ts.
//
//   BROKER_URL=<amqp url> BROKER_PREFIX=<prefix> node tools/phase2/retire-clinic-read-queues.mjs [--dry-run | --apply]
//
// --dry-run (default) only reports. --apply deletes with ifEmpty:true, so a queue that still
// holds a message or has a consumer is refused and kept. A queue that does not exist is skipped.
// Exit 1 if any queue was refused or failed (a dry-run exits 1 when --apply would refuse).
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import amqp from 'amqplib';

export const retiredConsumer = 'clinic-read-v1';
export const retiredRetryDelaysMs = [1000, 5000, 30000, 120000, 600000];
// The runtime rule (requireBrokerConfig in packages/messaging).
export const prefixPattern = /^[A-Za-z0-9._-]{1,100}$/;

export function retiredQueues(prefix) {
  if (typeof prefix !== 'string' || !prefixPattern.test(prefix)) throw new Error('INVALID_BROKER_PREFIX');
  const queue = `${prefix}.${retiredConsumer}`;
  return [queue, `${queue}.dlq`, ...retiredRetryDelaysMs.map(ms => `${queue}.retry.${ms}ms`)];
}

const codeOf = error => (error && typeof error === 'object' && Number.isInteger(error.code) ? error.code : 'ERROR');

// openChannel() gives a fresh channel per queue: RabbitMQ closes the channel when a passive
// check finds no queue. Results: skipped (absent) | would-delete (dry-run) | deleted |
// refused (messages or consumers, or it filled before the delete) | failed.
export async function retire({ openChannel, prefix, apply = false }) {
  const results = [];
  for (const queue of retiredQueues(prefix)) {
    const channel = await openChannel();
    try {
      let state;
      try {
        state = await channel.checkQueue(queue);
      } catch (error) {
        results.push(
          codeOf(error) === 404 ? { queue, status: 'skipped', reason: 'absent' } : { queue, status: 'failed', reason: `CHECK_FAILED:${codeOf(error)}` },
        );
        continue;
      }
      if (state.messageCount > 0 || state.consumerCount > 0) {
        results.push({ queue, status: 'refused', reason: state.messageCount > 0 ? `${state.messageCount} message(s) ready` : `${state.consumerCount} consumer(s)` });
        continue;
      }
      if (!apply) {
        results.push({ queue, status: 'would-delete' });
        continue;
      }
      try {
        await channel.deleteQueue(queue, { ifEmpty: true });
        results.push({ queue, status: 'deleted' });
      } catch (error) {
        // 406: a message arrived between the check and the delete; the broker kept the queue.
        results.push(codeOf(error) === 406 ? { queue, status: 'refused', reason: 'not empty at delete' } : { queue, status: 'failed', reason: `DELETE_FAILED:${codeOf(error)}` });
      }
    } finally {
      await channel.close().catch(() => {});
    }
  }
  return results;
}

export async function main({ env = process.env, argv = process.argv.slice(2), connect = amqp.connect, out = line => process.stdout.write(line + '\n') } = {}) {
  const flags = new Set(argv);
  if (flags.size !== argv.length || argv.some(arg => arg !== '--dry-run' && arg !== '--apply') || (flags.has('--dry-run') && flags.has('--apply')))
    throw new Error('Usage: BROKER_URL=<url> BROKER_PREFIX=<prefix> node tools/phase2/retire-clinic-read-queues.mjs [--dry-run | --apply]');
  if (!env.BROKER_URL) throw new Error('BROKER_URL_REQUIRED');
  // No default prefix here: a guessed namespace would report "nothing to do" against the wrong queues.
  if (!env.BROKER_PREFIX) throw new Error('BROKER_PREFIX_REQUIRED');
  const prefix = env.BROKER_PREFIX, apply = flags.has('--apply');
  retiredQueues(prefix);
  const connection = await connect(env.BROKER_URL, { timeout: 5000 });
  connection.on('error', () => {});
  let results;
  try {
    results = await retire({
      prefix,
      apply,
      openChannel: async () => {
        const channel = await connection.createChannel();
        channel.on('error', () => {});
        return channel;
      },
    });
  } finally {
    await connection.close().catch(() => {});
  }
  out(`${apply ? 'apply' : 'dry-run'} prefix=${prefix}`);
  for (const r of results) out(`${r.status.padEnd(12)} ${r.queue}${r.reason ? `  (${r.reason})` : ''}`);
  const count = status => results.filter(r => r.status === status).length;
  out(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', prefix, deleted: count('deleted'), wouldDelete: count('would-delete'), skipped: count('skipped'), refused: count('refused'), failed: count('failed') }));
  return results.some(r => r.status === 'refused' || r.status === 'failed') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    // Fixed codes only: never print the broker URL or a raw client error.
    const known = /^(INVALID_BROKER_PREFIX|BROKER_URL_REQUIRED|BROKER_PREFIX_REQUIRED|Usage: .*)$/s;
    process.stderr.write((known.test(error?.message ?? '') ? error.message : 'RETIRE_FAILED: broker unreachable or refused the connection') + '\n');
    process.exitCode = 1;
  }
}
