import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
const context = new AsyncLocalStorage<{ requestId: string }>();
export const currentRequestId = () => context.getStore()?.requestId;
export const traceHeaders = (): Record<string, string> =>
  context.getStore() ? { 'X-Request-Id': context.getStore()!.requestId } : {};
// IDs our edges produce: canonical UUID (services, clients) and nginx $request_id
// (32 hex). Anything else is replaced by a new UUID, never echoed or logged.
const REQUEST_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;
export const acceptRequestId = (value: unknown) =>
  typeof value === 'string' && REQUEST_ID.test(value) ? value : undefined;
// Non-HTTP work (event consumers) runs under the event's correlationId so logs and
// outbound service calls (traceHeaders) carry the same ID as the originating request.
export function withRequestId<T>(requestId: unknown, work: () => T): T {
  return context.run({ requestId: acceptRequestId(requestId) ?? randomUUID() }, work);
}
// correlationId of a raw event, without validating the rest (the inbox does that).
export function eventCorrelation(raw: string): unknown {
  try {
    return (JSON.parse(raw) as { correlationId?: unknown })?.correlationId;
  } catch {
    return undefined;
  }
}
export type RequestScope = {
  service: string;
  instance: string;
  deadlineMs: number;
  // The metric and log label of a request URL.
  routeOf: (url: string) => string;
  isStopping: () => boolean;
  record: (method: string, route: string, status: number, seconds: number) => void;
};
// First middleware of a service: request id, deadline, access log and latency metric, refusal while draining.
export function requestScope(scope: RequestScope): RequestHandler {
  return (req, res, next) => {
    const requestId = acceptRequestId(req.headers['x-request-id']) ?? randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Service-Instance', scope.instance);
    const started = performance.now(),
      route = scope.routeOf(req.originalUrl),
      method = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER';
    const timer = setTimeout(() => {
      if (!res.headersSent)
        res
          .status(503)
          .setHeader('Retry-After', '2')
          .json({ error: 'Request deadline reached. For an uncertain write, retry the same request key.' });
    }, scope.deadlineMs);
    res.once('finish', () => {
      clearTimeout(timer);
      const seconds = (performance.now() - started) / 1000;
      scope.record(method, route, res.statusCode, seconds);
      // Fixed fields only: no body, query string, credentials or raw error.
      process.stdout.write(
        JSON.stringify({
          service: scope.service,
          instance: scope.instance,
          requestId,
          route,
          method,
          status: res.statusCode,
          latencyMs: Math.round(seconds * 1000),
        }) + '\n',
      );
    });
    res.once('close', () => clearTimeout(timer));
    if (scope.isStopping()) {
      // Without this a polling client keeps its connection, and with it the drain, open until the deadline.
      res.set('Connection', 'close');
      res.status(503).json({ error: 'Service is draining.' });
      return;
    }
    context.run({ requestId }, next);
  };
}
