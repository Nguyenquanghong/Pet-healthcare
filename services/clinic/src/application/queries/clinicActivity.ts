import {appointmentStatuses, appointmentTypes} from '../ports/appointments.js';
import type {AppointmentStatus, AppointmentType} from '../ports/appointments.js';
import type {ActivityBusiness, ActivityCounts, ActivityFilter, ActivityGroup} from '../ports/clinicActivityQueries.js';
import {BusinessError} from '../../domain/error.js';
import {calendarDate} from '../../domain/validation.js';

export const activityDayMs = 86_400_000;
export const activitySpaTypes = ['spa_bath', 'spa_grooming', 'spa_combo'] as const;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const invalid = () => new BusinessError(422, 'Invalid activity period or filters.');

export function parseActivityFilter(raw: Record<string, unknown>): ActivityFilter {
  if (Object.keys(raw).some(k => !['from', 'to', 'groupBy', 'category'].includes(k))) throw invalid();
  const date = (v: unknown) => {
    if (typeof v !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(v)) throw invalid();
    return calendarDate(v, 'Activity date').getTime();
  };
  const from = date(raw.from), to = date(raw.to), days = (to - from) / activityDayMs + 1;
  if (days < 1 || days > 366) throw invalid();
  const groupBy = raw.groupBy ?? 'day', category = raw.category ?? 'all';
  if (groupBy !== 'day' && groupBy !== 'month' || category !== 'all' && category !== 'clinic' && category !== 'spa') throw invalid();
  const previousFrom = iso(from - days * activityDayMs), previousTo = iso(from - activityDayMs);
  date(previousFrom); // The adjacent period must also fit the supported calendar.
  return {from: iso(from), to: iso(to), previousFrom, previousTo, groupBy, category};
}

type BigCounts = Record<AppointmentStatus, bigint>;
const emptyCounts = (): BigCounts => Object.fromEntries(appointmentStatuses.map(s => [s, 0n])) as BigCounts;
export function activitySafeCount(n: bigint): number {
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new BusinessError(503, 'Activity counts are unavailable.');
  return Number(n);
}
function serializeCounts(counts: BigCounts): ActivityCounts {
  const total = activitySafeCount(appointmentStatuses.reduce((n, s) => n + counts[s], 0n));
  const byStatus = Object.fromEntries(appointmentStatuses.map(s => [s, activitySafeCount(counts[s])])) as ActivityCounts['byStatus'];
  return {total, byStatus, cancellationRate: total ? byStatus.cancelled / total : null, noShowRate: total ? byStatus.no_show / total : null};
}

// Only grouped rows enter this function; the source SQL never loads appointment DTOs.
export function buildActivityBusiness(filter: ActivityFilter, rows: ActivityGroup[]): ActivityBusiness {
  const current = emptyCounts(), previous = emptyCounts();
  const byType = Object.fromEntries(appointmentTypes.map(t => [t, 0n])) as Record<AppointmentType, bigint>;
  const buckets: {from: string; to: string; counts: BigCounts}[] = [];
  const toMs = calendarDate(filter.to, 'to').getTime();
  for (let start = calendarDate(filter.from, 'from').getTime(); start <= toMs;) {
    const d = new Date(start);
    const end = filter.groupBy === 'day' ? start : Math.min(toMs, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - activityDayMs);
    buckets.push({from: iso(start), to: iso(end), counts: emptyCounts()});
    start = end + activityDayMs;
  }
  const bucketKey = (date: string) => filter.groupBy === 'month' ? date.slice(0, 7) : date;
  const byBucket = new Map(buckets.map(bucket => [bucketKey(bucket.from), bucket]));
  for (const row of rows) {
    if (!appointmentTypes.includes(row.type) || !appointmentStatuses.includes(row.status) || typeof row.n !== 'bigint'
      || row.n < 0n || row.date < filter.previousFrom || row.date > filter.to
      || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(row.date)) throw new BusinessError(503, 'Activity data is unavailable.');
    calendarDate(row.date, 'Activity source date');
    const spa = (activitySpaTypes as readonly string[]).includes(row.type);
    if (filter.category === 'spa' && !spa || filter.category === 'clinic' && spa) throw new BusinessError(503, 'Activity data is unavailable.');
    if (row.date < filter.from) previous[row.status] += row.n;
    else {
      current[row.status] += row.n; byType[row.type] += row.n;
      const bucket = byBucket.get(bucketKey(row.date))!;
      bucket.counts[row.status] += row.n;
    }
  }
  const c = serializeCounts(current), p = serializeCounts(previous), delta = c.total - p.total;
  return {
    period: {from: filter.from, to: filter.to, groupBy: filter.groupBy, category: filter.category, timezone: 'Asia/Ho_Chi_Minh'},
    previousPeriod: {from: filter.previousFrom, to: filter.previousTo},
    current: {...c, byType: appointmentTypes.map(type => ({type, total: activitySafeCount(byType[type])})),
      buckets: buckets.map(b => {const s = serializeCounts(b.counts); return {from: b.from, to: b.to, total: s.total, byStatus: s.byStatus};})},
    previous: p, comparison: {totalDelta: delta, totalDeltaPercent: p.total ? delta / p.total * 100 : null},
  };
}
