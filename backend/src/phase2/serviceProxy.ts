import type { Request, RequestHandler } from 'express';
import { CircuitBreaker, CircuitOpenError, integer, traceHeaders } from '@nipopeto/runtime';

// P08 part A: Gateway Routing for the split services. What differs per downstream
// (prefixes, headers, timeout, messages) is data; forwarding, isolation and error
// mapping live once here, and each downstream gets its own Circuit Breaker.
export type ProxyTarget = {
  name: 'clinic' | 'notification';
  origin: URL;
  // Allowed paths, checked again after the URL is resolved (dot segments).
  prefixes: readonly string[];
  forwardRequestHeaders: readonly string[];
  forwardResponseHeaders: readonly string[];
  timeoutMs: number;
  unavailableMessage: string;
  notFoundMessage: string;
};

// A 502/503/504 counts against the breaker, yet the client still receives that
// downstream answer unchanged.
class DependencyStatus extends Error {
  constructor(readonly response: Response) { super('DEPENDENCY_STATUS'); }
}
// A deliberate, fast degradation (X-Service-Degraded) means the service is up and
// answering; it must not open the circuit for every other route of that service.
const isDependencyFailure = (error: unknown) => !(error instanceof DependencyStatus && error.response.headers.has('x-service-degraded'));

export function gatewayBreaker(name: ProxyTarget['name']) {
  const key = name.toUpperCase();
  return new CircuitBreaker(`${name}-gateway`, integer(`${key}_GATEWAY_BREAKER_FAILURES`, 5, 1, 100), integer(`${key}_GATEWAY_BREAKER_OPEN_MS`, 5000, 100, 60000));
}

async function send(target: ProxyTarget, req: Request, url: URL) {
  const headers: Record<string, string> = { ...traceHeaders() };
  for (const name of target.forwardRequestHeaders) { const value = req.headers[name]; if (typeof value === 'string') headers[name] = value; }
  const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? JSON.stringify(req.body ?? {}) : undefined;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, { method: req.method, headers, body, redirect: 'error', signal: AbortSignal.timeout(target.timeoutMs) });
  if ([502, 503, 504].includes(response.status)) throw new DependencyStatus(response);
  return response;
}

export function serviceProxy(target: ProxyTarget, breaker = gatewayBreaker(target.name)): RequestHandler {
  const retryAfter = String(Math.ceil(integer(`${target.name.toUpperCase()}_GATEWAY_BREAKER_OPEN_MS`, 5000, 100, 60000) / 1000));
  return async (req, res) => {
    const url = new URL(req.originalUrl, target.origin);
    if (!target.prefixes.some(prefix => url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) { res.status(404).json({ error: target.notFoundMessage }); return; }
    let response: Response;
    try {
      response = await breaker.run(() => send(target, req, url), isDependencyFailure);
    } catch (error) {
      if (error instanceof DependencyStatus) response = error.response;
      else {
        if (res.headersSent) return;
        // Open circuit: fail at once instead of holding a Core connection for the timeout.
        if (error instanceof CircuitOpenError) { res.setHeader('Retry-After', retryAfter); res.setHeader('X-Service-Degraded', target.name); }
        res.status(503).json({ error: target.unavailableMessage });
        return;
      }
    }
    // Never expose the downstream URL, internal credentials or transport error.
    if (res.writableEnded) return;
    for (const name of target.forwardResponseHeaders) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name, name === 'x-service-instance' ? `${target.name}:${value}` : value);
    }
    if (response.status === 204) { res.status(204).end(); return; }
    let body: unknown;
    try { body = await response.json(); } catch (error) {
      if (res.headersSent) return;
      // A body that is not JSON is the downstream's fault, not an outage; a read cut short is.
      if (error instanceof SyntaxError) res.status(502).json({ error: target.unavailableMessage, code: 'DOWNSTREAM_INVALID_RESPONSE' });
      else res.status(503).json({ error: target.unavailableMessage });
      return;
    }
    res.status(response.status).json(body);
  };
}
