import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../../store/AppStoreProvider";
import { apiClient } from "../../services/apiClient";
import type { Appointment } from "../../types/appointment";
import type { HotelBooking } from "../../types/booking";

const labels: Record<string, string> = { pending: "Chờ xác nhận", confirmed: "Đã xác nhận", checked_in: "Đã nhận thú cưng",
  in_progress: "Đang thực hiện", completed: "Hoàn thành dịch vụ", in_stay: "Đang lưu trú", checked_out: "Đã trả thú cưng",
  cancelled: "Đã hủy lịch", rejected: "Đã từ chối", no_show: "Vắng mặt" };
const actionLabels: Record<string, string> = { transition: "Chuyển trạng thái", undo: "Hoàn tác thao tác nhầm", medical_completed: "Hoàn thành khi lưu bệnh án",
  note_updated: "Cập nhật ghi chú", cancelled: "Hủy lịch", rescheduled: "Đổi lịch" };
type Entry = { id: string; action: string; fromStatus: string; toStatus: string; actorName: string; actorRole: string;
  reason: string | null; reversesId: string | null; createdAt: string };
export type StatusDialogSelection = { booking: Appointment | HotelBooking; intent: string };
export function BookingStatusDialog({ kind, selection, onClose, onSaved }: {
  kind: "appointment" | "hotel"; selection: StatusDialogSelection; onClose: () => void; onSaved: () => void;
}) {
  const { booking, intent } = selection;
  const { pets, owners, refreshData } = useAppStore();
  const pet = pets.find(p => p.id === booking.petId), owner = owners.find(o => o.id === booking.ownerId);
  const dialog = useRef<HTMLDialogElement>(null), submitting = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [reason, setReason] = useState("");
  const [events, setEvents] = useState<Entry[]>([]), [loading, setLoading] = useState(false), [attempt, setAttempt] = useState(0);
  const path = `/${kind === "appointment" ? "appointments" : "hotel-bookings"}/${booking.id}`;
  const undo = intent === "undo", history = intent === "history";
  const checkin = booking.status === "checked_in" || booking.status === "in_stay";
  const title = history ? "Lịch sử thao tác" : undo ? checkin ? "Hoàn tác check-in" : kind === "hotel" ? "Hoàn tác trả thú cưng" : "Mở lại dịch vụ"
    : ["checked_in", "in_stay"].includes(intent) ? "Xác nhận đã nhận thú cưng"
    : intent === "checked_out" ? "Xác nhận đã trả thú cưng" : intent === "completed" ? "Xác nhận hoàn thành dịch vụ" : `Xác nhận: ${labels[intent] || intent}`;
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    if (!history) return;
    let active = true; setLoading(true); setError("");
    apiClient.get<Entry[]>(`${path}/status-history`).then(data => { if (active) setEvents(data); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Không tải được lịch sử."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [history, path, attempt]);
  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    let saved = false;
    try {
      const payload = { expectedRevision: booking.statusRevision, ...(undo ? { reason } : { status: intent }) };
      if (undo) await apiClient.post(`${path}/undo-status`, payload); else await apiClient.patch(`${path}/status`, payload);
      saved = true;
      await refreshData(); onSaved(); onClose();
    } catch (e) {
      setError(saved ? "Thao tác đã được lưu nhưng chưa tải lại được danh sách. Đóng hộp thoại và tải lại trang để đối chiếu."
        : e instanceof Error ? e.message : "Không lưu được thao tác. Hãy tải lại để kiểm tra trước khi thử lại.");
    } finally { setBusy(false); if (!saved) submitting.current = false; }
  };
  return createPortal(<dialog ref={dialog} aria-labelledby="booking-status-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}
    className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl backdrop:bg-black/50">
    <h2 id="booking-status-title" className="text-xl font-bold">{title}</h2>
    <div className="my-4 flex gap-3 rounded-xl bg-slate-50 p-3">
      {pet?.avatarUrl && <img src={pet.avatarUrl} alt={`Ảnh ${pet.name}`} className="h-16 w-16 rounded-lg object-cover" />}
      <div className="min-w-0 space-y-1 text-sm">
        <p className="text-lg font-bold">{pet?.name || "Thú cưng"}</p>
        <p>Chủ nuôi: {owner?.fullName || "Chưa có thông tin"} · {owner?.phone || "Chưa có số điện thoại"}</p>
        <p className="break-all">Mã lịch: {booking.id}</p>
        <p>{"serviceName" in booking ? booking.serviceName : `Lưu trú · ${booking.roomType}`}</p>
        <p>{"date" in booking ? `${booking.date} · ${booking.time}` : `${booking.checkIn} → ${booking.checkOut}`}</p>
        <p>Hiện tại: <strong>{labels[booking.status]}</strong></p>
      </div>
    </div>
    {history ? <>
      {loading ? <p role="status">Đang tải lịch sử…</p> : !error && !events.length ? <p>Chưa có lịch sử thao tác được ghi nhận. Các thao tác trước khi nâng cấp không được tạo lại.</p> :
        <ol className="space-y-3">{events.map(event => <li key={event.id} className="rounded-lg border p-3 text-sm">
          <p className="font-semibold">{actionLabels[event.action] || event.action}</p>
          <p>{labels[event.fromStatus] || event.fromStatus} → {labels[event.toStatus] || event.toStatus}</p>
          <p>{event.actorName} · {new Date(event.createdAt).toLocaleString("vi-VN")}</p>
          {event.reason && <p className="break-words">Lý do: {event.reason}</p>}
          {event.reversesId && <p>Đảo thao tác trước đó; bản ghi gốc được giữ lại.</p>}
          {events.some(e => e.reversesId === event.id) && <p className="text-amber-700">Thao tác này đã được hoàn tác.</p>}
        </li>)}</ol>}
    </> : <form onSubmit={e => { e.preventDefault(); void submit(); }}>
      {undo ? <>
        <p className="mb-3 text-sm">Lịch đặt vẫn được giữ. Hệ thống kiểm tra dữ liệu liên quan trước khi khôi phục trạng thái và gửi thông báo đính chính cho chủ nuôi.</p>
        <label className="block font-semibold">Lý do hoàn tác<textarea required maxLength={500} value={reason} disabled={busy}
          onChange={e => setReason(e.target.value)} className="mt-1 w-full rounded-lg border p-2 font-normal" /></label>
      </> : <p className="text-sm">Kiểm tra đúng thú cưng, chủ nuôi và lịch dịch vụ trước khi xác nhận.
        {intent === "completed" && " Hoàn thành dịch vụ không đồng nghĩa đã trả thú cưng hoặc đã thu tiền."}
        {intent === "checked_out" && " Chỉ xác nhận sau khi hóa đơn đã được xác nhận thu đủ tiền và đã bàn giao thú cưng cho đúng người nhận."}</p>}
      <button type="submit" disabled={busy || submitting.current || (undo && !reason.trim())} className="mt-4 rounded-lg bg-primary px-4 py-2 font-semibold text-white disabled:opacity-50">
        {busy ? "Đang lưu…" : undo ? "Xác nhận hoàn tác" : title}</button>
    </form>}
    {error && <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p>}
    {error && history && <button className="mt-3 underline" onClick={() => setAttempt(n => n + 1)}>Thử tải lại</button>}
    <button type="button" disabled={busy} onClick={onClose} className="mt-4 rounded-lg border px-4 py-2 disabled:opacity-50">Đóng</button>
  </dialog>, document.body);
}
