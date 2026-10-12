import type { NotificationInbox } from './inbox.js';
import { consumeEvents, type ConsumerOptions } from '@nipopeto/messaging';
export function openConsumer(brokerUrl: string, queue: string, inbox: NotificationInbox, options: ConsumerOptions = {}) {
  return consumeEvents(brokerUrl, queue, 'notification', raw => inbox.apply(raw), options);
}
