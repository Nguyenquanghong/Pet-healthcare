import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { declareTopology, delay, reconnect, requireBrokerConfig, startWorker } from '@nipopeto/messaging';
import { OutboxRelay } from './relay.js';
import { RuntimeOutboxStore } from '../infrastructure/persistence/runtimeOutboxStore.js';
import {databaseUrl,integer,runtimeEnabled} from '@nipopeto/runtime';
const db = new PrismaClient(runtimeEnabled()?{datasourceUrl:databaseUrl()}:undefined);
await startWorker('core', async signal => {
  try {
    await db.$connect();
    const config = requireBrokerConfig(), workerId = randomUUID();
    // Test-only scope: refuse it outside the guarded test project instead of
    // silently leaving older production rows unpublished.
    const after = process.env.OUTBOX_CREATED_AFTER;
    if (after !== undefined && (process.env.PHASE2_TEST_CONFIRM !== 'pet-phase2-p1-test' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(after) || !Number.isFinite(Date.parse(after)))) throw new Error('INVALID_OUTBOX_CREATED_AFTER');
    const relay = new OutboxRelay(new RuntimeOutboxStore(db), config.brokerUrl, process.env.OUTBOX_AGGREGATE_ID, after,
      { batchSize: integer('CORE_RELAY_BATCH', 50, 1, 500), persistent: true });
    await reconnect('core', signal, async () => {
      await declareTopology(config.brokerUrl, config.topology);
      process.stdout.write(JSON.stringify({ service: 'core', status: 'worker-ready' }) + '\n');
      while (!signal.aborted) if (!await relay.once(workerId, config.topology)) await delay(250, signal);
    });
    await relay.close();
  } finally { await db.$disconnect(); }
});
