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
      // P03: revocations have their own queue and channel, so a notification backlog never delays them.
      const consumers = [await openConsumer(config.brokerUrl, config.topology.notification, inbox)];
      try { consumers.push(await openConsumer(config.brokerUrl, config.topology.identity, inbox, {}, 'identity')); }
      catch (error) { await consumers[0]!.close(); throw error; }
      process.stdout.write(JSON.stringify({ service: 'notification', status: 'worker-ready' }) + '\n');
      const stopped = new AbortController();
      const abort = () => stopped.abort(); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) stopped.abort();
      // Either channel closing reconnects both.
      try { await Promise.race([...consumers.map(c => c.done), delay(2147483647, stopped.signal)]); }
      finally { stopped.abort(); signal.removeEventListener('abort', abort); await Promise.all(consumers.map(c => c.close())); }
    });
  } finally { await db.$disconnect(); }
});
