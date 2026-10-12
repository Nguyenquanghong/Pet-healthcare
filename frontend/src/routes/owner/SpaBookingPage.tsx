import { useEffect, useMemo, useState, useRef } from "react";
import { useRequestIntent } from '../../services/useRequestIntent';
import { Link } from "react-router-dom";
import { PawPrint, Plus } from "lucide-react";
import { OwnerLayout } from "../../components/layout/owner/OwnerLayout";
import { OwnerAppointmentCalendar } from "../../components/owner/appointments/OwnerAppointmentCalendar";
import { OwnerAppointmentList } from "../../components/owner/appointments/OwnerAppointmentList";
import { SpaBookingForm } from "../../components/owner/spa/SpaBookingForm";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { spaServiceOptions } from "../../data/services";
import { useAppStore } from "../../store/AppStoreProvider";
import { isSpaAppointmentType, type SpaAppointmentType } from "../../types/appointment";
import { addDaysIso, todayIso } from "../../utils/date";

import { useApiQuery } from '../../services/useApiQuery';
import type { ListPage } from '../../types/list';
import type { Pet } from '../../types/pet';
import { QueryStatus } from '../../components/ui/QueryStatus';

export function SpaBookingPage() {
  const intent=useRequestIntent(),sending=useRef(false);
  const { createAppointment, error, isLoading } = useAppStore();
  const petQuery = useApiQuery<ListPage<Pet>>('/pets?pageSize=1', { refreshOnTick: true });
  const ownerPets = petQuery.data?.items ?? [];
  const [petId, setPetId] = useState(ownerPets[0]?.id ?? "");
  const [serviceType, setServiceType] = useState<SpaAppointmentType>("spa_bath");
  const [date, setDate] = useState(() => addDaysIso(1));
  const [time, setTime] = useState("09:00");
  const [ownerNote, setOwnerNote] = useState("");
  const [selectedCalendarDate, setSelectedCalendarDate] = useState("");
  const [success, setSuccess] = useState(false);
  const [formError, setFormError] = useState("");

  const selectedService = spaServiceOptions.find((service) => service.type === serviceType) ?? spaServiceOptions[0];

  const handleSubmit = async () => {
    if(sending.current)return;
    setFormError("");
    if (!petId) return setFormError("Vui lòng chọn thú cưng.");
    if (!date || !time) return setFormError("Vui lòng chọn ngày và khung giờ Spa.");
    if (date < todayIso()) return setFormError("Ngày Spa không thể nằm trong quá khứ.");

    sending.current=true;
    try {
      const input={ petId, type: serviceType, serviceName: selectedService.label, date, time, ownerNote: ownerNote.trim() || undefined };
      await createAppointment(input,intent.key(input));intent.complete();
      setOwnerNote("");
      setSuccess(true);
      window.setTimeout(() => setSuccess(false), 3500);
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "Không thể gửi yêu cầu Spa. Vui lòng thử lại.");
    }finally{sending.current=false;}
  };

  return (
    <OwnerLayout title="Spa cho thú cưng">
      {!petQuery.data ? <QueryStatus label="thú cưng" query={petQuery} /> : ownerPets.length === 0 ? (
        <EmptyState
          icon={<PawPrint size={42} />}
          title="Cần thêm thú cưng trước khi đặt Spa"
          description="Mỗi lịch Spa cần được gắn với một hồ sơ thú cưng cụ thể."
          action={<Link to="/owner/pets"><Button icon={<Plus size={16} />}>Thêm thú cưng</Button></Link>}
        />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1fr_1.2fr]">
          <SpaBookingForm
            ownerPets={ownerPets}
            petId={petId}
            serviceType={serviceType}
            date={date}
            time={time}
            ownerNote={ownerNote}
            success={success}
            error={formError || error}
            isSubmitting={isLoading}
            onPetChange={setPetId}
            onServiceTypeChange={setServiceType}
            onDateChange={setDate}
            onTimeChange={setTime}
            onOwnerNoteChange={setOwnerNote}
            onSubmit={handleSubmit}
          />
          <div className="space-y-6">
            <OwnerAppointmentCalendar category="spa" selectedDate={selectedCalendarDate} onSelectDate={setSelectedCalendarDate} onClearDate={() => setSelectedCalendarDate("")} />
            <OwnerAppointmentList mode="spa" selectedDate={selectedCalendarDate || undefined} onClearDate={() => setSelectedCalendarDate("")} />
          </div>
        </div>
      )}
    </OwnerLayout>
  );
}
