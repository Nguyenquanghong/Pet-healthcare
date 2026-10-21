import {Prisma, type PrismaClient} from '../../generated/client/index.js';
import {BusinessError} from '../../domain/error.js';
import {activitySpaTypes, buildActivityBusiness} from '../../application/queries/clinicActivity.js';
import type {ActivityBusiness, ActivityFilter, ActivityGroup, ActivityMode, ActivityResponse} from '../../application/ports/clinicActivityQueries.js';

type Snapshot = {business: ActivityBusiness; started: number; computedAt: string};
type Meta = ActivityResponse['meta'];
// Background evidence owned by the API process (ActivitySummaryEvidence). The
// reader never runs reconciliation itself and never treats row health as summary health.
export type SummaryEligibility = {ineligibleReason(generation: string): string | undefined; observed(): {checkedAt: number; lagMs: number} | undefined};
const busy = () => new BusinessError(503, 'Clinic activity is busy. Retry later.');
class Ineligible extends Error {constructor(readonly reason: string) {super(reason);}}

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
// Same grouped shape as the source query: one row per (date,type,status) bucket of
// one V2 generation. Zero counters are skipped; buildActivityBusiness zero-fills.
export function activitySummaryStatement(filter: ActivityFilter, generation: string) {
  return Prisma.sql`SELECT s."appointmentDate"::text AS date, s.type, s.status, s."appointmentCount" AS n
    FROM "AppointmentDailySummary" s
    WHERE s.generation = ${generation}
      AND s."appointmentDate" >= ${filter.previousFrom}::date
      AND s."appointmentDate" <= ${filter.to}::date ${categorySql(filter, Prisma.sql`s.type`)}
      AND s."appointmentCount" <> 0`;
}

// Instance-owned per database/API lifecycle. Cache contains business data only;
// the HTTP router verifies current admin authorization on EVERY request.
// mode: fixed source|cached|summary, or 'control' = operator-owned
// ClinicActivityControl polled in the background (unknown/stale => source).
export class ClinicActivityQueries {
  private readonly cache = new Map<string, Snapshot>();
  private readonly pending = new Map<string, Promise<Snapshot>>();
  private sources = 0;
  private computing = false;
  private coalescing = 0;
  private readonly waiters: {grant: () => void}[] = [];
  private control?: {mode: ActivityMode; at: number};
  private polling?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly db: PrismaClient, readonly mode: ActivityMode | 'control' = 'source',
    private readonly now = () => performance.now(), private readonly wallNow = () => new Date(),
    private readonly evidence?: SummaryEligibility, private readonly controlPollMs = 1000) {
    if (!['source', 'cached', 'summary', 'control'].includes(mode)) throw new Error('INVALID_CLINIC_ACTIVITY_MODE');
  }
  refreshControl() {
    if (this.polling) return this.polling;
    this.polling = this.db.clinicActivityControl.findUnique({where: {id: 1}, select: {servingMode: true}}).then(row => {
      const mode = row?.servingMode;
      this.control = mode === 'source' || mode === 'cached' || mode === 'summary' ? {mode, at: this.now()} : undefined;
    }, () => {this.control = undefined;}).finally(() => {this.polling = undefined;});
    return this.polling;
  }
  // Effective mode and, when the operator control is unknown/stale, the reason
  // the authoritative source is served instead.
  effectiveMode(): {mode: ActivityMode; reason?: string} {
    if (this.mode !== 'control') return {mode: this.mode};
    const c = this.control, age = c ? this.now() - c.at : -1;
    return c && age >= 0 && age <= 3 * this.controlPollMs ? {mode: c.mode} : {mode: 'source', reason: 'activity_control_unknown'};
  }
  start() {if (this.mode !== 'control' || this.timer) return; void this.refreshControl(); this.timer = setInterval(() => void this.refreshControl(), this.controlPollMs); this.timer.unref();}
  async close() {clearInterval(this.timer); this.timer = undefined; await this.polling;}
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
  // Authoritative source and the whole-response summary fallback share this
  // budget: at most 2 concurrent per replica, SQL<=1500ms, tx<=remaining, 50ms wait.
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
  // P: pointer, generation state, fence and the summary rows are read in ONE
  // RepeatableRead read-only snapshot; evidence must be eligible for that same
  // generation. Anything else is a typed ineligibility, never a partial answer.
  private async summary(filter: ActivityFilter, deadline: number) {
    const remaining = Math.floor(deadline - this.now()); if (remaining <= 0) throw new Ineligible('summary_budget_exhausted');
    return this.db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout='${Math.min(1500, remaining)}ms'`);
      const control = await tx.readProjectionControl.findUnique({where: {projectionName: 'appointments'}, include: {activeGeneration: true}});
      const g = control?.activeGeneration;
      if (!g || g.state !== 'ACTIVE' || !g.verifiedAt || g.projectionName !== 'appointments') throw new Ineligible('summary_generation_missing');
      if (g.schemaVersion !== 2) throw new Ineligible('summary_not_v2');
      if (await tx.readRebuildRun.count({where: {frozen: true}})) throw new Ineligible('summary_frozen');
      const reason = this.evidence ? this.evidence.ineligibleReason(g.id) : 'summary_evidence_unconfigured';
      if (reason) throw new Ineligible(reason);
      const observed = this.evidence!.observed();
      if (!observed) throw new Ineligible('summary_evidence_missing');
      const rows = await tx.$queryRaw<ActivityGroup[]>(activitySummaryStatement(filter, g.id));
      return {business: buildActivityBusiness(filter, rows), generation: g.id, observed};
    }, {isolationLevel: 'RepeatableRead', maxWait: Math.min(50, remaining), timeout: remaining});
  }
  private response(business: ActivityBusiness, meta: Omit<Meta, 'generatedAt'>): ActivityResponse {
    return {...structuredClone(business), meta: {...meta, generatedAt: this.wallNow().toISOString()}};
  }
  async read(filter: ActivityFilter): Promise<ActivityResponse> {
    const deadline = this.now() + 2500, {mode, reason: controlReason} = this.effectiveMode();
    if (mode === 'summary') {
      let reason: string;
      try {
        const s = await this.summary(filter, deadline);
        return this.response(s.business, {source: 'summary', generation: s.generation, cacheComputedAt: null,
          freshness: {state: 'within-policy', checkedAt: new Date(s.observed.checkedAt).toISOString(), observedLagMs: s.observed.lagMs}, degraded: false, reason: null});
      } catch (error) {
        if (error instanceof BusinessError && error.status < 500) throw error;
        reason = error instanceof Ineligible ? error.reason : 'summary_query_error';
      }
      // Whole-response authoritative fallback; over budget => 503 Retry-After.
      const snapshot = await this.source(filter, deadline);
      return this.response(snapshot.business, {source: 'source', generation: null, cacheComputedAt: null,
        freshness: {state: 'current', checkedAt: snapshot.computedAt, observedLagMs: null}, degraded: true, reason});
    }
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
      source: cached ? 'cached' : 'source', generation: null,
      cacheComputedAt: cached ? snapshot.computedAt : null,
      freshness: {state: cached ? 'within-policy' : 'current', checkedAt: snapshot.computedAt,
        observedLagMs: cached ? Math.max(0, this.now() - snapshot.started) : null},
      degraded: controlReason !== undefined, reason: controlReason ?? null,
    });
  }
}
