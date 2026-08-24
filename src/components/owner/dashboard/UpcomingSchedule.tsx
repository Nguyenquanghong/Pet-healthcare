import { Link } from "react-router-dom";
import { MapPin, Calendar, ArrowRight } from "lucide-react";
import type { Appointment } from "../../../types/appointment";
import { useAppStore } from "../../../store/AppStoreProvider";
import { appointmentStatusLabels } from "../../../utils/statusLabels";

export function UpcomingSchedule({ appointments }: { appointments: Appointment[] }) {
  const { pets } = useAppStore();

  if (appointments.length === 0) {
    return (
      <div className="py-6 text-center">
        <Calendar className="mx-auto text-slate-300 mb-2" size={32} />
        <p className="text-sm font-medium text-slate-500">Không có lịch hẹn sắp tới.</p>
        <Link
          to="/owner/appointments"
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-primary hover:underline"
        >
          Đặt lịch khám mới <ArrowRight size={12} />
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3.5">
      {appointments.slice(0, 3).map((appointment, index) => {
        const pet = pets.find((p) => p.id === appointment.petId);

        let day = "01";
        let monthShort = "Th 1";
        try {
          const parts = appointment.date.split("-");
          if (parts.length === 3) {
            day = parts[2];
            monthShort = `Th ${parseInt(parts[1], 10)}`;
          }
        } catch {
          // fallback
        }

        const isPending = appointment.status === "pending";

        return (
          <div
            key={appointment.id}
            className="flex items-center gap-4 rounded-2xl border border-slate-100 bg-slate-50/50 p-3.5 hover:bg-slate-50 transition-colors"
          >
            <div
              className={`flex flex-col items-center justify-center rounded-xl px-3 py-2 text-center h-14 w-14 flex-shrink-0 ${
                isPending
                  ? "bg-amber-100 text-amber-800"
                  : index === 0
                  ? "bg-primary/10 text-primary"
                  : "bg-blue-100 text-blue-800"
              }`}
            >
              <span className="text-lg font-black leading-tight">{day}</span>
              <span className="text-[10px] font-bold uppercase">{monthShort}</span>
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-1">
                <h4 className="font-bold text-slate-900 text-sm truncate">{appointment.serviceName}</h4>
                <span
                  className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${
                    isPending ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"
                  }`}
                >
                  {appointmentStatusLabels[appointment.status]}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5 truncate">
                Cho <strong>{pet?.name ?? "Thú cưng"}</strong> &bull; Lúc {appointment.time}
              </p>
              <div className="mt-1 flex items-center gap-1 text-[11px] text-slate-400">
                <MapPin size={11} />
                <span className="truncate">{appointment.clinicName}</span>
              </div>
            </div>
          </div>
        );
      })}

      <div className="pt-2 border-t border-slate-100 text-right">
        <Link
          to="/owner/appointments"
          className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
        >
          Xem tất cả lịch khám ({appointments.length}) <ArrowRight size={12} />
        </Link>
      </div>
    </div>
  );
}
