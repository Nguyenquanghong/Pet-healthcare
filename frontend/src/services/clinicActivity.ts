import type {ActivityCategory, ActivityFilters} from '../types/clinicActivity';
import type {AppointmentStatus} from '../types/appointment';
const day = 86_400_000;
const activityStatuses: AppointmentStatus[] = ['pending','confirmed','checked_in','in_progress','completed','cancelled','no_show'];
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
function validActivityDay(value: string) {
  return /^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && iso(Date.parse(value + 'T00:00:00Z')) === value;
}
export function activityPreset(preset: 'today' | '30days' | '12months', today = iso(Date.now() + 7 * 3_600_000)): Pick<ActivityFilters, 'from' | 'to' | 'groupBy'> {
  const end = Date.parse(today + 'T00:00:00Z'), d = new Date(end);
  return {from: preset === 'today' ? today : preset === '30days' ? iso(end - 29 * day) : iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 11, 1)),
    to: today, groupBy: preset === '12months' ? 'month' : 'day'};
}
export function validActivityFilters(f: ActivityFilters) {
  return validActivityDay(f.from) && validActivityDay(f.to) && f.from <= f.to
    && (Date.parse(f.to) - Date.parse(f.from)) / day < 366
    && ['day','month'].includes(f.groupBy) && ['all','clinic','spa'].includes(f.category);
}
export function activityUrl(f: ActivityFilters) {
  return '/dashboard/clinic/activity?' + new URLSearchParams({from:f.from, to:f.to, groupBy:f.groupBy, category:f.category}).toString();
}
export function activityDrilldown(date: string, category: ActivityCategory, status?: AppointmentStatus) {
  if (!validActivityDay(date) || !['all','clinic','spa'].includes(category) || status && !activityStatuses.includes(status)) throw new Error('Invalid activity drilldown');
  const p = new URLSearchParams({activity:'1', date});
  if (category !== 'all') p.set('category', category === 'clinic' ? 'medical' : 'spa');
  if (status) p.set('status', status);
  return '/admin/appointments?' + p.toString();
}
export function readActivityDrilldown(search: string) {
  const p = new URLSearchParams(search), active = p.get('activity') === '1';
  const date = p.get('date') ?? '', category = p.get('category') ?? 'all', status = p.get('status') ?? 'all';
  const error = active && (!validActivityDay(date) || !['all','medical','spa'].includes(category)
    || status !== 'all' && !activityStatuses.includes(status as AppointmentStatus)
    || [...p.keys()].some(key => p.getAll(key).length !== 1)) ? 'Bộ lọc từ thống kê không hợp lệ. Vui lòng chọn lại ngày trên dashboard.' : '';
  return {active, error, date: active ? date : '', category: (active ? category : 'all') as 'all'|'medical'|'spa', status: active ? status : 'all'};
}
