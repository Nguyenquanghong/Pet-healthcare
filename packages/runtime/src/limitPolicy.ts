import type { Request, RequestHandler } from 'express';
import { integer } from './config.js';
import type { Actor } from './jwt.js';
import { requestActor } from './jwt.js';
import type { Bucket, SharedLimiter } from './limiter.js';
import type { RuntimeHealth } from './metrics.js';
// The limiter and the backlog gate are mounted under this prefix; the services' routes are declared by the services.
export const API_PREFIX = '/api';
export type LimitPolicy = { group: string; buckets: Bucket[]; read: boolean; local?: boolean };
// What a rule sees of a request under the API prefix (req.path is relative to it).
export type LimitContext = {
  req: Request;
  // 'ip:<address>' of the client.
  ip: string;
  bucket: (identity: string, limit: number, windowMs?: number) => Bucket;
  // A threshold from the environment; an invalid value throws, and the request is refused (fail closed).
  limit: (name: string, defaultValue: number) => number;
  // Verified once per request; undefined when the token is missing or invalid.
  actor: () => Actor | undefined;
  // 'actor:<sub>' when there is an actor, else the client's ip.
  identity: () => string;
  // The general per-client policy: per ip and per actor, reads and writes apart. `shared` keeps a read on the shared
  // limiter (Redis) instead of the per-instance one.
  general: (options?: { shared?: boolean }) => LimitPolicy;
};
// A service's own rule for requests the general policy does not fit: a policy to apply, or undefined to pass.
export type LimitRule = (context: LimitContext) => LimitPolicy | undefined;
// The first rule that answers decides; with none (or an empty list) the general policy applies, so the limiter is
// never off.
export function limitPolicy(
  req: Request,
  service: string,
  verify: (token: string) => Actor,
  rules: readonly LimitRule[],
): LimitPolicy {
  const ip = 'ip:' + (req.ip ?? req.socket.remoteAddress ?? 'unknown');
  let resolved: { actor: Actor | undefined } | undefined;
  const actor = () => {
    if (!resolved) {
      try {
        resolved = { actor: requestActor(req, verify) };
      } catch {
        resolved = { actor: undefined };
      }
    }
    return resolved.actor;
  };
  const identity = () => {
    const who = actor();
    return who ? 'actor:' + who.sub : ip;
  };
  const limit = (name: string, defaultValue: number) => integer(name, defaultValue);
  const general = ({ shared = false } = {}): LimitPolicy => {
    const read = ['GET', 'HEAD'].includes(req.method),
      who = actor(),
      bucket = (id: string, max: number, windowMs: number): Bucket => ({ identity: id, limit: max, windowMs });
    return {
      group: service + (read ? '-read' : '-write'),
      read,
      local: read && !shared,
      buckets: [
        bucket(ip, limit(read ? 'API_READ_IP_LIMIT' : 'API_WRITE_IP_LIMIT', read ? 3000 : 1000), 60000),
        ...(who
          ? [
              bucket(
                identity(),
                limit(read ? 'API_READ_ACTOR_LIMIT' : 'API_WRITE_ACTOR_LIMIT', read ? 600 : 120),
                60000,
              ),
            ]
          : []),
      ],
    };
  };
  const context: LimitContext = {
    req,
    ip,
    bucket: (id, max, windowMs = 900000) => ({ identity: id, limit: max, windowMs }),
    limit,
    actor,
    identity,
    general,
  };
  for (const rule of rules) {
    const policy = rule(context);
    if (policy) return policy;
  }
  return general();
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
