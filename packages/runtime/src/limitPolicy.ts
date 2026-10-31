import type { Request, RequestHandler } from 'express';
import { integer } from './config.js';
import type { Actor } from './jwt.js';
import { requestActor } from './jwt.js';
import type { Bucket, SharedLimiter } from './limiter.js';
import type { RuntimeHealth } from './metrics.js';
export type LimitPolicy = { group: string; buckets: Bucket[]; read: boolean; local?: boolean };
export function limitPolicy(req: Request, service: string, verify: (token: string) => Actor): LimitPolicy {
  const ip = 'ip:' + (req.ip ?? req.socket.remoteAddress ?? 'unknown'),
    windowMs = 900000;
  const b = (identity: string, limit: number, window = windowMs) => ({ identity, limit, windowMs: window });
  const limit = (name: string, defaultValue: number) => integer(name, defaultValue);
  if (req.method === 'POST' && /^\/auth\/(owner|admin)\/login$/.test(req.path)) {
    const raw = req.body?.email ?? req.body?.username;
    const account = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 254) : 'invalid';
    return {
      group: 'auth-login',
      read: false,
      buckets: [
        b(ip, limit('AUTH_LOGIN_IP_LIMIT', 1000)),
        b('account:' + req.path + ':' + account, limit('AUTH_LOGIN_ACCOUNT_LIMIT', 30)),
      ],
    };
  }
  if (req.method === 'POST' && req.path === '/auth/owner/register')
    return { group: 'auth-register', read: false, buckets: [b(ip, limit('AUTH_REGISTER_IP_LIMIT', 300))] };
  if (req.method === 'POST' && req.path.startsWith('/auth/owner/activation'))
    return { group: 'auth-activation', read: false, buckets: [b(ip, limit('AUTH_ACTIVATION_IP_LIMIT', 300))] };
  // AQ-01: unauthenticated rescue reports notify an owner. The token buckets cap
  // a flood against one pet across IPs (5 per 15 minutes, 20 per day); the token
  // is HMACed with the other keys.
  const rescue = req.method === 'POST' ? req.path.match(/^\/public\/pets\/([^/]{1,200})\/rescue-reports$/) : null;
  if (rescue) {
    let token = rescue[1]!;
    try {
      token = decodeURIComponent(token);
    } catch {}
    return {
      group: 'public-rescue',
      read: false,
      buckets: [
        b(ip, limit('RESCUE_REPORT_IP_LIMIT', 20)),
        b('rescue-token:' + token, limit('RESCUE_REPORT_TOKEN_LIMIT', 5)),
        b('rescue-token-day:' + token, limit('RESCUE_REPORT_TOKEN_DAILY_LIMIT', 20), 86400000),
      ],
    };
  }
  let actor: Actor | undefined;
  try {
    actor = requestActor(req, verify);
  } catch {}
  const identity = actor ? 'actor:' + actor.sub : ip,
    read = ['GET', 'HEAD'].includes(req.method);
  if (req.method === 'POST' && req.path === '/auth/me/password')
    return {
      group: 'auth-password',
      read: false,
      buckets: [b(identity, limit('AUTH_PASSWORD_ACTOR_LIMIT', 10)), b(ip, 200)],
    };
  const group = service + (read ? '-read' : '-write');
  return {
    group,
    read,
    // Sign-in, activation and public pages (rescue tokens) stay on the shared limiter even for GET.
    local: read && !/^\/+(auth|public)(\/|$)/i.test(req.path),
    buckets: [
      b(ip, limit(read ? 'API_READ_IP_LIMIT' : 'API_WRITE_IP_LIMIT', read ? 3000 : 1000), 60000),
      ...(actor
        ? [b(identity, limit(read ? 'API_READ_ACTOR_LIMIT' : 'API_WRITE_ACTOR_LIMIT', read ? 600 : 120), 60000)]
        : []),
    ],
  };
}
export type AdmissionGate = {
  limiter: SharedLimiter;
  health: RuntimeHealth;
  hardLimit: number;
  policyOf: (req: Request) => LimitPolicy;
};
// Mounted under /api: spends the request's rate-limit buckets, then, for writes, checks the DB and backlog evidence.
export function limitAdmission(admission: AdmissionGate): RequestHandler {
  const { limiter, health } = admission;
  return async (req, res, next) => {
    try {
      if (req.path === '/health' || req.method === 'OPTIONS') {
        next();
        return;
      }
      const policy = admission.policyOf(req);
      let decision;
      // Reads that are not auth or public are counted per instance: no Redis round trip, and Redis
      // being down does not touch them.
      if (policy.local) decision = limiter.spendLocal(policy.group, policy.buckets);
      else
        try {
          decision = await limiter.spend(policy.group, policy.buckets);
          health.redis = true;
        } catch {
          health.redis = false;
          health.failures++;
          if (!policy.read) {
            res.setHeader('Retry-After', '2');
            res.status(503).json({ error: 'Rate limit authority unavailable. Retry shortly.' });
            return;
          }
          res.setHeader('X-Service-Degraded', 'redis');
          const local = policy.buckets.map(b => ({
            ...b,
            limit: Math.min(b.limit, b.identity.startsWith('actor:') ? 60 : 300),
            windowMs: 60000,
          }));
          decision = limiter.localRead(policy.group, local);
        }
      res.setHeader('RateLimit-Limit', decision.limit);
      res.setHeader('RateLimit-Remaining', decision.remaining);
      if (!decision.allowed) {
        res.setHeader('Retry-After', Math.max(1, Math.ceil(decision.retryMs / 1000)));
        res.status(429).json({ error: 'Too many requests. Retry after the indicated delay.' });
        return;
      }
      if (!policy.read) {
        // Health I/O runs in the background. Never admit writes using missing,
        // failed or stale DB/backlog evidence, and never wait on AMQP here.
        if (!health.database || !health.own || Date.now() - health.ownAt >= 6000) {
          res.setHeader('Retry-After', '2');
          res.status(503).json({ error: 'Event backlog authority unavailable. Retry the same request key later.' });
          return;
        }
        if (health.own.pending >= admission.hardLimit) {
          res.setHeader('Retry-After', '5');
          res.status(503).json({ error: 'Event backlog capacity reached. Retry the same request key later.' });
          return;
        }
      }
      if (!res.writableEnded) next();
    } catch {
      if (!res.headersSent) res.status(503).json({ error: 'Request admission unavailable.' });
    }
  };
}
