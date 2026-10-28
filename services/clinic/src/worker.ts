import { randomUUID } from 'node:crypto';
import {
  declareTopology,
  consumeEvents,
  delay,
  reconnect,
  requireBrokerConfig,
  startWorker,
} from '@nipopeto/messaging';
import { PrismaClient } from './generated/client/index.js';
import { ClinicInbox } from './inbox.js';
import { OutboxRelay } from './relay.js';
import { DirectorySync } from './directorySync.js';
import { classifyClinicFailure } from './messagingErrors.js';
import { withRequestId, eventCorrelation, integer, prismaClient } from '@nipopeto/runtime';
import { blobStoreConfigured, blobStoreFromEnv } from './blobStore.js';
import { drainBlobCleanup } from './blobCleanup.js';
const db = prismaClient(PrismaClient);
await startWorker('clinic', async signal => {
  try {
    if (!process.env.CORE_SERVICE_URL && process.env.CLINIC_PROOF_ONLY !== '1')
      throw new Error('DIRECTORY_RUNTIME_CONFIGURATION_REQUIRED');
    await db.$connect();
    const sync = process.env.CORE_SERVICE_URL
      ? new DirectorySync(
          process.env.CORE_SERVICE_URL,
          process.env.CORE_DIRECTORY_TOKEN ?? process.env.CLINIC_SERVICE_TOKEN ?? '',
        )
      : undefined;
    const config = requireBrokerConfig(),
      inbox = new ClinicInbox(db, sync ? (kind, p) => sync.hydrate(kind, p) : undefined),
      workerId = randomUUID();
    const relay = new OutboxRelay(db, config.brokerUrl, process.env.OUTBOX_AGGREGATE_ID, {
      batchSize: integer('CLINIC_RELAY_BATCH', 50, 1, 500),
      persistent: true,
    });
    await Promise.all([
      reconnect('clinic-consumer', signal, async () => {
        await declareTopology(config.brokerUrl, config.topology);
        const consumer = await consumeEvents(
          config.brokerUrl,
          config.topology.clinic,
          'clinic',
          raw => withRequestId(eventCorrelation(raw), () => inbox.apply(raw)),
          { classify: classifyClinicFailure },
        );
        process.stdout.write(JSON.stringify({ service: 'clinic', status: 'worker-ready' }) + '\n');
        const stopped = new AbortController();
        const abort = () => stopped.abort();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) stopped.abort();
        try {
          await Promise.race([consumer.done, delay(2147483647, stopped.signal)]);
        } finally {
          stopped.abort();
          signal.removeEventListener('abort', abort);
          await consumer.close();
        }
      }),
      ...(blobStoreConfigured()
        ? [
            reconnect('clinic-blob-cleanup', signal, async () => {
              const blobs = blobStoreFromEnv();
              while (!signal.aborted) {
                await drainBlobCleanup(db, blobs);
                await delay(integer('BLOB_CLEANUP_INTERVAL_MS', 30000, 1000, 3600000), signal);
              }
            }),
          ]
        : []),
      reconnect('clinic-relay', signal, async () => {
        await declareTopology(config.brokerUrl, config.topology);
        try {
          while (!signal.aborted) if (!(await relay.once(workerId, config.topology))) await delay(250, signal);
        } finally {
          await relay.close();
        }
      }),
    ]);
  } finally {
    await db.$disconnect();
  }
});
