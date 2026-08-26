import { useAppStore } from "../../store/AppStoreProvider";
import { appointmentStatusLabels } from "../../utils/statusLabels";
import { StatusBadge } from "../ui/StatusBadge";

export function AppointmentList() {
  const { appointments, currentOwnerId, pets } = useAppStore();
  const ownerAppointments = appointments.filter((appointment) => appointment.ownerId === currentOwnerId).slice(0, 5);

  return (
    <div className="space-y-3">
      {ownerAppointments.map((appointment) => {
        const pet = pets.find((item) => item.id === appointment.petId);
        return (
        <div key={appointment.id} className="flex items-center justify-between rounded-xl bg-slate-50 p-3">
          <div>
            <p className="font-bold">{appointment.time} · {pet?.name ?? appointment.petId}</p>
            <p className="text-sm text-slate-500">{appointment.serviceName} · {appointment.date}</p>
          </div>
          <StatusBadge status={appointment.status}>{appointmentStatusLabels[appointment.status]}</StatusBadge>
        </div>
      );})}
    </div>
  );
}