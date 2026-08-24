import { History, Calendar, Stethoscope, HeartPulse } from "lucide-react";
import type { MedicalRecord } from "../../../types/medicalRecord";
import { useAppStore } from "../../../store/AppStoreProvider";
import { appointmentStatusLabels } from "../../../utils/statusLabels";

interface ClinicalTimelineProps {
  records: MedicalRecord[];
}

function formatDate(value: string) {
  try {
    return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }).format(
      new Date(`${value}T00:00:00`)
    );
  } catch {
    return value;
  }
}

export function ClinicalTimeline({ records }: ClinicalTimelineProps) {
  const { appointments } = useAppStore();

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2 mb-8">
        <History className="text-primary" size={24} />
        Lịch sử khám lâm sàng
      </h3>

      {records.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-5 py-10 text-center">
          <p className="font-bold text-slate-700">Chưa có hồ sơ y tế cho thú cưng này.</p>
          <p className="mt-1 text-sm text-slate-500">
            Khi bác sĩ tạo medical record sau buổi khám, dữ liệu chi tiết sẽ xuất hiện tại đây.
          </p>
        </div>
      ) : (
        <div className="relative border-l-2 border-slate-200 ml-3 space-y-10 pb-4">
          {records.map((record, idx) => {
            const linkedAppointment = record.appointmentId
              ? appointments.find((a) => a.id === record.appointmentId)
              : undefined;

            return (
              <div key={record.id} className="relative pl-6">
                <div
                  className={`absolute -left-[9px] top-1 h-4 w-4 rounded-full border-4 border-white ${
                    idx < 2 ? "bg-primary" : "bg-slate-300"
                  }`}
                />

                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between mb-2 gap-2">
                  <div>
                    <h4 className={`text-lg font-bold ${idx < 2 ? "text-slate-900" : "text-slate-700"}`}>
                      {record.title}
                    </h4>
                    <p className="text-sm text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-slate-700 flex items-center gap-1">
                        <Stethoscope size={14} className="text-primary" /> {record.doctorName}
                      </span>
                      <span>&bull;</span>
                      <span className="text-slate-600">{record.diagnosis}</span>
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-slate-500 whitespace-nowrap">
                    {formatDate(record.visitDate)}
                  </span>
                </div>

                {/* Linked Appointment Badge */}
                {linkedAppointment && (
                  <div className="my-2.5 inline-flex items-center gap-2 rounded-xl bg-blue-50/80 border border-blue-200/80 px-3 py-1.5 text-xs text-blue-900 font-medium">
                    <Calendar size={13} className="text-blue-600" />
                    <span>
                      Lịch khám: <strong>{linkedAppointment.serviceName}</strong> lúc {linkedAppointment.time} (
                      {linkedAppointment.clinicName})
                    </span>
                    <span className="rounded-md bg-blue-200/60 px-1.5 py-0.5 text-[11px] font-bold text-blue-800">
                      {appointmentStatusLabels[linkedAppointment.status] ?? linkedAppointment.status}
                    </span>
                  </div>
                )}

                {/* Vitals in record */}
                {(record.weightKg || record.temperatureC || record.heartRateBpm) && (
                  <div className="my-2 flex flex-wrap gap-2 text-xs">
                    {record.weightKg && (
                      <span className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 font-semibold text-slate-700">
                        <HeartPulse size={12} className="text-rose-500" /> Cân nặng: {record.weightKg} kg
                      </span>
                    )}
                    {record.temperatureC && (
                      <span className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 font-semibold text-slate-700">
                        Nhiệt độ: {record.temperatureC}°C
                      </span>
                    )}
                    {record.heartRateBpm && (
                      <span className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 font-semibold text-slate-700">
                        Nhịp tim: {record.heartRateBpm} bpm
                      </span>
                    )}
                  </div>
                )}

                {(record.symptoms || record.treatment) && (
                  <div className="mt-3 rounded-xl bg-slate-50 p-4 border border-slate-100 text-slate-700 text-sm leading-relaxed space-y-1.5">
                    {record.symptoms && (
                      <p>
                        <span className="font-bold text-slate-900">Triệu chứng:</span> {record.symptoms}
                      </p>
                    )}
                    {record.treatment && (
                      <p>
                        <span className="font-bold text-slate-900">Điều trị:</span> {record.treatment}
                      </p>
                    )}
                    {record.medications && (
                      <p>
                        <span className="font-bold text-slate-900">Thuốc kê đơn:</span> {record.medications}
                      </p>
                    )}
                  </div>
                )}

                {(record.vaccineName || record.followUpDate) && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {record.vaccineName && (
                      <span className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-600">
                        <span className="text-slate-400">💉</span> {record.vaccineName}
                      </span>
                    )}
                    {record.followUpDate && (
                      <span className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700">
                        Tái khám: {formatDate(record.followUpDate)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
