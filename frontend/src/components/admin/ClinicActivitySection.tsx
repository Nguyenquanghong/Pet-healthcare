import {useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {useSession} from '../../store/SessionContext';
import {useApiQuery} from '../../services/useApiQuery';
import {activityDrilldown, activityPreset, activityUrl, validActivityFilters} from '../../services/clinicActivity';
import type {ActivityFilters, ClinicActivity} from '../../types/clinicActivity';
import {appointmentStatusLabels} from '../../utils/statusLabels';
import {QueryStatus} from '../ui/QueryStatus';

const number = (v: number) => v.toLocaleString('vi-VN');
const rate = (v: number | null) => v === null ? '—' : v.toLocaleString('vi-VN', {style:'percent', maximumFractionDigits:1});
const typeLabels: Record<string,string> = {general_checkup:'Khám tổng quát',vaccination:'Tiêm phòng',dental:'Nha khoa',dermatology:'Da liễu',surgery:'Phẫu thuật',hotel_consultation:'Tư vấn lưu trú',spa_bath:'Tắm Spa',spa_grooming:'Cắt tỉa',spa_combo:'Spa kết hợp',other:'Khác'};

export function ClinicActivitySection() {
  const {userRole, status} = useSession(), navigate = useNavigate();
  const [filters, setFilters] = useState<ActivityFilters>(() => ({...activityPreset('30days'), category:'all'}));
  const [draft, setDraft] = useState(filters), [error, setError] = useState(''), [detailDate, setDetailDate] = useState('');
  const query = useApiQuery<ClinicActivity>(activityUrl(filters), {enabled: status === 'authenticated' && userRole === 'admin', pollMs:15000, refreshOnTick:true, clearOnAuthError:true});
  if (userRole !== 'admin') return null;
  const data = query.data, current = data?.current;
  const max = Math.max(1, ...(current?.buckets.map(b => b.total) ?? []));
  const apply = (next: ActivityFilters) => {
    if (!validActivityFilters(next)) {setError('Chọn khoảng ngày hợp lệ, tối đa 366 ngày.'); return;}
    setError(''); setFilters(next); setDetailDate('');
  };
  return <section aria-label="Hoạt động khám và Spa" className="mt-6 rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
    <h2 className="text-base font-semibold text-slate-900">Hoạt động khám / Spa</h2>
    <p className="mt-1 text-xs text-slate-500">Số lịch theo ngày hẹn và trạng thái hiện tại, bao gồm lịch hủy và vắng mặt.</p>
    <div className="my-3 flex flex-wrap gap-2">
      {([['today','Hôm nay'],['30days','30 ngày'],['12months','12 tháng']] as const).map(([key,label]) => <button type="button" key={key} className="rounded border px-3 py-1 text-sm" onClick={() => {const next={...draft,...activityPreset(key)};setDraft(next);apply(next);}}>{label}</button>)}
    </div>
    <form className="flex flex-wrap items-end gap-3" onSubmit={e => {e.preventDefault();apply(draft);}}>
      <label className="text-xs">Từ ngày<input aria-label="Hoạt động từ ngày" type="date" value={draft.from} onChange={e => setDraft({...draft,from:e.target.value})} className="mt-1 block rounded border p-2" required /></label>
      <label className="text-xs">Đến ngày<input aria-label="Hoạt động đến ngày" type="date" value={draft.to} onChange={e => setDraft({...draft,to:e.target.value})} className="mt-1 block rounded border p-2" required /></label>
      <label className="text-xs">Dịch vụ<select aria-label="Nhóm dịch vụ hoạt động" value={draft.category} onChange={e => setDraft({...draft,category:e.target.value as ActivityFilters['category']})} className="mt-1 block rounded border p-2"><option value="all">Tất cả</option><option value="clinic">Khám</option><option value="spa">Spa</option></select></label>
      <label className="text-xs">Nhóm theo<select aria-label="Nhóm thời gian hoạt động" value={draft.groupBy} onChange={e => setDraft({...draft,groupBy:e.target.value as ActivityFilters['groupBy']})} className="mt-1 block rounded border p-2"><option value="day">Ngày</option><option value="month">Tháng</option></select></label>
      <button className="rounded bg-primary px-4 py-2 text-sm font-semibold text-white">Xem thống kê</button>
    </form>
    {error && <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p>}
    <QueryStatus label="hoạt động khám và Spa" query={query} />
    {!data && !query.loading && <p className="mt-3 text-sm text-slate-500">Chưa có số liệu hoạt động.</p>}
    {data && current && <>
      <p className="my-3 text-xs text-slate-500">Kỳ {data.period.from} → {data.period.to}. So sánh {data.previousPeriod.from} → {data.previousPeriod.to}.</p>
      {(query.error || data.meta.degraded || data.meta.freshness.state !== 'current') && <p className="mb-3 text-xs text-amber-800">Số liệu tổng hợp đang cập nhật.</p>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[['Tổng lịch',number(current.total)],['Hoàn tất',number(current.byStatus.completed)],['Tỷ lệ hủy',rate(current.cancellationRate)],['Tỷ lệ vắng mặt',rate(current.noShowRate)]].map(([label,value]) => <div key={label} className="rounded bg-slate-50 p-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-xl font-semibold">{value}</p></div>)}
      </div>
      <p className="my-3 text-sm">So với kỳ trước: {data.comparison.totalDelta > 0 ? '+' : ''}{number(data.comparison.totalDelta)} lịch ({data.comparison.totalDeltaPercent === null ? '—' : `${data.comparison.totalDeltaPercent.toLocaleString('vi-VN',{maximumFractionDigits:1})}%`}).</p>
      <div className="flex flex-wrap gap-2 text-xs">{Object.entries(current.byStatus).map(([s,n]) => <span key={s} className="rounded border px-2 py-1">{appointmentStatusLabels[s as keyof typeof appointmentStatusLabels]}: {number(n)}</span>)}</div>
      <div className="my-3 grid gap-1 text-xs sm:grid-cols-2 lg:grid-cols-5">{current.byType.map(t => <p key={t.type}>{typeLabels[t.type] ?? t.type}: <strong>{number(t.total)}</strong></p>)}</div>
      <div className="mt-4 max-h-80 overflow-auto">
        <table className="w-full text-left text-sm"><caption className="pb-2 text-left text-xs text-slate-500">{data.period.groupBy === 'day' ? 'Bấm số lịch của một ngày để xem danh sách mới nhất.' : 'Các tháng đầu/cuối được tính trong phạm vi kỳ đã chọn.'}</caption><thead><tr><th className="p-2">{data.period.groupBy === 'day' ? 'Ngày' : 'Khoảng tháng'}</th><th className="p-2">Tổng</th><th className="p-2">Hoàn tất</th><th className="p-2">Hủy</th><th className="p-2">Vắng</th></tr></thead>
          <tbody>{current.buckets.map(bucket => <tr key={bucket.from} className="border-t"><td className="p-2 whitespace-nowrap">{bucket.from === bucket.to ? bucket.from : `${bucket.from} → ${bucket.to}`}<div aria-hidden="true" className="mt-1 h-1 rounded bg-slate-100"><div className="h-1 rounded bg-primary" style={{width:`${bucket.total / max * 100}%`}} /></div></td>{([undefined,'completed','cancelled','no_show'] as const).map(s => <td key={s ?? 'total'} className="p-2">{data.period.groupBy === 'day' ? <button className="text-primary underline" aria-label={`Xem ${s ?? 'tổng'} ngày ${bucket.from}`} onClick={() => navigate(activityDrilldown(bucket.from,data.period.category,s))}>{number(s ? bucket.byStatus[s] : bucket.total)}</button> : number(s ? bucket.byStatus[s] : bucket.total)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {data.period.groupBy === 'month' && <div className="mt-3 flex flex-wrap items-center gap-2 text-xs"><label>Chọn ngày xem lịch<input aria-label="Ngày xem lịch từ hoạt động" type="date" min={filters.from} max={filters.to} value={detailDate} onChange={e => setDetailDate(e.target.value)} className="ml-2 rounded border p-2" /></label><button className="rounded border px-3 py-2" disabled={!detailDate || detailDate < filters.from || detailDate > filters.to} onClick={() => navigate(activityDrilldown(detailDate,filters.category))}>Xem lịch ngày đã chọn</button></div>}
    </>}
  </section>;
}
