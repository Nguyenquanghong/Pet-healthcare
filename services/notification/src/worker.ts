import { declareTopology, delay, reconnect, requireBrokerConfig, startWorker } from '@nipopeto/messaging';
import { createDependencies } from './composition.js';
import { NotificationInbox } from './inbox.js';
import { openConsumer } from './consumer.js';
const { db } = createDependencies();
await startWorker('notification', async signal => {
  try {
    await db.$connect();
    const config = requireBrokerConfig(), inbox = new NotificationInbox(db);
    await reconnect('notification', signal, async () => {
      await declareTopology(config.brokerUrl, config.topology);
      const consumer = await openConsumer(config.brokerUrl, config.topology.notification, inbox);
      process.stdout.write(JSON.stringify({ service: 'notification', status: 'worker-ready' }) + '\n');
      const stopped = new AbortController();
      const abort = () => stopped.abort(); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) stopped.abort();
      try { await Promise.race([consumer.done, delay(2147483647, stopped.signal)]); }
      finally { stopped.abort(); signal.removeEventListener('abort', abort); await consumer.close(); }
    });
  } finally { await db.$disconnect(); }
});
