import amqp from 'amqplib';
import { type EventConsumer } from '@nipopeto/contracts';
export type ConsumerName = EventConsumer;
export type ConsumerQueue = 'notification' | 'identity' | 'clinic';
export const topology = (prefix = 'nipopeto.v1') => ({
  exchange: `${prefix}.events`,
  notification: `${prefix}.notification`,
  identity: `${prefix}.identity`,
  clinic: `${prefix}.clinic`,
});
export type Topology = ReturnType<typeof topology>;
export async function declareTopology(brokerUrl: string, t: Topology) {
  const connection = await amqp.connect(brokerUrl, { timeout: 5000 });
  connection.on('error', () => {});
  try {
    const channel = await connection.createChannel();
    await channel.assertExchange(t.exchange, 'topic', { durable: true });
    for (const consumer of ['notification', 'identity', 'clinic'] as const) {
      await channel.assertQueue(t[consumer], { durable: true });
      await channel.assertQueue(`${t[consumer]}.dlq`, { durable: true });
    }
    await channel.bindQueue(t.notification, t.exchange, 'notification.requested.v1');
    // P03: revocations have their own queue. Removing the old binding is a no-op once it is gone.
    await channel.unbindQueue(t.notification, t.exchange, 'identity.sessions-revoked.v1');
    await channel.bindQueue(t.identity, t.exchange, 'identity.sessions-revoked.v1');
    await channel.bindQueue(t.clinic, t.exchange, 'directory.#');
    await channel.bindQueue(t.clinic, t.exchange, 'billing.#');
  } finally {
    await connection.close();
  }
}
export function requireBrokerConfig() {
  if (!process.env.BROKER_URL) throw new Error('BROKER_URL_REQUIRED');
  const prefix = process.env.BROKER_PREFIX || 'nipopeto.v1';
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(prefix)) throw new Error('INVALID_BROKER_PREFIX');
  return { brokerUrl: process.env.BROKER_URL, topology: topology(prefix) };
}
