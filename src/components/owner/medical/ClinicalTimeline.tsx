import { History } from "lucide-react";
import type { MedicalRecord } from "../../../types/medicalRecord";

interface ClinicalTimelineProps {
  records: MedicalRecord[];
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${value}T00:00:00`));
}

export function ClinicalTimeline({ records }: ClinicalTimelineProps) {

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2 mb-8">
        <History className="text-primary" size={24} />
        Lịch sử khám lâm sàng
      </h3>

      {records.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-5 py-10 text-center">
          <p className="font-bold text-slate-700">Chưa có hồ sơ y tế cho thú cưng này.</p>
          <p className="mt-1 text-sm text-slate-500">Khi admin tạo medical record sau lịch khám, dữ liệu sẽ xuất hiện tại đây.</p>
        </div>
      ) : (
      <div className="relative border-l-2 border-slate-200 ml-3 space-y-10 pb-4">
        {records.map((record, idx) => (
          <div key={record.id} className="relative pl-6">
            <div className={`absolute -left-[9px] top-1 h-4 w-4 rounded-full border-4 border-white ${idx < 2 ? 'bg-primary' : 'bg-slate-300'}`}></div>
            
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between mb-2 gap-2">
              <div>
                <h4 className={`text-lg font-bold ${idx < 2 ? 'text-slate-900' : 'text-slate-500'}`}>{record.title}</h4>
                <p className="text-sm text-slate-500 mt-0.5">
                  {record.doctorName} &bull; {record.diagnosis}
                </p>
              </div>
              <span className="text-sm font-semibold text-slate-500 whitespace-nowrap">{formatDate(record.visitDate)}</span>
            </div>
            
            {(record.symptoms || record.treatment) && (
              <div className="mt-3 rounded-xl bg-slate-50 p-4 border border-slate-100 text-slate-700 text-sm leading-relaxed">
                {record.symptoms && <p><span className="font-bold">Triệu chứng:</span> {record.symptoms}</p>}
                {record.treatment && <p className="mt-1"><span className="font-bold">Điều trị:</span> {record.treatment}</p>}
                {record.medications && <p className="mt-1"><span className="font-bold">Thuốc:</span> {record.medications}</p>}
              </div>
            )}
            
            {(record.vaccineName || record.followUpDate) && (
              <div className="mt-3 flex gap-2">
                {record.vaccineName && <span className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-600"><span className="text-slate-400">💉</span> {record.vaccineName}</span>}
                {record.followUpDate && <span className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700">Tái khám: {formatDate(record.followUpDate)}</span>}
              </div>
            )}
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
