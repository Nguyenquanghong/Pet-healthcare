import { PetLookup } from "../../ui/PagedSelect";
import { CheckCircle2, Clock3, Sparkles } from "lucide-react";
import { spaServiceOptions } from "../../../data/services";
import type { SpaAppointmentType } from "../../../types/appointment";
import type { Pet } from "../../../types/pet";
import { todayIso } from "../../../utils/date";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { Textarea } from "../../ui/Textarea";

const SPA_TIME_SLOTS = ["09:00", "10:30", "13:30", "15:00", "16:30"];
const formatPrice = (value: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(value);

type SpaBookingFormProps = {
  ownerPets: Pet[];
  petId: string;
  serviceType: SpaAppointmentType;
  date: string;
  time: string;
  ownerNote: string;
  success: boolean;
  error: string;
  isSubmitting: boolean;
  onPetChange: (value: string) => void;
  onServiceTypeChange: (value: SpaAppointmentType) => void;
  onDateChange: (value: string) => void;
  onTimeChange: (value: string) => void;
  onOwnerNoteChange: (value: string) => void;
  onSubmit: () => void;
};

export function SpaBookingForm({
  petId,
  serviceType,
  date,
  time,
  ownerNote,
  success,
  error,
  isSubmitting,
  onPetChange,
  onServiceTypeChange,
  onDateChange,
  onTimeChange,
  onOwnerNoteChange,
  onSubmit,
}: SpaBookingFormProps) {
  const today = todayIso();

  return (
    <section className="h-fit rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
      <div className="mb-5 flex items-start gap-3 border-b border-slate-100 pb-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-cyan-50 text-cyan-700">
          <Sparkles size={20} />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-slate-950">Đặt lịch Spa</h2>
          <p className="mt-1 text-sm leading-5 text-slate-500">Chọn gói chăm sóc và khung giờ phù hợp cho thú cưng.</p>
        </div>
      </div>

      {success && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
          <CheckCircle2 size={17} /> Yêu cầu Spa đã được gửi và đang chờ xác nhận.
        </div>
      )}
      {error && <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">{error}</div>}

      <div className="space-y-5">
        <PetLookup label="Thú cưng *" value={petId} onChange={onPetChange} />

        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-slate-800">Gói dịch vụ *</legend>
          <div className="space-y-2">
            {spaServiceOptions.map((service) => {
              const selected = service.type === serviceType;
              return (
                <label key={service.type} className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${selected ? "border-primary bg-primary/5" : "border-slate-200 hover:bg-slate-50"}`}>
                  <input
                    type="radio"
                    name="spa-service"
                    value={service.type}
                    checked={selected}
                    onChange={() => onServiceTypeChange(service.type)}
                    className="mt-1 h-4 w-4 border-slate-300 text-primary focus:ring-primary"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-900">{service.label}</span>
                      <span className="text-sm font-semibold text-primary">{formatPrice(service.estimatedPrice)}</span>
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-slate-500">{service.description}</span>
                    <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-slate-600"><Clock3 size={13} /> Khoảng {service.durationMinutes} phút</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Input type="date" min={today} label="Ngày Spa *" value={date} onChange={(event) => onDateChange(event.target.value)} />
          <Select
            label="Khung giờ *"
            value={time}
            options={[{ value: "", label: "Chọn giờ" }, ...SPA_TIME_SLOTS.map((slot) => ({ value: slot, label: slot }))]}
            onChange={(event) => onTimeChange(event.target.value)}
          />
        </div>

        <Textarea
          label="Lưu ý chăm sóc"
          value={ownerNote}
          onChange={(event) => onOwnerNoteChange(event.target.value)}
          placeholder="Kiểu cắt mong muốn, da nhạy cảm, tính cách hoặc lưu ý khi chăm sóc..."
        />

        <Button className="w-full" icon={<Sparkles size={16} />} onClick={onSubmit} disabled={!petId || !date || !time || isSubmitting}>
          {isSubmitting ? "Đang gửi yêu cầu..." : "Gửi yêu cầu đặt Spa"}
        </Button>
      </div>
    </section>
  );
}
