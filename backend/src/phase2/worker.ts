import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../generated/phase2-core/index.js';
import { declareTopology, delay, reconnect, requireBrokerConfig, startWorker } from '@nipopeto/messaging';
import { OutboxRelay } from './relay.js';
import { databaseUrl, runtimeEnabled } from '@nipopeto/runtime';
const db = new PrismaClient(runtimeEnabled() ? { datasourceUrl: databaseUrl() } : undefined);
await startWorker('core', async signal => {
  try {
    await db.$connect();
    const config = requireBrokerConfig(),
      workerId = randomUUID();
    const relay = new OutboxRelay(db, config.brokerUrl, process.env.OUTBOX_AGGREGATE_ID);
    await reconnect('core', signal, async () => {
      await declareTopology(config.brokerUrl, config.topology);
      process.stdout.write(JSON.stringify({ service: 'core', status: 'worker-ready' }) + '\n');
      while (!signal.aborted) if (!(await relay.once(workerId, config.topology))) await delay(250, signal);
    });
  } finally {
    await db.$disconnect();
  }
});
