import type { NotificationInbox } from './inbox.js';
import { consumeEvents, type ConsumerName, type ConsumerOptions } from '@nipopeto/messaging';
import { withRequestId, eventCorrelation } from '@nipopeto/runtime';
import { classifyNotificationFailure } from './messagingErrors.js';
// One inbox behind both queues: notifications, and session revocations (P03 identity queue).
export function openConsumer(brokerUrl: string, queue: string, inbox: NotificationInbox, options: ConsumerOptions = {}, consumer: Extract<ConsumerName, 'notification' | 'identity'> = 'notification') {
  return consumeEvents(brokerUrl, queue, consumer, raw => withRequestId(eventCorrelation(raw), () => inbox.apply(raw)), { classify: classifyNotificationFailure, ...options });
}
