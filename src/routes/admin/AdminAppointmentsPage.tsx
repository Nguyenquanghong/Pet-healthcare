import { AppLayout } from "../../components/layout/AppLayout";
import { Card } from "../../components/ui/Card";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { useAppStore } from "../../store/AppStoreProvider";
import { appointmentStatusLabels } from "../../utils/statusLabels";

export function AdminAppointmentsPage() {
  const { appointments, owners, pets, updateAppointmentStatus } = useAppStore();

  return (
    <AppLayout type="admin" title="Quản lý lịch khám">
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="p-3">Time</th>
                <th>Pet</th>
                <th>Owner</th>
                <th>Service</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {appointments.map((appointment) => {
                const pet = pets.find((item) => item.id === appointment.petId);
                const owner = owners.find((item) => item.id === appointment.ownerId);
                return (
                  <tr key={appointment.id} className="border-b align-top">
                    <td className="p-3 font-bold">{appointment.date}<br /><span className="text-slate-500">{appointment.time}</span></td>
                    <td>{pet?.name ?? appointment.petId}</td>
                    <td>{owner?.fullName ?? appointment.ownerId}</td>
                    <td>{appointment.serviceName}</td>
                    <td><StatusBadge status={appointment.status}>{appointmentStatusLabels[appointment.status]}</StatusBadge></td>
                    <td>
                      <div className="flex flex-wrap gap-2">
                        <button disabled={appointment.status !== "pending"} onClick={() => updateAppointmentStatus(appointment.id, "confirmed")} className="rounded-lg bg-primary px-3 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300">Confirm</button>
                        <button disabled={appointment.status !== "confirmed"} onClick={() => updateAppointmentStatus(appointment.id, "checked_in")} className="rounded-lg bg-amber-500 px-3 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300">Check-in</button>
                        <button disabled={! ["checked_in", "in_progress"].includes(appointment.status)} onClick={() => updateAppointmentStatus(appointment.id, "completed")} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300">Complete</button>
                        <button disabled={["completed", "cancelled"].includes(appointment.status)} onClick={() => updateAppointmentStatus(appointment.id, "cancelled")} className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300">Cancel</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </AppLayout>
  );
}
