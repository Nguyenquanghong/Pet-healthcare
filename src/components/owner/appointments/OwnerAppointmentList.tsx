import type { Appointment } from "../../../types/appointment";
import type { Pet } from "../../../types/pet";
import { appointmentStatusLabels } from "../../../utils/statusLabels";
import { Badge } from "../../ui/Badge";

const STATUS_VARIANTS: Record<string, "default" | "success" | "warning" | "danger" | "info"> = {
  pending: "warning",
  confirmed: "success",
  checked_in: "info",
  in_progress: "info",
  completed: "default",
  cancelled: "danger",
  no_show: "danger",
};

interface OwnerAppointmentListProps {
  appointments: Appointment[];
  pets: Pet[];
}

export function OwnerAppointmentList({ appointments, pets }: OwnerAppointmentListProps) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-slate-100 px-6 py-5">
        <h2 className="text-xl font-bold text-slate-900">Lịch khám của bạn</h2>
        <p className="text-sm text-slate-500 mt-0.5">{appointments.length} lịch hẹn</p>
      </div>
      <div className="divide-y divide-slate-100">
        {appointments.map((appointment) => {
          const pet = pets.find((item) => item.id === appointment.petId);
          return (
            <div key={appointment.id} className="flex flex-col gap-4 px-6 py-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 rounded-xl bg-primary/10 px-3 py-2 text-center">
                  <p className="text-xs font-bold text-primary">{appointment.date.slice(5).replace("-", "/")}</p>
                  <p className="text-sm font-black text-primary">{appointment.time}</p>
                </div>
                <div>
                  <p className="font-bold text-slate-900">{appointment.serviceName}</p>
                  <p className="text-sm text-slate-500 mt-0.5">Cho {pet?.name ?? appointment.petId}</p>
                  {appointment.ownerNote && <p className="mt-1.5 text-xs text-slate-400">📝 {appointment.ownerNote}</p>}
                </div>
              </div>
              <Badge variant={STATUS_VARIANTS[appointment.status] ?? "default"}>{appointmentStatusLabels[appointment.status]}</Badge>
            </div>
          );
        })}
        {appointments.length === 0 && <p className="px-6 py-12 text-center text-slate-400">Bạn chưa có lịch khám nào.</p>}
      </div>
    </div>
  );
}