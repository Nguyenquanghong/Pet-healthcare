import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, PawPrint } from "lucide-react";
import { OwnerLayout } from "../../components/layout/owner/OwnerLayout";
import { BookAppointmentForm, OWNER_APPOINTMENT_SERVICES } from "../../components/owner/appointments/BookAppointmentForm";
import { OwnerAppointmentCalendar } from "../../components/owner/appointments/OwnerAppointmentCalendar";
import { OwnerAppointmentList } from "../../components/owner/appointments/OwnerAppointmentList";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { useAppStore } from "../../store/AppStoreProvider";
import type { AppointmentType } from "../../types/appointment";

export function AppointmentsPage() {
  const { appointments, createAppointment, currentOwnerId, ownerPets, pets } = useAppStore();
  const [petId, setPetId] = useState(ownerPets[0]?.id ?? "");
  const [serviceType, setServiceType] = useState<AppointmentType>("general_checkup");
  const [date, setDate] = useState("2026-11-05");
  const [time, setTime] = useState("09:00");
  const [ownerNote, setOwnerNote] = useState("");
  const [selectedCalendarDate, setSelectedCalendarDate] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!ownerPets.some((pet) => pet.id === petId)) setPetId(ownerPets[0]?.id ?? "");
  }, [ownerPets, petId]);

  const ownerAppointments = useMemo(
    () => appointments.filter(a => a.ownerId === currentOwnerId),
    [appointments, currentOwnerId],
  );
  const visibleAppointments = useMemo(
    () => selectedCalendarDate
      ? ownerAppointments.filter((appointment) => appointment.date === selectedCalendarDate)
      : ownerAppointments,
    [ownerAppointments, selectedCalendarDate],
  );
  const selectedService = OWNER_APPOINTMENT_SERVICES.find(s => s.type === serviceType) ?? OWNER_APPOINTMENT_SERVICES[0];

  const handleSubmit = () => {
    if (!petId) return;
    createAppointment({ petId, type: serviceType, serviceName: selectedService.label, date, time, doctorId: "doctor_mai", ownerNote });
    setOwnerNote("");
    setSuccess(true);
    setTimeout(() => setSuccess(false), 3000);
  };

  return (
    <OwnerLayout title="Quản lý lịch khám">
      {ownerPets.length === 0 ? (
        <EmptyState
          icon={<PawPrint size={42} />}
          title="Cần thêm thú cưng trước khi đặt lịch"
          description="Lịch khám luôn gắn với một hồ sơ thú cưng cụ thể để bác sĩ theo dõi lịch sử sức khỏe chính xác."
          action={<Link to="/owner/pets"><Button icon={<Plus size={16} />}>Thêm thú cưng</Button></Link>}
        />
      ) : (
      <div className="grid gap-6 xl:grid-cols-[1fr_1.2fr]">
        <BookAppointmentForm
          ownerPets={ownerPets}
          petId={petId}
          serviceType={serviceType}
          date={date}
          time={time}
          ownerNote={ownerNote}
          success={success}
          onPetChange={setPetId}
          onServiceTypeChange={setServiceType}
          onDateChange={setDate}
          onTimeChange={setTime}
          onOwnerNoteChange={setOwnerNote}
          onSubmit={handleSubmit}
        />
        <div className="space-y-6">
          <OwnerAppointmentCalendar
            appointments={ownerAppointments}
            selectedDate={selectedCalendarDate}
            onSelectDate={setSelectedCalendarDate}
            onClearDate={() => setSelectedCalendarDate("")}
          />
          <OwnerAppointmentList
            appointments={visibleAppointments}
            pets={pets}
            selectedDate={selectedCalendarDate || undefined}
            onClearDate={() => setSelectedCalendarDate("")}
          />
        </div>
      </div>
      )}
    </OwnerLayout>
  );
}
