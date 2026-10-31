import amqp from 'amqplib';
import { parseEnvelope } from '@nipopeto/contracts';
import { delay } from './delay.js';
import { publishConfirmed } from './publisher.js';
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
    await publishConfirmed(channel, '', queue, message.content, {
      ...message.properties,
      headers: { ...message.properties.headers, 'p2-attempt': 0 },
    });
    channel.ack(message);
    await delay(100); // fixed local replay admission, at most one selected event
    return { eventId, queue, status: 'replayed' };
  } finally {
    await connection.close();
  }
}
// P03: replay up to max DLQ messages in order, eventIds unchanged and p2-attempt reset.
// Stops, leaving the message at the head of the DLQ, at one that is not a valid event
// (it would only come back) or at an eventId already replayed by this call (it failed
// again meanwhile, so replaying further would loop).
export async function replayAll(brokerUrl: string, queue: string, max: number) {
  if (!Number.isSafeInteger(max) || max < 1 || max > 10000) throw new Error('INVALID_REPLAY_MAX');
  const connection = await amqp.connect(brokerUrl, { timeout: 5000 });
  connection.on('error', () => {});
  const replayed = new Set<string>();
  let stopped: 'max' | 'empty' | 'invalid' | 'repeat' = 'max';
  try {
    const channel = await connection.createConfirmChannel();
    channel.on('error', () => {});
    while (replayed.size < max) {
      const message = await channel.get(`${queue}.dlq`, { noAck: false });
      if (!message) {
        stopped = 'empty';
        break;
      }
      let eventId: string;
      try {
        eventId = parseEnvelope(message.content.toString('utf8')).eventId;
      } catch {
        channel.nack(message, false, true);
        stopped = 'invalid';
        break;
      }
      if (replayed.has(eventId)) {
        channel.nack(message, false, true);
        stopped = 'repeat';
        break;
      }
      await publishConfirmed(channel, '', queue, message.content, {
        ...message.properties,
        headers: { ...message.properties.headers, 'p2-attempt': 0 },
      });
      channel.ack(message);
      replayed.add(eventId);
      await delay(20); // fixed admission: at most 50 replayed events per second
    }
    return { queue, replayed: [...replayed], stopped };
  } finally {
    await connection.close();
  }
}
