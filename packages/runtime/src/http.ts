import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Express } from 'express';
import express from 'express';
import type { Server } from 'node:http';
import type amqp from 'amqplib';
import { SharedLimiter } from './limiter.js';
import { acceptsCredential, credential, integer, runtimeEnabled } from './config.js';
import type { Actor } from './jwt.js';
import { BrokerProbe } from './brokerProbe.js';
import { closeServer } from './drain.js';
import { limitAdmission, limitPolicy } from './limitPolicy.js';
import { HttpMetrics, newHealth, renderMetrics, routeTemplate, type OwnSnapshot } from './metrics.js';
import { requestScope } from './requestContext.js';
export type { OwnSnapshot } from './metrics.js';
// queues: the consumer queues under BROKER_PREFIX and their retry queue suffixes (P03),
// summed into queue_ready, retry_ready and dlq_ready. Default: the service's own queue.
export type RuntimeOptions = {
  service: 'core' | 'clinic' | 'notification';
  verify: (token: string) => Actor;
  probe: () => Promise<OwnSnapshot>;
  extras?: () => Record<string, number>;
  queues?: { consumers: readonly string[]; retrySuffixes: readonly string[] };
  // How the readiness probe reaches the broker; tests inject a fake.
  connect?: (url: string, options: { timeout: number }) => Promise<amqp.ChannelModel>;
};
export class ServiceRuntime {
  readonly limiter: SharedLimiter;
  readonly instance: string;
  private stopping = false;
  private checking: Promise<void> | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private readonly health = newHealth();
  private readonly http = new HttpMetrics();
  private readonly broker: BrokerProbe;
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
    this.broker = new BrokerProbe({
      service: options.service,
      queues: options.queues,
      connect: options.connect,
      timeoutMs: this.brokerProbeMs,
      isStopping: () => this.stopping,
    });
    this.lag.enable();
  }
  install(app: Express) {
    const { service, verify } = this.options;
    app.locals.runtime = this;
    // Proxy trust is explicit CIDR/address configuration, never an unbounded hop.
    app.set(
      'trust proxy',
      process.env.TRUST_PROXY_CIDRS?.split(',')
        .map(s => s.trim())
        .filter(Boolean) ?? false,
    );
    app.use(
      requestScope({
        service,
        instance: this.instance,
        deadlineMs: this.deadlineMs,
        routeOf: routeTemplate,
        isStopping: () => this.stopping,
        record: (method, route, status, seconds) => this.http.record(method, route, status, seconds),
      }),
    );
    app.get('/health/live', (_req, res) => res.json({ service, status: 'alive' }));
    app.get('/health/ready', async (_req, res) => {
      await this.refresh(true);
      if (res.writableEnded) return;
      const { database, redis, broker, own } = this.health;
      res.status(database && !this.stopping ? 200 : 503).json({
        service,
        status:
          !database || this.stopping
            ? 'unavailable'
            : redis && broker && (own?.pending ?? 0) < this.softLimit
              ? 'ready'
              : 'degraded',
        database,
        redis,
        broker,
        outboxPending: own?.pending ?? null,
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
    app.use(
      '/api',
      limitAdmission({
        limiter: this.limiter,
        health: this.health,
        hardLimit: this.hardLimit,
        policyOf: req => limitPolicy(req, service, verify),
      }),
    );
  }
  // The broker probe; refresh calls it through here so a test can replace it.
  private brokerProbe() {
    return this.broker.run();
  }
  async refresh(force = false) {
    if (this.stopping) return;
    if (!force && Date.now() - this.health.ownAt < 3000) return;
    if (!this.checking)
      this.checking = (async () => {
        // Timestamp the actual backlog read, not the later AMQP completion. A
        // stuck broker probe must never make old DB evidence look fresh again.
        const database = Promise.resolve()
          .then(() => this.options.probe())
          .then(
            value => {
              this.health.database = true;
              this.health.own = value;
              this.health.ownAt = Date.now();
            },
            () => {
              this.health.database = false;
              this.health.own = undefined;
              this.health.ownAt = 0;
            },
          );
        const [, redis, broker] = await Promise.allSettled([database, this.limiter.ping(), this.brokerProbe()]);
        this.health.redis = redis.status === 'fulfilled' && redis.value;
        this.health.broker = broker.status === 'fulfilled' && broker.value;
      })().finally(() => {
        this.checking = undefined;
      });
    await this.checking;
  }
  async start() {
    await this.refresh(true);
    if (!this.health.database) {
      this.close();
      throw new Error('SERVICE_DATABASE_OR_MIGRATION_UNAVAILABLE');
    }
    if (!this.stopping && !this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        void this.refresh(true).catch(() => {
          this.health.database = false;
          this.health.own = undefined;
        });
      }, 3000);
      this.refreshTimer.unref();
    }
  }
  metrics() {
    return renderMetrics({
      service: this.options.service,
      http: this.http,
      health: this.health,
      limiter: this.limiter,
      lag: this.lag,
      queueReady: this.broker.queueReady,
      dlqReady: this.broker.dlqReady,
      retryReady: this.broker.retryReady,
      extras: this.options.extras?.() ?? {},
    });
  }
  close() {
    this.stopping = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.limiter.close();
    this.lag.disable();
    this.broker.close();
  }
  async drain(server: Server, disconnect: () => Promise<void>) {
    this.stopping = true;
    await closeServer(server);
    this.close();
    await this.checking;
    await disconnect();
  }
}
export function createRuntime(options: RuntimeOptions) {
  return runtimeEnabled() ? new ServiceRuntime(options) : undefined;
}
