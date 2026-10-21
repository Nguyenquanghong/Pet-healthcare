import type {AppointmentStatus, AppointmentType} from './appointment';
export type ActivityCategory = 'all' | 'clinic' | 'spa';
export type ActivityFilters = {from: string; to: string; groupBy: 'day' | 'month'; category: ActivityCategory};
type Counts = {total: number; byStatus: Record<AppointmentStatus, number>; cancellationRate: number | null; noShowRate: number | null};
export type ClinicActivity = {
  period: ActivityFilters & {timezone: string}; previousPeriod: {from: string; to: string};
  current: Counts & {byType: {type: AppointmentType; total: number}[]; buckets: {from: string; to: string; total: number; byStatus: Record<AppointmentStatus, number>}[]};
  previous: Counts; comparison: {totalDelta: number; totalDeltaPercent: number | null};
  meta: {source: 'source' | 'cached' | 'summary'; generatedAt: string; degraded: boolean; reason: string | null;
    freshness: {state: 'current' | 'within-policy' | 'unknown'}};
};
