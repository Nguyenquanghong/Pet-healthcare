import type { NotificationInbox } from './inbox.js';
import { consumeEvents, type ConsumerOptions } from '@nipopeto/messaging';
import { withRequestId, eventCorrelation } from '@nipopeto/runtime';
export function openConsumer(brokerUrl: string, queue: string, inbox: NotificationInbox, options: ConsumerOptions = {}) {
  return consumeEvents(brokerUrl, queue, 'notification', raw => withRequestId(eventCorrelation(raw), () => inbox.apply(raw)), options);
}
