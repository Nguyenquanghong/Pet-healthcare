import { useMemo, useRef, useState } from "react";
import { useAppStore } from "../../store/AppStoreProvider";
import { apiClient } from "../../services/apiClient";
import type { Invoice } from "../../types/invoice";
import { formatCurrency } from "../../utils/formatCurrency";
import pricing from "../../../../backend/src/domain/pricing.json";

type Line = { description: string; quantity: number; unitPrice: number };
export function InvoiceIssueForm({ invoices, onCreated, onClose }: {
  invoices: Invoice[]; onCreated: (invoice: Invoice) => void; onClose: () => void;
}) {
  const { appointments, hotelBookings, pets, owners } = useAppStore();
  const [sourceKey, setSourceKey] = useState("");
  const [items, setItems] = useState<Line[]>([]);
  const [tax, setTax] = useState("0");
  const [discount, setDiscount] = useState("0");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const rates: Record<string, number> = { ...pricing.appointmentEstimates, ...pricing.fixedSpaRates };
  const sources = useMemo(() => [
    ...appointments.filter(a => a.status === "completed" && !invoices.some(i => i.appointmentId === a.id))
      .map(a => ({ key: `appointment:${a.id}`, id: a.id, type: "appointment" as const, petId: a.petId, ownerId: a.ownerId,
        description: a.serviceName, label: `${a.serviceName} — ${a.date}`, amount: 0, serviceType: a.type })),
    ...hotelBookings.filter(b => b.status === "checked_out" && !invoices.some(i => i.hotelBookingId === b.id))
      .map(b => ({ key: `hotel_booking:${b.id}`, id: b.id, type: "hotel_booking" as const, petId: b.petId, ownerId: b.ownerId,
        description: "Lưu trú", label: `Lưu trú ${b.checkIn} → ${b.checkOut}`, amount: b.totalAmount, serviceType: "" })),
  ], [appointments, hotelBookings, invoices]);
  const source = sources.find(s => s.key === sourceKey);
  const owner = owners.find(o => o.id === source?.ownerId);
  const pet = pets.find(p => p.id === source?.petId);
  const subtotal = (source?.amount ?? 0) + items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const total = subtotal + Number(tax) - Number(discount);
  const field = "mt-1 w-full rounded-lg border border-slate-300 p-2";
  const change = (index: number, patch: Partial<Line>) => setItems(previous => previous.map((item, i) => i === index ? { ...item, ...patch } : item));

  return <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/60 p-4">
    <form role="dialog" aria-modal="true" aria-labelledby="issue-title" className="my-8 w-full max-w-2xl space-y-4 rounded-xl bg-white p-6 shadow-lg"
      onSubmit={async event => {
        event.preventDefault();
        if (!source || submitting.current) return;
        submitting.current = true; setSaving(true); setError("");
        try {
          const result = await apiClient.post<{ invoice: Invoice }>("/invoices", {
            type: source.type, relatedId: source.id, items,
            taxAmount: Number(tax), discountAmount: Number(discount), notes,
          });
          onCreated(result.invoice);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Không thể lập hóa đơn."); }
        finally { submitting.current = false; setSaving(false); }
      }}>
      <h2 id="issue-title" className="text-xl font-bold">Lập hóa đơn</h2>
      <p className="text-sm text-slate-600">Chọn đơn đã hoàn tất. Thông tin khách hàng và thú cưng được lấy từ đơn đặt.</p>
      {error && <p role="alert" className="text-rose-700">{error}</p>}
      <fieldset disabled={saving} className="space-y-4">
      <label className="block text-sm font-semibold">Dịch vụ đã hoàn tất
        <select className={field} required value={sourceKey} onChange={e => {
          setSourceKey(e.target.value);
          const next = sources.find(s => s.key === e.target.value);
          setItems(next?.type === "appointment" ? [{ description: next.description, quantity: 1, unitPrice: rates[next.serviceType] ?? 0 }] : []);
          setTax("0"); setDiscount("0"); setError("");
        }}>
          <option value="">Chọn dịch vụ</option>
          {sources.map(s => <option key={s.key} value={s.key}>{s.label} — {pets.find(p => p.id === s.petId)?.name} — {owners.find(o => o.id === s.ownerId)?.fullName}</option>)}
        </select>
      </label>
      {!sources.length && <p className="text-sm text-slate-500">Chưa có dịch vụ hoàn tất chưa lập hóa đơn.</p>}
      {source && <>
        <div className="rounded-lg bg-slate-50 p-3 text-sm">
          <p>Khách hàng: <strong>{owner?.fullName}</strong> · {owner?.phone}</p>
          <p>Địa chỉ: {owner?.address || "Chưa cung cấp"}</p>
          <p>Thú cưng: <strong>{pet?.name}</strong> · {pet?.breed}</p>
          <p>Đơn đặt: {source.label}</p>
        </div>
        {source.type === "hotel_booking"
          ? <p>Tiền lưu trú theo đơn: <strong>{formatCurrency(source.amount)}</strong>. Chỉ thêm khoản phát sinh bên dưới.</p>
          : <p className="text-sm text-slate-600">Đơn giá được điền từ bảng giá tham khảo. Kiểm tra và chốt phí thực tế, bổ sung dịch vụ đã sử dụng trước khi lưu.</p>}
        {items.map((item, index) => <div key={index} className="space-y-2 rounded-lg border p-3">
          <label className="block text-sm">Dịch vụ {index + 1}<input className={field} required maxLength={300} value={item.description} onChange={e => change(index, { description: e.target.value })} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">Số lượng {index + 1}<input className={field} required type="number" min="1" max="10000" step="1" value={item.quantity} onChange={e => change(index, { quantity: Number(e.target.value) })} /></label>
            <label className="text-sm">Đơn giá {index + 1} (VND)<input className={field} required type="number" min="0" max="9999999999" step="1" value={item.unitPrice} onChange={e => change(index, { unitPrice: Number(e.target.value) })} /></label>
          </div>
          <div className="flex justify-between text-sm"><span>Thành tiền: {formatCurrency(item.quantity * item.unitPrice)}</span><button type="button" className="text-rose-700" aria-label={`Xóa dịch vụ ${index + 1}`} onClick={() => setItems(previous => previous.filter((_, i) => i !== index))}>Xóa</button></div>
        </div>)}
        <button type="button" disabled={items.length >= 49} className="rounded-lg border px-3 py-2 text-sm" onClick={() => setItems(previous => [...previous, { description: "", quantity: 1, unitPrice: 0 }])}>Thêm dịch vụ / phụ phí</button>
      </>}
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm font-semibold">Tiền thuế (VND)<input className={field} type="number" min="0" max="9999999999" step="1" required value={tax} onChange={e => setTax(e.target.value)} /></label>
        <label className="text-sm font-semibold">Giảm giá (VND)<input className={field} type="number" min="0" max={subtotal} step="1" required value={discount} onChange={e => setDiscount(e.target.value)} /></label>
      </div>
      <label className="block text-sm font-semibold">Ghi chú<textarea className={field} maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)} /></label>
      </fieldset>
      <p className="font-bold">Tổng tiền: {formatCurrency(Number.isFinite(total) ? total : 0)}</p>
      <p className="text-sm text-slate-600">Sau khi lưu, chủ nuôi nhận thông báo và chọn chuyển khoản hoặc thanh toán tại cửa hàng.</p>
      <div className="flex justify-end gap-3">
        <button type="button" disabled={saving} onClick={onClose} className="rounded-lg border px-4 py-2">Hủy</button>
        <button type="submit" disabled={saving || !source || !Number.isFinite(total) || total <= 0} className="rounded-lg bg-primary px-4 py-2 text-white disabled:opacity-50">{saving ? "Đang lưu..." : "Lưu hóa đơn"}</button>
      </div>
    </form>
  </div>;
}
