import { monitorEventLoopDelay } from 'node:perf_hooks';
import { circuitBreakers } from './circuitBreaker.js';
import type { SharedLimiter } from './limiter.js';
export type OwnSnapshot = {
  pending: number;
  outboxAgeSeconds: number;
  outboxRetries: number;
  billingPending: number;
  billingAgeSeconds: number;
  dbLockWaits: number;
};
// What the background refresh learned about the service's dependencies; read by readiness, admission and /metrics.
export type RuntimeHealth = {
  database: boolean;
  redis: boolean;
  broker: boolean;
  own: OwnSnapshot | undefined;
  ownAt: number;
  failures: number;
};
export const newHealth = (): RuntimeHealth => ({
  database: false,
  redis: false,
  broker: false,
  own: undefined,
  ownAt: 0,
  failures: 0,
});
const buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10];
export function routeTemplate(path: string) {
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
// Request count and latency histogram per method, route and status.
export class HttpMetrics {
  private readonly series = new Map<string, HttpMetric>();
  record(method: string, route: string, status: number, seconds: number) {
    const key = `${method}|${route}|${status}`;
    const m = this.series.get(key) ?? { count: 0, sum: 0, counts: buckets.map(() => 0) };
    m.count++;
    m.sum += seconds;
    buckets.forEach((b, i) => {
      if (seconds <= b) m.counts[i]!++;
    });
    this.series.set(key, m);
  }
  entries() {
    return this.series.entries();
  }
}
export type MetricsInput = {
  service: string;
  http: HttpMetrics;
  health: RuntimeHealth;
  limiter: SharedLimiter;
  lag: ReturnType<typeof monitorEventLoopDelay>;
  queueReady: number;
  dlqReady: number;
  retryReady: number;
  extras: Record<string, number>;
};
export function renderMetrics(input: MetricsInput) {
  const { health, limiter } = input,
    label = `service="${input.service}"`,
    lines: string[] = [];
  const gauge = (name: string, value: number) =>
    lines.push(`pet_${name}{${label}} ${Number.isFinite(value) ? value : 0}`);
  for (const [k, m] of input.http.entries()) {
    const [method, route, status] = k.split('|');
    const labels = `${label},method="${method}",route="${route}",status="${status}"`;
    buckets.forEach((b, i) => lines.push(`pet_http_duration_seconds_bucket{${labels},le="${b}"} ${m.counts[i]}`));
    lines.push(
      `pet_http_duration_seconds_bucket{${labels},le="+Inf"} ${m.count}`,
      `pet_http_duration_seconds_sum{${labels}} ${m.sum}`,
      `pet_http_duration_seconds_count{${labels}} ${m.count}`,
    );
  }
  gauge('redis_available', Number(health.redis));
  gauge('broker_available', Number(health.broker));
  gauge('db_available', Number(health.database));
  gauge('limiter_shared_total', limiter.stats.shared);
  gauge('limiter_degraded_total', limiter.stats.degraded);
  gauge('limiter_rejected_total', limiter.stats.rejected);
  gauge('limiter_local_total', limiter.stats.local);
  gauge('redis_failures_total', health.failures);
  const cpu = process.cpuUsage();
  gauge('cpu_seconds_total', (cpu.user + cpu.system) / 1000000);
  gauge('rss_bytes', process.memoryUsage().rss);
  gauge('event_loop_p99_seconds', input.lag.percentile(99) / 1e9);
  gauge('queue_ready', input.queueReady);
  gauge('retry_ready', input.retryReady);
  gauge('dlq_ready', input.dlqReady);
  if (health.own) {
    gauge('outbox_pending', health.own.pending);
    gauge('outbox_oldest_seconds', health.own.outboxAgeSeconds);
    gauge('outbox_retry_attempts', health.own.outboxRetries);
    gauge('billing_pending', health.own.billingPending);
    gauge('billing_oldest_seconds', health.own.billingAgeSeconds);
    gauge('db_lock_waits', health.own.dbLockWaits);
  }
  // 1 only while a breaker is refusing calls (open, trial wait not over). Half-open, where the next call is let
  // through, is 0: an idle system must not look broken until a request closes the breaker.
  const circuits = new Map<string, { open: number; opened: number; rejected: number }>();
  for (const breaker of circuitBreakers()) {
    const c = circuits.get(breaker.target) ?? { open: 0, opened: 0, rejected: 0 };
    c.open = Math.max(c.open, breaker.rejecting ? 1 : 0);
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
  for (const [k, v] of Object.entries(input.extras)) {
    if (/^[a-z_]{1,60}$/.test(k)) gauge(k, v);
  }
  return lines.join('\n') + '\n';
}
