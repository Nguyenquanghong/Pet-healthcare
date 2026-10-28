import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Express, Request, Response } from 'express';
import express from 'express';
import type { Server } from 'node:http';
import amqp from 'amqplib';
import { SharedLimiter, type Bucket } from './limiter.js';
import { circuitBreakers } from './circuitBreaker.js';
import { acceptsCredential, credential, integer, runtimeEnabled } from './config.js';
import type { Actor } from './jwt.js';
import { requestActor } from './jwt.js';

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
export type OwnSnapshot = {
  pending: number;
  outboxAgeSeconds: number;
  outboxRetries: number;
  billingPending: number;
  billingAgeSeconds: number;
  dbLockWaits: number;
};
// queues: the consumer queues under BROKER_PREFIX and their retry queue suffixes (P03),
// summed into queue_ready, retry_ready and dlq_ready. Default: the service's own queue.
export type RuntimeOptions = {
  service: 'core' | 'clinic' | 'notification';
  verify: (token: string) => Actor;
  probe: () => Promise<OwnSnapshot>;
  extras?: () => Record<string, number>;
  queues?: { consumers: readonly string[]; retrySuffixes: readonly string[] };
};
const buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10];
function routeTemplate(path: string) {
  const p = path.split('?')[0]!;
  if (p === '/health/live' || p === '/health/ready' || p === '/api/health' || p === '/metrics') return p;
  if (p.startsWith('/internal/')) return '/internal/:scope';
  const fixed =
    /^\/api\/(auth\/(owner\/(login|register|activation(\/inspect)?)|admin\/login|me(\/password)?)|dashboard\/(core|clinic)|appointments\/(calendar|availability)|medical-records\/images|notifications\/(unread-count|send|read-all)|invoices\/checkout|bootstrap|analytics\/summary|openapi.json|docs|pets|owners|doctors|appointments|medical-records|hotel-bookings|notifications|invoices|operations|payments)$/;
  if (fixed.test(p)) return p;
  const item = p.match(
    /^\/api\/(pets|owners|appointments|medical-records|hotel-bookings|notifications|invoices|operations)\/[^/]{1,200}(\/(status|reschedule|cancel|status-history|history|undo-status|reminder|read|pay|daily-care|activation))?$/,
  );
  if (item) return `/api/${item[1]}/:id${item[2] ?? ''}`;
  if (/^\/api\/medical-records\/images\/[^/]{1,200}$/.test(p)) return '/api/medical-records/images/:id';
  if (/^\/api\/public\/rescue\/[^/]{1,200}(\/report)?$/.test(p)) return '/api/public/rescue/:token';
  const pet = p.match(/^\/api\/public\/pets\/[^/]{1,200}(\/rescue-reports)?$/);
  if (pet) return '/api/public/pets/:token' + (pet[1] ?? '');
  return 'unknown';
}
type HttpMetric = { count: number; sum: number; counts: number[] };
export class ServiceRuntime {
  readonly limiter: SharedLimiter;
  readonly instance: string;
  private stopping = false;
  private own: OwnSnapshot | undefined;
  private ownAt = 0;
  private checking: Promise<void> | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private probing: amqp.ChannelModel | undefined;
  private database = false;
  private redis = false;
  private broker = false;
  private queueReady = -1;
  private dlqReady = -1;
  private retryReady = -1;
  private failures = 0;
  private http = new Map<string, HttpMetric>();
  private lag = monitorEventLoopDelay({ resolution: 20 });
  private metricsToken: string;
  readonly softLimit: number;
  readonly hardLimit: number;
  readonly deadlineMs: number;
  readonly brokerProbeMs: number;
  constructor(readonly options: RuntimeOptions) {
    this.metricsToken = credential('OBSERVABILITY_TOKEN');
    this.limiter = new SharedLimiter(
      process.env.REDIS_URL ?? '',
      credential('RATE_LIMIT_KEY_SECRET'),
      process.env.RATE_LIMIT_NAMESPACE ?? 'pet-phase2',
      integer('REDIS_TIMEOUT_MS', 350, 50, 1000),
      integer('LOCAL_LIMITER_MAX_ENTRIES', 10000, 16, 1000000),
    );
    this.instance = process.env.SERVICE_INSTANCE_ID ?? randomUUID();
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(this.instance)) throw new Error('INVALID_INSTANCE_ID');
    this.softLimit = integer('OUTBOX_SOFT_LIMIT', 10000);
    this.hardLimit = integer('OUTBOX_HARD_LIMIT', 20000);
    if (this.softLimit >= this.hardLimit) throw new Error('INVALID_OUTBOX_LIMITS');
    this.deadlineMs = integer('HTTP_DEADLINE_MS', 10000, 100, 30000);
    this.brokerProbeMs = integer('BROKER_PROBE_TIMEOUT_MS', 2000, 200, 10000);
    this.lag.enable();
  }
  install(app: Express) {
    app.locals.runtime = this;
    // Proxy trust is explicit CIDR/address configuration, never an unbounded hop.
    app.set(
      'trust proxy',
      process.env.TRUST_PROXY_CIDRS?.split(',')
        .map(s => s.trim())
        .filter(Boolean) ?? false,
    );
    app.use((req, res, next) => {
      const requestId = acceptRequestId(req.headers['x-request-id']) ?? randomUUID();
      res.setHeader('X-Request-Id', requestId);
      res.setHeader('X-Service-Instance', this.instance);
      const started = performance.now(),
        route = routeTemplate(req.originalUrl),
        method = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(req.method)
          ? req.method
          : 'OTHER';
      const timer = setTimeout(() => {
        if (!res.headersSent)
          res
            .status(503)
            .setHeader('Retry-After', '2')
            .json({ error: 'Request deadline reached. For an uncertain write, retry the same request key.' });
      }, this.deadlineMs);
      res.once('finish', () => {
        clearTimeout(timer);
        const seconds = (performance.now() - started) / 1000,
          key = `${method}|${route}|${res.statusCode}`;
        const m = this.http.get(key) ?? { count: 0, sum: 0, counts: buckets.map(() => 0) };
        m.count++;
        m.sum += seconds;
        buckets.forEach((b, i) => {
          if (seconds <= b) m.counts[i]!++;
        });
        this.http.set(key, m);
        // Fixed fields only: no body, query string, credentials or raw error.
        process.stdout.write(
          JSON.stringify({
            service: this.options.service,
            instance: this.instance,
            requestId,
            route,
            method,
            status: res.statusCode,
            latencyMs: Math.round(seconds * 1000),
          }) + '\n',
        );
      });
      res.once('close', () => clearTimeout(timer));
      if (this.stopping) {
        res.status(503).json({ error: 'Service is draining.' });
        return;
      }
      context.run({ requestId }, next);
    });
    app.get('/health/live', (_req, res) => res.json({ service: this.options.service, status: 'alive' }));
    app.get('/health/ready', async (_req, res) => {
      await this.refresh(true);
      if (res.writableEnded) return;
      res.status(this.database && !this.stopping ? 200 : 503).json({
        service: this.options.service,
        status:
          !this.database || this.stopping
            ? 'unavailable'
            : this.redis && this.broker && (this.own?.pending ?? 0) < this.softLimit
              ? 'ready'
              : 'degraded',
        database: this.database,
        redis: this.redis,
        broker: this.broker,
        outboxPending: this.own?.pending ?? null,
      });
    });
    app.get('/metrics', async (req, res) => {
      if (!acceptsCredential(req.headers['x-service-token'], this.metricsToken)) {
        res.status(401).json({ error: 'Observability authentication required.' });
        return;
      }
      await this.refresh(true);
      if (!res.writableEnded) res.type('text/plain; version=0.0.4').send(this.metrics());
    });
    app.use('/api/auth', express.json({ limit: '16kb' }));
    app.use('/api', async (req, res, next) => {
      try {
        if (req.path === '/health' || req.method === 'OPTIONS') {
          next();
          return;
        }
        const policy = this.policy(req);
        let decision;
        // Reads that are not auth or public are counted per instance: no Redis round trip, and Redis
        // being down does not touch them.
        if (policy.local) decision = this.limiter.spendLocal(policy.group, policy.buckets);
        else
          try {
            decision = await this.limiter.spend(policy.group, policy.buckets);
            this.redis = true;
          } catch {
            this.redis = false;
            this.failures++;
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
            decision = this.limiter.localRead(policy.group, local);
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
          if (!this.database || !this.own || Date.now() - this.ownAt >= 6000) {
            res.setHeader('Retry-After', '2');
            res.status(503).json({ error: 'Event backlog authority unavailable. Retry the same request key later.' });
            return;
          }
          if (this.own.pending >= this.hardLimit) {
            res.setHeader('Retry-After', '5');
            res.status(503).json({ error: 'Event backlog capacity reached. Retry the same request key later.' });
            return;
          }
        }
        if (!res.writableEnded) next();
      } catch {
        if (!res.headersSent) res.status(503).json({ error: 'Request admission unavailable.' });
      }
    });
  }
  private policy(req: Request): { group: string; buckets: Bucket[]; read: boolean; local?: boolean } {
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
      actor = requestActor(req, this.options.verify);
    } catch {}
    const identity = actor ? 'actor:' + actor.sub : ip,
      read = ['GET', 'HEAD'].includes(req.method);
    if (req.method === 'POST' && req.path === '/auth/me/password')
      return {
        group: 'auth-password',
        read: false,
        buckets: [b(identity, limit('AUTH_PASSWORD_ACTOR_LIMIT', 10)), b(ip, 200)],
      };
    const group = this.options.service + (read ? '-read' : '-write');
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
  // One connection serves every probe: a new one every 3 s per process is needless churn for the broker.
  private async probeConnection(url: string) {
    if (this.probing) return this.probing;
    const connection = await amqp.connect(url, { timeout: 500 });
    connection.on('error', () => {});
    connection.once('close', () => {
      if (this.probing === connection) this.probing = undefined;
    });
    return (this.probing = connection);
  }
  private async dropProbeConnection() {
    const broken = this.probing;
    this.probing = undefined;
    await broken?.close().catch(() => {});
  }
  // A kept connection no longer fails fast through the connect timeout, so the whole probe has a deadline.
  private async brokerProbe() {
    const url = process.env.BROKER_URL;
    if (!url) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>(resolve => {
      timer = setTimeout(() => {
        void this.dropProbeConnection();
        resolve(false);
      }, this.brokerProbeMs);
    });
    try {
      return await Promise.race([this.probeBroker(url), expired]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async probeBroker(url: string) {
    try {
      const connection = await this.probeConnection(url);
      const prefix = process.env.BROKER_PREFIX;
      if (prefix && this.options.service !== 'core') {
        // A missing queue closes its channel, so each check has its own; -1 means unknown.
        const ready = async (name: string) => {
          const channel = await connection.createChannel();
          channel.on('error', () => {});
          try {
            return (await channel.checkQueue(prefix + '.' + name)).messageCount;
          } catch {
            return -1;
          } finally {
            await channel.close().catch(() => {});
          }
        };
        const total = async (names: readonly string[]) => {
          let sum = 0;
          for (const name of names) {
            const n = await ready(name);
            if (n < 0) return -1;
            sum += n;
          }
          return sum;
        };
        const consumers = this.options.queues?.consumers ?? [this.options.service],
          retry = this.options.queues?.retrySuffixes ?? [];
        this.queueReady = await total(consumers);
        this.dlqReady = await total(consumers.map(c => c + '.dlq'));
        this.retryReady = retry.length ? await total(consumers.flatMap(c => retry.map(s => c + s))) : -1;
      }
      return true;
    } catch {
      // The connection may be the broken part; the next probe opens a new one.
      await this.dropProbeConnection();
      return false;
    }
  }
  async refresh(force = false) {
    if (this.stopping) return;
    if (!force && Date.now() - this.ownAt < 3000) return;
    if (!this.checking)
      this.checking = (async () => {
        // Timestamp the actual backlog read, not the later AMQP completion. A
        // stuck broker probe must never make old DB evidence look fresh again.
        const database = Promise.resolve()
          .then(() => this.options.probe())
          .then(
            value => {
              this.database = true;
              this.own = value;
              this.ownAt = Date.now();
            },
            () => {
              this.database = false;
              this.own = undefined;
              this.ownAt = 0;
            },
          );
        const [, redis, broker] = await Promise.allSettled([database, this.limiter.ping(), this.brokerProbe()]);
        this.redis = redis.status === 'fulfilled' && redis.value;
        this.broker = broker.status === 'fulfilled' && broker.value;
      })().finally(() => {
        this.checking = undefined;
      });
    await this.checking;
  }
  async start() {
    await this.refresh(true);
    if (!this.database) {
      this.close();
      throw new Error('SERVICE_DATABASE_OR_MIGRATION_UNAVAILABLE');
    }
    if (!this.stopping && !this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        void this.refresh(true).catch(() => {
          this.database = false;
          this.own = undefined;
        });
      }, 3000);
      this.refreshTimer.unref();
    }
  }
  metrics() {
    const s = this.options.service,
      label = `service="${s}"`,
      lines: string[] = [];
    const gauge = (name: string, value: number) =>
      lines.push(`pet_${name}{${label}} ${Number.isFinite(value) ? value : 0}`);
    for (const [k, m] of this.http) {
      const [method, route, status] = k.split('|');
      const labels = `${label},method="${method}",route="${route}",status="${status}"`;
      buckets.forEach((b, i) => lines.push(`pet_http_duration_seconds_bucket{${labels},le="${b}"} ${m.counts[i]}`));
      lines.push(
        `pet_http_duration_seconds_bucket{${labels},le="+Inf"} ${m.count}`,
        `pet_http_duration_seconds_sum{${labels}} ${m.sum}`,
        `pet_http_duration_seconds_count{${labels}} ${m.count}`,
      );
    }
    gauge('redis_available', Number(this.redis));
    gauge('broker_available', Number(this.broker));
    gauge('db_available', Number(this.database));
    gauge('limiter_shared_total', this.limiter.stats.shared);
    gauge('limiter_degraded_total', this.limiter.stats.degraded);
    gauge('limiter_rejected_total', this.limiter.stats.rejected);
    gauge('limiter_local_total', this.limiter.stats.local);
    gauge('redis_failures_total', this.failures);
    const cpu = process.cpuUsage();
    gauge('cpu_seconds_total', (cpu.user + cpu.system) / 1000000);
    gauge('rss_bytes', process.memoryUsage().rss);
    gauge('event_loop_p99_seconds', this.lag.percentile(99) / 1e9);
    gauge('queue_ready', this.queueReady);
    gauge('retry_ready', this.retryReady);
    gauge('dlq_ready', this.dlqReady);
    if (this.own) {
      gauge('outbox_pending', this.own.pending);
      gauge('outbox_oldest_seconds', this.own.outboxAgeSeconds);
      gauge('outbox_retry_attempts', this.own.outboxRetries);
      gauge('billing_pending', this.own.billingPending);
      gauge('billing_oldest_seconds', this.own.billingAgeSeconds);
      gauge('db_lock_waits', this.own.dbLockWaits);
    }
    // 1 while a breaker is open or half-open (its probe has not yet succeeded), 0 once closed.
    const circuits = new Map<string, { open: number; opened: number; rejected: number }>();
    for (const breaker of circuitBreakers()) {
      const c = circuits.get(breaker.target) ?? { open: 0, opened: 0, rejected: 0 };
      c.open = Math.max(c.open, breaker.state === 'closed' ? 0 : 1);
      c.opened += breaker.counters.opened;
      c.rejected += breaker.counters.rejected;
      circuits.set(breaker.target, c);
    }
    for (const [target, c] of circuits)
      lines.push(
        `pet_circuit_open{${label},target="${target}"} ${c.open}`,
        `pet_circuit_opened_total{${label},target="${target}"} ${c.opened}`,
        `pet_circuit_rejected_total{${label},target="${target}"} ${c.rejected}`,
      );
    for (const [k, v] of Object.entries(this.options.extras?.() ?? {})) {
      if (/^[a-z_]{1,60}$/.test(k)) gauge(k, v);
    }
    return lines.join('\n') + '\n';
  }
  close() {
    this.stopping = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.limiter.close();
    this.lag.disable();
    void this.probing?.close().catch(() => {});
    this.probing = undefined;
  }
  async drain(server: Server, disconnect: () => Promise<void>) {
    this.stopping = true;
    const deadline = integer('SHUTDOWN_TIMEOUT_MS', 10000, 100, 30000);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => server.closeAllConnections(), deadline);
      timer.unref();
      server.close(e => {
        clearTimeout(timer);
        e ? reject(e) : resolve();
      });
      server.closeIdleConnections();
    });
    this.close();
    await this.checking;
    await disconnect();
  }
}
export function createRuntime(options: RuntimeOptions) {
  return runtimeEnabled() ? new ServiceRuntime(options) : undefined;
}
