import { useEffect, useState } from "react";
import { apiClient } from "../../services/apiClient";
import type { ApiSchemas } from "../../types/generated/api";
import { Select } from "./Select";

type Availability = ApiSchemas["AppointmentAvailability"];

// P10: the server owns the scheduling policy, so the times offered come from
// GET /appointments/availability. A full, past or (for staff) doctor-busy slot is
// shown but cannot be chosen. The list is advisory: the booking is checked again.
export function SlotPicker({ id, label, type, date, value, onChange, doctorId, required }: {
  id?: string; label: string; type: string; date: string; value: string; onChange: (time: string) => void; doctorId?: string; required?: boolean;
}) {
  const [loaded, setLoaded] = useState<{ key: string; availability?: Availability; error?: string } | null>(null);
  const key = type && date ? `${type}|${date}|${doctorId ?? ""}` : "";
  useEffect(() => {
    if (!key) return;
    let active = true;
    const query = new URLSearchParams({ type, date, ...(doctorId ? { doctorId } : {}) });
    apiClient.get<Availability>(`/appointments/availability?${query}`).then(
      availability => { if (active) setLoaded({ key, availability }); },
      reason => { if (active) setLoaded({ key, error: reason instanceof Error ? reason.message : "Không tải được giờ trống." }); },
    );
    return () => { active = false; };
  }, [key, type, date, doctorId]);
  const current = loaded?.key === key ? loaded : null;
  const slots = current?.availability?.slots;
  // A time the policy does not offer (for example after switching service) is cleared.
  useEffect(() => { if (slots && value && !slots.some(slot => slot.time === value)) onChange(""); }, [slots, value, onChange]);
  const placeholder = !key ? "Chọn ngày trước" : !current ? "Đang tải giờ trống..." : current.error ? "Không tải được giờ trống" : "Chọn giờ";
  const options = [{ value: "", label: placeholder }, ...(slots ?? []).map(slot => ({
    value: slot.time, disabled: !slot.available,
    label: slot.past ? `${slot.time} · đã qua` : slot.doctorBusy ? `${slot.time} · bác sĩ bận` : slot.remaining === 0 ? `${slot.time} · hết chỗ` : `${slot.time} · còn ${slot.remaining} chỗ`,
  }))];
  return (
    <div>
      <Select id={id} label={label} required={required} value={slots ? value : ""} disabled={!slots} options={options} onChange={event => onChange(event.target.value)} />
      {current?.error && <p role="alert" className="mt-1 text-xs text-rose-700">{current.error}</p>}
      {current?.availability && <p className="mt-1 text-xs text-slate-500">Mỗi lượt giữ chỗ {current.availability.durationMinutes} phút.</p>}
    </div>
  );
}
