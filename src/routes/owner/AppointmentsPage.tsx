import { useMemo, useState } from "react";
import { AppLayout } from "../../components/layout/AppLayout";
import { Card } from "../../components/ui/Card";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { useAppStore } from "../../store/AppStoreProvider";
import type { AppointmentType } from "../../types/appointment";
import { appointmentStatusLabels } from "../../utils/statusLabels";

const services: { type: AppointmentType; label: string }[] = [
  { type: "general_checkup", label: "Khám tổng quát" },
  { type: "vaccination", label: "Tiêm phòng" },
  { type: "dental", label: "Vệ sinh răng miệng" },
  { type: "dermatology", label: "Khám da liễu" },
  { type: "hotel_consultation", label: "Tư vấn lưu trú" },
];

export function AppointmentsPage() {
  const { appointments, createAppointment, currentOwnerId, ownerPets, pets } = useAppStore();
  const [petId, setPetId] = useState(ownerPets[0]?.id ?? "");
  const [serviceType, setServiceType] = useState<AppointmentType>("general_checkup");
  const [date, setDate] = useState("2026-11-05");
  const [time, setTime] = useState("09:00");
  const [ownerNote, setOwnerNote] = useState("");

  const ownerAppointments = useMemo(
    () => appointments.filter((appointment) => appointment.ownerId === currentOwnerId),
    [appointments, currentOwnerId],
  );
  const selectedService = services.find((service) => service.type === serviceType) ?? services[0];

  const submitAppointment = () => {
    if (!petId) return;
    createAppointment({ petId, type: serviceType, serviceName: selectedService.label, date, time, doctorId: "doctor_mai", ownerNote });
  };

  return (
    <AppLayout type="owner" title="Quản lý lịch khám">
      <div className="grid gap-6 xl:grid-cols-[1fr_1.1fr]">
        <Card title="Đặt lịch khám mới">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="text-sm font-bold text-slate-600">Pet</span>
              <select className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" value={petId} onChange={(event) => setPetId(event.target.value)}>
                {ownerPets.map((pet) => <option key={pet.id} value={pet.id}>{pet.name} - {pet.breed}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-bold text-slate-600">Dịch vụ</span>
              <select className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" value={serviceType} onChange={(event) => setServiceType(event.target.value as AppointmentType)}>
                {services.map((service) => <option key={service.type} value={service.type}>{service.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-bold text-slate-600">Ngày khám</span>
              <input type="date" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" value={date} onChange={(event) => setDate(event.target.value)} />
            </label>
            <label className="block">
              <span className="text-sm font-bold text-slate-600">Giờ khám</span>
              <input type="time" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" value={time} onChange={(event) => setTime(event.target.value)} />
            </label>
          </div>
          <label className="mt-4 block">
            <span className="text-sm font-bold text-slate-600">Ghi chú</span>
            <textarea className="mt-2 min-h-24 w-full rounded-xl border border-slate-200 px-4 py-3" value={ownerNote} onChange={(event) => setOwnerNote(event.target.value)} placeholder="Triệu chứng, yêu cầu bác sĩ, thời gian ưu tiên..." />
          </label>
          <button onClick={submitAppointment} className="mt-5 w-full rounded-xl bg-primary px-4 py-3 font-bold text-white">Create Appointment</button>
        </Card>

        <Card title="Lịch khám của bạn">
          <div className="space-y-3">
            {ownerAppointments.map((appointment) => {
              const pet = pets.find((item) => item.id === appointment.petId);
              return (
                <div key={appointment.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-bold">{appointment.time} · {pet?.name ?? appointment.petId}</p>
                      <p className="text-sm text-slate-500">{appointment.date} · {appointment.serviceName}</p>
                      {appointment.ownerNote && <p className="mt-2 text-xs text-slate-500">Note: {appointment.ownerNote}</p>}
                    </div>
                    <StatusBadge status={appointment.status}>{appointmentStatusLabels[appointment.status]}</StatusBadge>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </AppLayout>
  );
}
