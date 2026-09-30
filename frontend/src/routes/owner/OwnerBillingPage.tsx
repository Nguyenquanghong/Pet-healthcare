import { useCallback, useEffect, useRef, useState } from "react";
import { OwnerLayout } from "../../components/layout/owner/OwnerLayout";
import { useAppStore } from "../../store/AppStoreProvider";
import { apiClient } from "../../services/apiClient";
import type { Invoice, BankTransferDetails } from "../../types/invoice";
import { BankTransferPanel } from "./BankTransferPanel";
import { formatCurrency } from "../../utils/formatCurrency";
import { isSpaAppointmentType } from "../../types/appointment";

const statusLabel = { unpaid: "Chờ thanh toán", paid: "Đã thanh toán", refunded: "Đã hoàn tiền" };
export function OwnerBillingPage() {
  const { appointments, hotelBookings, pets } = useAppStore();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [bankTransfer, setBankTransfer] = useState<BankTransferDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const refresh = useCallback(async () => {
    const [rows, options] = await Promise.all([
      apiClient.get<Invoice[]>("/invoices"),
      apiClient.get<{ vnpayEnabled: boolean; bankTransfer: BankTransferDetails | null }>("/payments/options"),
    ]);
    setInvoices(rows); setEnabled(options.vnpayEnabled); setBankTransfer(options.bankTransfer);
  }, []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try { await refresh(); } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Không tải được hóa đơn.");
      } finally { if (active) setLoading(false); }
    };
    void load();
    // Payment status always comes from the backend. Return query parameters cannot mark an invoice paid.
    const query = new URLSearchParams(window.location.search);
    if (query.has("vnp_TxnRef")) {
      void apiClient.get<{ verified: boolean }>(`/payments/vnpay/return?${query.toString()}`).then(result => {
        if (active) setMessage(result.verified
          ? "Đã trở về từ VNPay. Trạng thái hóa đơn bên dưới sẽ cập nhật khi hệ thống nhận xác nhận giao dịch."
          : "Không xác minh được kết quả chuyển hướng. Hãy kiểm tra trạng thái hóa đơn trước khi thanh toán lại.");
      }).catch(() => { if (active) setError("Chưa xác minh được kết quả VNPay. Hãy tải lại hóa đơn."); });
      window.history.replaceState(null, "", window.location.pathname);
    }
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [refresh]);
  const act = async (work: () => Promise<void>) => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError(""); setMessage("");
    try { await work(); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Không thực hiện được thanh toán."); }
    finally { submitting.current = false; setBusy(false); }
  };
  const sources = [
    ...appointments.filter(a => a.status === "completed" && !invoices.some(i => i.appointmentId === a.id))
      .map(a => ({ id: a.id, type: "appointment", petId: a.petId, label: `${a.serviceName} · ${a.date}`, fixed: isSpaAppointmentType(a.type) })),
  ];
  const button = "rounded-lg border px-4 py-2 text-sm font-semibold disabled:opacity-50";
  return <OwnerLayout title="Hóa đơn & Thanh toán">
    <div className="mb-5 flex items-start justify-between gap-3">
      <p className="max-w-2xl text-sm text-slate-600">Xem các khoản phí sau khi hoàn tất dịch vụ. Với dịch vụ khám có phí phát sinh, cửa hàng sẽ chốt hóa đơn trước khi bạn thanh toán.</p>
      <button className={button} disabled={busy} onClick={() => void act(async () => {})}>Tải lại</button>
    </div>
    {error && <p role="alert" className="mb-4 rounded-lg bg-rose-50 p-3 text-rose-700">{error}</p>}
    {message && <p role="status" className="mb-4 rounded-lg bg-blue-50 p-3 text-blue-800">{message}</p>}
    {loading ? <p>Đang tải hóa đơn...</p> : <>
      {!bankTransfer && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Cửa hàng chưa cấu hình tài khoản nhận chuyển khoản. Bạn vẫn có thể chọn thanh toán tại cửa hàng.</p>}
      {!invoices.length && !sources.length && <p className="rounded-xl bg-white p-6 text-slate-600">Bạn chưa có hóa đơn cần thanh toán.</p>}
      {hotelBookings.some(b => b.status === "in_stay" && !invoices.some(i => i.hotelBookingId === b.id)) &&
        <p className="rounded-xl bg-blue-50 p-4 text-sm text-blue-800">Cửa hàng sẽ chốt hóa đơn lưu trú và các dịch vụ phát sinh trước khi bạn thanh toán.</p>}
      <div className="space-y-5">
        {invoices.map(invoice => <article key={invoice.id} aria-label={invoice.invoiceCode} className="rounded-xl border bg-white p-5 shadow-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <div><h2 className="break-all text-sm font-bold">{invoice.invoiceCode}</h2><p className="text-sm text-slate-500">{pets.find(p => p.id === invoice.petId)?.name} · {new Date(invoice.issuedAt).toLocaleDateString("vi-VN")}</p></div>
            <strong className={invoice.paymentStatus === "paid" ? "text-emerald-700" : "text-amber-700"}>{statusLabel[invoice.paymentStatus]}</strong>
          </div>
          <ul className="my-4 divide-y">
            {invoice.items.map(item => <li key={item.id} className="flex justify-between gap-4 py-2 text-sm"><span>{item.description}<span className="block text-xs text-slate-500">{item.quantity} × {formatCurrency(item.unitPrice)}</span></span><span className="whitespace-nowrap">{formatCurrency(item.amount)}</span></li>)}
          </ul>
          <p className="text-sm text-slate-500">Thuế: {formatCurrency(invoice.taxAmount)} · Giảm giá: {formatCurrency(invoice.discountAmount)}</p>
          <p className="my-2 text-lg font-bold">Tổng thanh toán: {formatCurrency(invoice.totalAmount)}</p>
          {invoice.notes && <p className="mb-3 text-sm">Ghi chú: {invoice.notes}</p>}
          {invoice.paymentChannel && <p className="mb-3 text-sm">Hình thức: {invoice.paymentChannel === "onsite" ? "Thanh toán tại cửa hàng" : invoice.paymentChannel === "bank_transfer" ? "Chuyển khoản ngân hàng" : "VNPay (Sandbox)"}</p>}
          {invoice.paidAt && <p className="text-sm text-slate-600">Đã xác nhận lúc {new Date(invoice.paidAt).toLocaleString("vi-VN")}</p>}
          {invoice.paymentStatus !== "unpaid" && invoice.paymentChannel === "bank_transfer" && invoice.bankTransferDetails?.isDemo && <p className="mt-2 text-sm text-amber-800">Dữ liệu thanh toán minh họa.</p>}
          {invoice.paymentStatus === "unpaid" && <div className="mt-3 space-y-3">
            {invoice.paymentChannel === "bank_transfer" && <BankTransferPanel invoice={invoice} busy={busy} onReport={reference => void act(async () => {
              await apiClient.post(`/invoices/${invoice.id}/transfer-report`, { reference });
              setMessage("Đã gửi thông báo chuyển khoản. Hóa đơn đang chờ cửa hàng kiểm tra tiền nhận.");
            })} />}
            <div className="flex flex-wrap gap-3">
              {invoice.paymentChannel === "online" && <button className={button} disabled={busy || !enabled} onClick={() => void act(async () => {
                const result = await apiClient.post<{ message: string }>(`/payments/${invoice.id}/reconcile`);
                setMessage(result.message);
              })}>Kiểm tra kết quả VNPay</button>}
              <button className={button} disabled={busy || invoice.transferReviewStatus === "pending"} onClick={() => void act(async () => {
                await apiClient.patch(`/invoices/${invoice.id}/onsite`);
                setMessage("Đã chọn thanh toán tại cửa hàng. Nhân viên sẽ xác nhận sau khi nhận đủ tiền.");
              })}>Thanh toán tại cửa hàng</button>
              {invoice.paymentChannel !== "bank_transfer" && <button className={button + " bg-primary text-white"} disabled={busy || !bankTransfer} onClick={() => void act(async () => {
                await apiClient.patch(`/invoices/${invoice.id}/bank-transfer`);
              })}>Chuyển khoản ngân hàng</button>}
              {enabled && <button className={button + " bg-primary text-white"} disabled={busy || invoice.transferReviewStatus === "pending" || invoice.paymentChannel === "bank_transfer"} onClick={() => void act(async () => {
                const result = await apiClient.post<{ paymentUrl: string }>(`/payments/${invoice.id}/vnpay`);
                const url = new URL(result.paymentUrl);
                if (url.origin !== "https://sandbox.vnpayment.vn") throw new Error("Địa chỉ thanh toán không hợp lệ.");
                window.location.assign(url.href);
              })}>Thanh toán VNPay</button>}
            </div>
            {enabled && <p className="text-xs text-slate-500">VNPay đang ở môi trường thử nghiệm, không thu tiền thật. Nếu giao dịch đang chờ xác nhận, vui lòng kiểm tra trạng thái trước khi trả bằng cách khác.</p>}
          </div>}
        </article>)}
        {sources.map(source => <article key={source.id} className="rounded-xl border bg-white p-5">
          <h2 className="font-semibold">{source.label}</h2><p className="mb-3 text-sm text-slate-500">{pets.find(p => p.id === source.petId)?.name}</p>
          {source.fixed ? <button className={button} disabled={busy} onClick={() => void act(async () => {
            await apiClient.post("/invoices/checkout", { type: source.type, relatedId: source.id });
          })}>Xem phí và thanh toán</button> : <p className="text-sm text-amber-700">Đang chờ cửa hàng chốt phí dịch vụ.</p>}
        </article>)}
      </div>
    </>}
  </OwnerLayout>;
}
