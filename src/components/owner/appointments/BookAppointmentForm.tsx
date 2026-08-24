import { CalendarPlus, CheckCircle2 } from "lucide-react";
import type { AppointmentType } from "../../../types/appointment";
import type { Pet } from "../../../types/pet";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Select";
import { Input } from "../../ui/Input";
import { Textarea } from "../../ui/Textarea";

export const OWNER_APPOINTMENT_SERVICES: { type: AppointmentType; label: string }[] = [
  { type: "general_checkup", label: "Khám tổng quát" },
  { type: "vaccination", label: "Tiêm phòng" },
  { type: "dental", label: "Vệ sinh răng miệng" },
  { type: "dermatology", label: "Khám da liễu" },
  { type: "hotel_consultation", label: "Tư vấn lưu trú" },
];

interface BookAppointmentFormProps {
  ownerPets: Pet[];
  petId: string;
  serviceType: AppointmentType;
  date: string;
  time: string;
  ownerNote: string;
  success: boolean;
  onPetChange: (value: string) => void;
  onServiceTypeChange: (value: AppointmentType) => void;
  onDateChange: (value: string) => void;
  onTimeChange: (value: string) => void;
  onOwnerNoteChange: (value: string) => void;
  onSubmit: () => void;
}

export function BookAppointmentForm({
  ownerPets,
  petId,
  serviceType,
  date,
  time,
  ownerNote,
  success,
  onPetChange,
  onServiceTypeChange,
  onDateChange,
  onTimeChange,
  onOwnerNoteChange,
  onSubmit,
}: BookAppointmentFormProps) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm h-fit">
      <h2 className="mb-5 text-xl font-bold text-slate-900 flex items-center gap-2">
        <CalendarPlus size={20} className="text-primary" />
        Đặt lịch khám mới
      </h2>

      {success && (
        <div className="mb-5 flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm font-semibold text-emerald-800">
          <CheckCircle2 size={16} /> Đã gửi yêu cầu đặt lịch! Admin sẽ xác nhận sớm.
        </div>
      )}

      <div className="space-y-4">
        <Select
          label="Thú cưng"
          value={petId}
          options={[
            { value: "", label: "Chọn thú cưng" },
            ...ownerPets.map((pet) => ({ value: pet.id, label: `${pet.name} — ${pet.breed}` })),
          ]}
          onChange={(event) => onPetChange(event.target.value)}
        />
        <Select
          label="Dịch vụ"
          value={serviceType}
          options={OWNER_APPOINTMENT_SERVICES.map((service) => ({ value: service.type, label: service.label }))}
          onChange={(event) => onServiceTypeChange(event.target.value as AppointmentType)}
        />
        <div className="grid grid-cols-2 gap-4">
          <Input type="date" label="Ngày khám" value={date} onChange={(event) => onDateChange(event.target.value)} />
          <Input type="time" label="Giờ khám" value={time} onChange={(event) => onTimeChange(event.target.value)} />
        </div>
        <Textarea
          label="Ghi chú cho bác sĩ"
          value={ownerNote}
          onChange={(event) => onOwnerNoteChange(event.target.value)}
          placeholder="Triệu chứng, yêu cầu bác sĩ, thời gian ưu tiên..."
        />
        <Button onClick={onSubmit} disabled={!petId} className="w-full">
          Gửi yêu cầu đặt lịch
        </Button>
      </div>
    </div>
  );
}