import {useSyncExternalStore} from 'react';
import {clinicReadState} from '../../services/clinicReadState';
import {appointmentStatusLabels} from '../../utils/statusLabels';
export function ClinicSavedChanges(){
  const saved=useSyncExternalStore(clinicReadState.subscribe,clinicReadState.saved);
  if(!saved.length)return null;
  return <aside role="status" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
    <p className="font-semibold">Đã lưu thay đổi lịch hẹn</p>
    <p>Danh sách đang được cập nhật. Kết quả đã lưu của bạn:</p>
    <ul>{saved.map(item=><li key={item.id}>{item.serviceName} — {appointmentStatusLabels[item.status as keyof typeof appointmentStatusLabels]??item.status}{item.date?' · '+item.date:''}{item.time?' '+item.time:''}</li>)}</ul>
  </aside>;
}
