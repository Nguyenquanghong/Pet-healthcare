import type {AppointmentStatus, AppointmentType} from './appointments.js';

export type ActivityFilter = {
  from: string; to: string; previousFrom: string; previousTo: string;
  groupBy: 'day' | 'month'; category: 'all' | 'clinic' | 'spa';
};
export type ActivityGroup = {date: string; type: AppointmentType; status: AppointmentStatus; n: bigint};
export type ActivityCounts = {
  total: number; byStatus: Record<AppointmentStatus, number>;
  cancellationRate: number | null; noShowRate: number | null;
};
export type ActivityBusiness = {
  period: Pick<ActivityFilter, 'from' | 'to' | 'groupBy' | 'category'> & {timezone: 'Asia/Ho_Chi_Minh'};
  previousPeriod: {from: string; to: string};
  current: ActivityCounts & {
    byType: {type: AppointmentType; total: number}[];
    buckets: {from: string; to: string; total: number; byStatus: Record<AppointmentStatus, number>}[];
  };
  previous: ActivityCounts;
  comparison: {totalDelta: number; totalDeltaPercent: number | null};
};
// Metadata reflects the path actually used for the whole response: one fresh source
// snapshot (source) or a cached one (cached). degraded/reason remain for response compatibility (always false/null).
export type ActivityResponse = ActivityBusiness & {meta: {
  source: 'source' | 'cached'; generatedAt: string; cacheComputedAt: string | null;
  freshness: {state: 'current' | 'within-policy'; checkedAt: string; observedLagMs: number | null};
  degraded: boolean; reason: string | null;
}};
export type ActivityMode = 'source' | 'cached';
