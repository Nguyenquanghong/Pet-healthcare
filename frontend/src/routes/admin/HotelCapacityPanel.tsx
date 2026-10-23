import { useState } from "react";
import { apiClient } from "../../services/apiClient";
import { useSession } from "../../store/SessionContext";
import type { ApiSchemas } from "../../types/generated/api";

type RoomCapacity = ApiSchemas["RoomCapacity"];
const roomLabels: Record<RoomCapacity["roomType"], string> = { standard: "Standard", deluxe: "Deluxe", vip: "VIP" };

// AQ-10: rooms per type; the database refuses any booking beyond them. Loaded only
// when opened, so the bookings page makes no extra request. Admins change it;
// other staff see it read-only (the server enforces the same rule).
export function HotelCapacityPanel() {
  const canEdit = useSession().can("hotel.capacity.manage");
  const [items, setItems] = useState<RoomCapacity[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  const load = async () => {
    setError("");
    try {
      const { items } = await apiClient.get<{ items: RoomCapacity[] }>("/hotel-capacity");
      setItems(items);
      setDrafts(Object.fromEntries(items.map(item => [item.roomType, String(item.capacity)])));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Không tải được sức chứa phòng."); }
  };

  const save = async (roomType: RoomCapacity["roomType"]) => {
    const capacity = Number(drafts[roomType]);
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > 1000) { setError("Sức chứa phải là số nguyên từ 0 đến 1000."); return; }
    setSaving(roomType); setError(""); setNotice("");
    try {
      const { capacity: saved } = await apiClient.put<{ capacity: RoomCapacity }>(`/hotel-capacity/${roomType}`, { capacity });
      setItems(current => current?.map(item => item.roomType === roomType ? saved : item) ?? null);
      setNotice(`Đã lưu: ${roomLabels[roomType]} còn ${saved.capacity} phòng mỗi đêm, áp dụng từ hôm nay.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Không lưu được sức chứa."); }
    finally { setSaving(null); }
  };

  return (
    <details className="mb-6 rounded-xl border border-slate-200 bg-white p-4" onToggle={event => { if (event.currentTarget.open && !items) void load(); }}>
      <summary className="cursor-pointer text-sm font-bold text-slate-900">Sức chứa phòng theo loại (mỗi đêm)</summary>
      <p className="mt-2 text-xs text-slate-500">Booking chờ xác nhận, đã xác nhận và đang lưu trú đều giữ chỗ. Hệ thống từ chối booking vượt sức chứa; không giảm được xuống dưới số đã đặt của các đêm tới.</p>
      {error && <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p>}
      {notice && <p className="mt-3 text-sm text-emerald-700">{notice}</p>}
      {items && (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {items.map(item => (
            <label key={item.roomType} className="rounded-lg border border-slate-200 p-3 text-sm">
              <span className="block font-semibold text-slate-800">{roomLabels[item.roomType]}</span>
              <div className="mt-2 flex items-center gap-2">
                <input type="number" min={0} max={1000} step={1} disabled={!canEdit || saving !== null} value={drafts[item.roomType] ?? ""}
                  onChange={event => setDrafts(current => ({ ...current, [item.roomType]: event.target.value }))}
                  aria-label={`Sức chứa ${roomLabels[item.roomType]}`} className="w-24 rounded-lg border border-slate-300 px-2 py-1" />
                {canEdit && <button type="button" disabled={saving !== null || drafts[item.roomType] === String(item.capacity)} onClick={() => void save(item.roomType)}
                  className="rounded-lg bg-primary px-3 py-1 text-xs font-bold text-white disabled:opacity-50">{saving === item.roomType ? "Đang lưu…" : "Lưu"}</button>}
              </div>
            </label>
          ))}
        </div>
      )}
    </details>
  );
}
