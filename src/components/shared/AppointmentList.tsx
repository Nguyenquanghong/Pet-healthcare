import { appointments } from "../../data/mockData";
import { StatusBadge } from "../ui/StatusBadge";

export function AppointmentList() {
  return (
    <div className="space-y-3">
      {appointments.map((appointment) => (
        <div key={`${appointment.time}-${appointment.pet}`} className="flex items-center justify-between rounded-xl bg-slate-50 p-3">
          <div>
            <p className="font-bold">{appointment.time} · {appointment.pet}</p>
            <p className="text-sm text-slate-500">{appointment.service} · {appointment.doctor}</p>
          </div>
          <StatusBadge>{appointment.status}</StatusBadge>
        </div>
      ))}
    </div>
  );
}