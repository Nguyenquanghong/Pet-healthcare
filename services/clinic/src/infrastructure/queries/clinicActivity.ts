import {Prisma, type PrismaClient} from '../../generated/client/index.js';
import {BusinessError} from '../../domain/error.js';
import {activitySpaTypes, buildActivityBusiness} from '../../application/queries/clinicActivity.js';
import type {ActivityBusiness, ActivityFilter, ActivityGroup, ActivityMode, ActivityResponse} from '../../application/ports/clinicActivityQueries.js';

type Snapshot = {business: ActivityBusiness; started: number; computedAt: string};
const busy = () => new BusinessError(503, 'Clinic activity is busy. Retry later.');

const categorySql = (filter: ActivityFilter, column: Prisma.Sql) => filter.category === 'all' ? Prisma.empty : filter.category === 'spa'
  ? Prisma.sql`AND ${column}::text IN (${Prisma.join([...activitySpaTypes])})`
  : Prisma.sql`AND ${column}::text NOT IN (${Prisma.join([...activitySpaTypes])})`;
export function activitySourceStatement(filter: ActivityFilter) {
  return Prisma.sql`SELECT a.appointment_date::text AS date, a.type, a.status, count(*)::bigint AS n
    FROM appointments a
    WHERE a.appointment_date >= ${filter.previousFrom}::date
      AND a.appointment_date <= ${filter.to}::date ${categorySql(filter, Prisma.sql`a.type`)}
    GROUP BY a.appointment_date, a.type, a.status`;
}

// Instance-owned per database/API lifecycle. Cache contains business data only;
// the HTTP router verifies current admin authorization on EVERY request.
// mode: fixed `source` (every request counts the appointments table) or `cached`
// (identical filters share one source snapshot for up to 5 seconds).
export class ClinicActivityQueries {
  private readonly cache = new Map<string, Snapshot>();
  private readonly pending = new Map<string, Promise<Snapshot>>();
  private sources = 0;
  private computing = false;
  private coalescing = 0;
  private readonly waiters: {grant: () => void}[] = [];
  constructor(private readonly db: PrismaClient, readonly mode: ActivityMode = 'source',
    private readonly now = () => performance.now(), private readonly wallNow = () => new Date()) {
    if (!['source', 'cached'].includes(mode)) throw new Error('INVALID_CLINIC_ACTIVITY_MODE');
  }
  private slot(deadline: number): Promise<() => void> {
    if (this.now() >= deadline || this.waiters.length + this.coalescing >= 4) return Promise.reject(busy());
    const release = () => {const next = this.waiters.shift(); if (next) next.grant(); else this.computing = false;};
    if (!this.computing) {this.computing = true; return Promise.resolve(release);}
    return new Promise((resolve, reject) => {
      const entry = {grant: () => {clearTimeout(timer); if (this.now() >= deadline) {reject(busy()); release();} else resolve(release);}};
      const timer = setTimeout(() => {const i = this.waiters.indexOf(entry); if (i >= 0) this.waiters.splice(i, 1); reject(busy());}, Math.max(1, deadline - this.now()));
      this.waiters.push(entry);
    });
  }
  // At most 2 concurrent source reads per replica, SQL<=1500ms, tx<=remaining, 50ms wait.
  private async source(filter: ActivityFilter, deadline: number): Promise<Snapshot> {
    if (this.sources >= 2) throw busy();
    const remaining = Math.floor(deadline - this.now()); if (remaining <= 0) throw busy();
    this.sources++;
    try {
      return await this.db.$transaction(async tx => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout='${Math.min(1500, remaining)}ms'`);
        const started = this.now(), computedAt = this.wallNow().toISOString();
        const rows = await tx.$queryRaw<ActivityGroup[]>(activitySourceStatement(filter));
        return {business: buildActivityBusiness(filter, rows), started, computedAt};
      }, {isolationLevel: 'RepeatableRead', maxWait: Math.min(50, remaining), timeout: remaining});
    } finally {this.sources--;}
  }
  private async compute(key: string, filter: ActivityFilter, deadline: number) {
    const release = await this.slot(deadline);
    try {
      const result = await this.source(filter, deadline), now = this.now();
      for (const [k, value] of this.cache) if (now - value.started >= 5000 || now < value.started) this.cache.delete(k);
      if (now >= result.started && now - result.started < 5000) {
        while (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, result);
      }
      return result;
    } finally {release();}
  }
  private response(business: ActivityBusiness, meta: Omit<ActivityResponse['meta'], 'generatedAt'>): ActivityResponse {
    return {...structuredClone(business), meta: {...meta, generatedAt: this.wallNow().toISOString()}};
  }
  async read(filter: ActivityFilter): Promise<ActivityResponse> {
    const deadline = this.now() + 2500, mode = this.mode;
    const key = JSON.stringify(['activity-v1', 'admin', filter.from, filter.to, filter.groupBy, filter.category]);
    let snapshot: Snapshot, cached = false;
    const value = this.cache.get(key), age = value ? this.now() - value.started : -1;
    if (mode === 'cached' && value && age >= 0 && age < 5000) {snapshot = value; cached = true;}
    else if (mode === 'source') snapshot = await this.source(filter, deadline);
    else {
      const existing = this.pending.get(key);
      if (existing) {
        if (this.waiters.length + this.coalescing >= 4) throw busy();
        this.coalescing++;
        try {snapshot = await existing; cached = this.now() - snapshot.started >= 0 && this.now() - snapshot.started < 5000;}
        finally {this.coalescing--;}
      }
      else {
        const job = this.compute(key, filter, deadline); this.pending.set(key, job);
        try {snapshot = await job;} finally {this.pending.delete(key);}
      }
    }
    return this.response(snapshot.business, {
      source: cached ? 'cached' : 'source',
      cacheComputedAt: cached ? snapshot.computedAt : null,
      freshness: {state: cached ? 'within-policy' : 'current', checkedAt: snapshot.computedAt,
        observedLagMs: cached ? Math.max(0, this.now() - snapshot.started) : null},
      degraded: false, reason: null,
    });
  }
}
