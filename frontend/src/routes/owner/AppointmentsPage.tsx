import { useEffect, useMemo, useState, useRef } from "react";
import { useRequestIntent } from '../../services/useRequestIntent';
import { Link } from "react-router-dom";
import { Plus, PawPrint } from "lucide-react";
import { OwnerLayout } from "../../components/layout/owner/OwnerLayout";
import { BookAppointmentForm, OWNER_APPOINTMENT_SERVICES } from "../../components/owner/appointments/BookAppointmentForm";
import { OwnerAppointmentCalendar } from "../../components/owner/appointments/OwnerAppointmentCalendar";
import { OwnerAppointmentList } from "../../components/owner/appointments/OwnerAppointmentList";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { useAppStore } from "../../store/AppStoreProvider";
import { type AppointmentType } from "../../types/appointment";
import { addDaysIso } from "../../utils/date";

import { useApiQuery } from '../../services/useApiQuery';
import type { ListPage } from '../../types/list';
import type { Pet } from '../../types/pet';
import { QueryStatus } from '../../components/ui/QueryStatus';

export function AppointmentsPage() {
  const intent=useRequestIntent(),sending=useRef(false);
  const { createAppointment, error, isLoading } = useAppStore();
  const petQuery = useApiQuery<ListPage<Pet>>('/pets?pageSize=1', { refreshOnTick: true });
  const ownerPets = petQuery.data?.items ?? [];
  const [petId, setPetId] = useState(ownerPets[0]?.id ?? "");
  const [serviceType, setServiceType] = useState<AppointmentType>("general_checkup");
  const [date, setDate] = useState(() => addDaysIso(1));
  const [time, setTime] = useState("09:00");
  const [ownerNote, setOwnerNote] = useState("");
  const [selectedCalendarDate, setSelectedCalendarDate] = useState("");
  const [success, setSuccess] = useState(false);

  const selectedService = OWNER_APPOINTMENT_SERVICES.find(s => s.type === serviceType) ?? OWNER_APPOINTMENT_SERVICES[0];

  const handleSubmit = async () => {
    if (!petId||sending.current) return;
    sending.current=true;
    try {
      const input={ petId, type: serviceType, serviceName: selectedService.label, date, time, ownerNote };
      await createAppointment(input,intent.key(input));intent.complete();
      setOwnerNote("");
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch {
      setSuccess(false);
    }finally{sending.current=false;}
  };

  return (
    <OwnerLayout title="Quản lý lịch khám">
      {!petQuery.data ? <QueryStatus label="thú cưng" query={petQuery} /> : ownerPets.length === 0 ? (
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
          error={error}
          isSubmitting={isLoading}
          onPetChange={setPetId}
          onServiceTypeChange={setServiceType}
          onDateChange={setDate}
          onTimeChange={setTime}
          onOwnerNoteChange={setOwnerNote}
          onSubmit={handleSubmit}
        />
        <div className="space-y-6">
          <OwnerAppointmentCalendar
            selectedDate={selectedCalendarDate}
            onSelectDate={setSelectedCalendarDate}
            onClearDate={() => setSelectedCalendarDate("")}
          />
          <OwnerAppointmentList
            selectedDate={selectedCalendarDate || undefined}
            onClearDate={() => setSelectedCalendarDate("")}
          />
        </div>
      </div>
      )}
    </OwnerLayout>
  );
}
