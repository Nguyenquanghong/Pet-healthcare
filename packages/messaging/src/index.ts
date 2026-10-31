// The public API of @nipopeto/messaging. Each concern lives in its own module; nothing else is exported.
export { logEvent } from './eventLog.js';
export { topology, declareTopology, requireBrokerConfig, type ConsumerName, type Topology } from './topology.js';
export { publishConfirmed, ConfirmPublisher, type OutboxMessage, type BatchResult } from './publisher.js';
export { BaseOutboxRelay, type RelayOptions, type ClaimedOutbox, type OutboxRelayStore } from './relay.js';
export {
  TransientError,
  PermanentError,
  permanentOn,
  defaultClassify,
  failureCode,
  type FailureKind,
  type ClassifyFailure,
} from './failures.js';
export { defaultRetryDelaysMs, retryDelays, retryQueue, retryTarget, runtimeQueues } from './retry.js';
export { consumeEvents, type ConsumerOptions } from './consumer.js';
export { replayEvent, replayAll } from './replay.js';
export { delay } from './delay.js';
export { reconnect, startWorker } from './worker.js';
