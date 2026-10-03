import { usePagedList } from "../../services/usePagedList";
import { Pagination } from "../../components/ui/Pagination";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Printer,
  Receipt,
  Search,
  CheckCircle2,
  X,
  Check,
} from "lucide-react";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { useAppStore } from "../../store/AppStoreProvider";
import type { Invoice, PaymentStatus, PaymentMethod } from "../../types/invoice";
import { formatInvoiceCurrency as formatCurrency } from "../../utils/formatCurrency";

import { apiClient } from "../../services/apiClient";
import { InvoiceIssueForm } from "./InvoiceIssueForm";
import { useSearchParams } from "react-router-dom";

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = { cash: "Tiền mặt", bank_transfer: "Chuyển khoản", credit_card: "Thẻ", qr_code: "QR", vnpay: "VNPay" };

const PAYMENT_STATUS_COLORS: Record<PaymentStatus, string> = {
  paid: "bg-emerald-50 text-emerald-700 border-emerald-200",
  unpaid: "bg-amber-50 text-amber-700 border-amber-200",
  refunded: "bg-rose-50 text-rose-700 border-rose-200",
};

const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  paid: "Đã thanh toán",
  unpaid: "Chờ thanh toán",
  refunded: "Đã hoàn tiền",
};

type PaymentEvent = { id: string; action: string; fromStatus: string; toStatus: string;
  actorName: string; actorRole: string; reason: string | null; reference: string | null; createdAt: string };

export function AdminBillingPage() {
  const [searchParams] = useSearchParams();
  const initialHotelBookingId = searchParams.get("hotelBookingId");


  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paymentEvents, setPaymentEvents] = useState<PaymentEvent[]>([]);
  const [historyError, setHistoryError] = useState("");
  const list = usePagedList<Invoice>("/invoices", { q: searchQuery, status: statusFilter });
  const lookup = usePagedList<Invoice>("/invoices", { bookingId: initialHotelBookingId ?? undefined }, Boolean(initialHotelBookingId));
  const invoices = list.items, setInvoices = list.setItems, loading = list.loading, loadError = list.error;
  const selectedInvoice = [...invoices, ...lookup.items].find(invoice => invoice.id === selectedId);
  const pets = [...list.related.pets, ...lookup.related.pets], owners = [...list.related.owners, ...lookup.related.owners];
  const [issuing, setIssuing] = useState(Boolean(initialHotelBookingId));
  const [paymentInvoice, setPaymentInvoice] = useState<Invoice | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [paymentError, setPaymentError] = useState("");
  const [paying, setPaying] = useState(false);
  const [rejectInvoice, setRejectInvoice] = useState<Invoice | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const submitting = useRef(false);

  const loadInvoices = list.reload;
  useEffect(() => {
    if (!initialHotelBookingId) return;
    const existing = lookup.items.find(item => item.hotelBookingId === initialHotelBookingId);
    if (existing) { setIssuing(false); setSelectedId(existing.id); }
  }, [initialHotelBookingId, lookup.items]);
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setHistoryError(""); setPaymentEvents([]);
    void apiClient.get<PaymentEvent[]>(`/invoices/${selectedId}/payment-history`).then(events => {
      if (active) setPaymentEvents(events);
    }).catch(reason => {
      if (active) setHistoryError(reason instanceof Error ? reason.message : "Không tải được lịch sử thanh toán.");
    });
    return () => { active = false; };
  }, [selectedId]);
  const [toastMsg, setToastMsg] = useState("");

  const toast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3500);
  };

  const filteredInvoices = invoices;

  const handleMarkAsPaid = async () => {
    if (!paymentInvoice || submitting.current) return;
    submitting.current = true; setPaying(true); setPaymentError("");
    try {
      const { invoice } = await apiClient.patch<{ invoice: Invoice }>(`/invoices/${paymentInvoice.id}/pay`, { paymentMethod });
      setInvoices(previous => previous.map(item => item.id === invoice.id ? invoice : item));
      setPaymentInvoice(null);
      void list.reload().catch(() => undefined);
      toast("Đã lưu xác nhận thu tiền.");
    } catch (reason) {
      setPaymentError(reason instanceof Error ? reason.message : "Không thể ghi nhận thanh toán. Hãy tải lại để đối chiếu trước khi thử lại.");
    } finally { submitting.current = false; setPaying(false); }
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <AdminLayout title="Quản lý Hóa đơn & Thanh toán">
      <Pagination {...list} />
      {toastMsg && (
        <div className="mb-4 flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-5 py-4 text-emerald-800 font-semibold animate-fadeIn">
          <CheckCircle2 size={18} /> {toastMsg}
        </div>
      )}

      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-slate-600">Ghi nhận tiền đã thu cho hóa đơn dịch vụ.</p>
        <div className="flex gap-2">
          <button disabled={loading || paying} onClick={() => void loadInvoices()} className="rounded-lg border px-4 py-2 disabled:opacity-50">Tải lại</button>
          <button disabled={loading || !!loadError} onClick={() => setIssuing(true)} className="rounded-lg bg-primary px-4 py-2 text-white disabled:opacity-50">Lập hóa đơn</button>
        </div>
      </div>
      {loadError && <p role="alert" className="mb-4 text-rose-700">{loadError}</p>}
      {loading && <p role="status" className="mb-4">Đang tải hóa đơn...</p>}
      {issuing && !loading && <InvoiceIssueForm invoices={invoices} initialSourceKey={initialHotelBookingId ? `hotel_booking:${initialHotelBookingId}` : ""} onClose={() => setIssuing(false)} onCreated={invoice => {
        setInvoices(previous => [invoice, ...previous]); setIssuing(false); toast("Đã lưu hóa đơn chờ thanh toán.");
        void list.reload().catch(() => undefined);
      }} />}
      {paymentInvoice && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
        <form role="dialog" aria-modal="true" aria-labelledby="payment-title" className="w-full max-w-md space-y-4 rounded-xl bg-white p-6"
          onSubmit={event => { event.preventDefault(); void handleMarkAsPaid(); }}>
          <h2 id="payment-title" className="text-xl font-bold">Xác nhận đã thu tiền</h2>
          <p className="break-all">{paymentInvoice.invoiceCode}</p>
          <p className="text-xl font-bold">{formatCurrency(paymentInvoice.totalAmount)}</p>
          <label className="block">Phương thức thanh toán
            <select className="mt-1 w-full rounded-lg border p-2" value={paymentMethod} disabled={paying || paymentInvoice.paymentChannel === "bank_transfer"} onChange={event => setPaymentMethod(event.target.value as PaymentMethod)}>
              {(["cash", "bank_transfer"] as const).map(value => <option key={value} value={value}>{PAYMENT_METHOD_LABELS[value]}</option>)}
            </select>
          </label>
          <p className="text-sm text-slate-600">Chỉ xác nhận sau khi đã nhận đủ tiền. Thao tác này ghi nhận khoản thu, không tự trừ tiền từ thẻ hoặc tài khoản ngân hàng.</p>
          {paymentInvoice.paymentChannel === "bank_transfer" && <div className="space-y-1 rounded-lg bg-blue-50 p-3 text-sm">
            {paymentInvoice.bankTransferDetails?.isDemo && <p className="font-semibold text-amber-800">Dữ liệu minh họa — xác nhận để demo.</p>}
            <p>Tài khoản nhận: {paymentInvoice.bankTransferDetails?.accountNumber} · {paymentInvoice.bankTransferDetails?.bankName}</p>
            <p className="break-all">Nội dung chuyển: {paymentInvoice.transferContent}</p>
            <p>Mã giao dịch khách báo: {paymentInvoice.transferReference || "Chưa cung cấp"}</p>
            <p>Thông báo của khách chưa chứng minh cửa hàng đã nhận tiền. Kiểm tra giao dịch ngân hàng và số tiền trước khi xác nhận.</p>
          </div>}
          {paymentError && <p role="alert" className="text-rose-700">{paymentError}</p>}
          <div className="flex justify-end gap-3">
            <button type="button" disabled={paying} onClick={() => setPaymentInvoice(null)} className="rounded-lg border px-4 py-2">Hủy</button>
            <button type="submit" disabled={paying} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50">{paying ? "Đang lưu..." : "Xác nhận đã thu đủ tiền"}</button>
          </div>
        </form>
      </div>}
      {rejectInvoice && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
        <form role="dialog" aria-modal="true" aria-label="Chưa xác nhận chuyển khoản" className="w-full max-w-md space-y-4 rounded-xl bg-white p-6" onSubmit={async event => {
          event.preventDefault();
          if (submitting.current) return;
          submitting.current = true; setPaying(true); setPaymentError("");
          try {
            const result = await apiClient.post<{ invoice: Invoice }>(`/invoices/${rejectInvoice.id}/transfer-reject`, { reason: rejectReason });
            setInvoices(previous => previous.map(i => i.id === result.invoice.id ? result.invoice : i));
            void list.reload().catch(() => undefined);
            setRejectInvoice(null); toast("Đã gửi lý do cho chủ nuôi; hóa đơn vẫn chưa thanh toán.");
          } catch (reason) { setPaymentError(reason instanceof Error ? reason.message : "Không lưu được kết quả kiểm tra."); }
          finally { submitting.current = false; setPaying(false); }
        }}>
          <h2 className="text-xl font-bold">Chưa xác nhận chuyển khoản</h2>
          <label className="block text-sm">Lý do<textarea className="mt-1 w-full rounded-lg border p-2" required maxLength={500} disabled={paying} value={rejectReason} onChange={e => setRejectReason(e.target.value)} /></label>
          {paymentError && <p role="alert" className="text-rose-700">{paymentError}</p>}
          <div className="flex justify-end gap-3"><button type="button" disabled={paying} onClick={() => setRejectInvoice(null)} className="rounded-lg border px-4 py-2">Hủy</button><button disabled={paying || !rejectReason.trim()} className="rounded-lg bg-primary px-4 py-2 text-white">Gửi lý do</button></div>
        </form>
      </div>}

      {/* Header Search & Controls */}
      <div className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Tìm mã hóa đơn / chuyển khoản, chủ nuôi, thú cưng..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-white pl-10 pr-4 py-2.5 text-sm focus:border-primary focus:outline-none shadow-xs"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Filter Tabs */}
        <div className="flex items-center gap-2">
          {(["all", "paid", "unpaid"] as const).map((st) => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={`rounded-xl border px-3.5 py-2 text-xs font-bold transition-colors ${
                statusFilter === st
                  ? "bg-slate-900 text-white border-slate-900 shadow-xs"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
            >
              {st === "all"
                ? "Tất cả"
                : st === "paid"
                ? "Đã thanh toán"
                : "Chờ thanh toán"}
            </button>
          ))}
        </div>
      </div>

      {/* Invoice List Table */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-[820px] w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-xs uppercase text-slate-500 font-bold">
              <tr>
                <th className="px-5 py-4">Mã Hóa đơn</th>
                <th className="px-5 py-4">Khách hàng & Thú cưng</th>
                <th className="px-5 py-4">Loại dịch vụ</th>
                <th className="px-5 py-4">Ngày phát hành</th>
                <th className="px-5 py-4">Tổng thanh toán</th>
                <th className="px-5 py-4">Trạng thái</th>
                <th className="px-5 py-4 text-right">Hành động</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredInvoices.map((inv) => {
                const pet = pets.find((p) => p.id === inv.petId);
                const owner = owners.find((o) => o.id === inv.ownerId);
                const currentStatus = inv.paymentStatus;

                return (
                  <tr key={inv.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="px-5 py-4 font-bold text-slate-900 whitespace-nowrap">
                      {inv.invoiceCode}
                    </td>

                    <td className="px-5 py-4">
                      <p className="font-bold text-slate-900">{owner?.fullName}</p>
                      <p className="text-xs text-slate-500">
                        Thú cưng: <strong>{pet?.name}</strong> ({pet?.breed})
                      </p>
                    </td>

                    <td className="px-5 py-4 whitespace-nowrap text-xs font-semibold text-slate-700">
                      {inv.type === "appointment" ? "🏥 Dịch vụ khám" : "🏨 Lưu trú Khách sạn"}
                    </td>

                    <td className="px-5 py-4 whitespace-nowrap text-xs text-slate-600">
                      {new Date(inv.issuedAt).toLocaleDateString("vi-VN")}
                    </td>

                    <td className="px-5 py-4 whitespace-nowrap font-black text-primary">
                      {formatCurrency(inv.totalAmount)}
                    </td>

                    <td className="px-5 py-4 whitespace-nowrap">
                      <span
                        className={`inline-block rounded-lg border px-2.5 py-1 text-xs font-bold ${
                          PAYMENT_STATUS_COLORS[currentStatus]
                        }`}
                      >
                        {PAYMENT_STATUS_LABELS[currentStatus]}
                      </span>
                      <p className="mt-1 text-xs text-slate-500">{inv.paymentChannel === "online" ? "VNPay · xác nhận tự động" : inv.paymentChannel === "onsite" ? "Thanh toán tại cửa hàng" : inv.paymentChannel === "bank_transfer" ? "Chuyển khoản ngân hàng" : "Chưa chọn cách thanh toán"}</p>
                      {inv.transferReviewStatus === "pending" && <p className="mt-1 text-xs font-bold text-amber-700">Khách báo đã chuyển · Chờ kiểm tra</p>}
                      {inv.transferReviewStatus === "rejected" && currentStatus === "unpaid" && <p className="mt-1 text-xs text-rose-700">Đã yêu cầu kiểm tra lại</p>}
                    </td>

                    <td className="px-5 py-4 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        {currentStatus === "unpaid" && inv.transferReviewStatus === "pending" && <button className="rounded-lg border px-2.5 py-1.5 text-xs" disabled={paying} onClick={() => { setRejectInvoice(inv); setRejectReason(""); setPaymentError(""); }}>Chưa nhận được tiền</button>}
                        {currentStatus === "unpaid" && inv.paymentChannel === "online" && <button disabled={paying} className="rounded-lg border px-2.5 py-1.5 text-xs" onClick={async () => {
                          setPaying(true);
                          try {
                            const result = await apiClient.post<{ message: string }>(`/payments/${inv.id}/reconcile`);
                            toast(result.message); await loadInvoices();
                          } catch (reason) { setPaymentError(reason instanceof Error ? reason.message : "Không thể đối soát VNPay."); }
                          finally { setPaying(false); }
                        }}>Đối soát VNPay</button>}
                        <button
                          onClick={() => setSelectedId(inv.id)}
                          title="Xem / In hóa đơn"
                          className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 transition-colors"
                        >
                          <Printer size={14} className="text-primary" /> Xem / In
                        </button>

                        {currentStatus === "unpaid" && inv.paymentChannel !== "online" && (
                          <button
                            disabled={loading || !!loadError}
                            onClick={() => { setPaymentInvoice(inv); setPaymentMethod(inv.paymentChannel === "bank_transfer" ? "bank_transfer" : "cash"); setPaymentError(""); }}
                            title="Xác nhận thanh toán"
                            className="flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 transition-colors"
                          >
                            <Check size={14} /> Thanh toán
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}

              {!loading && !loadError && filteredInvoices.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-slate-400">
                    Không tìm thấy hóa đơn phù hợp.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Printable Invoice Modal */}
      {selectedInvoice && createPortal(
        <div className="invoice-print-overlay fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/60 p-4">
          <div role="dialog" aria-modal="true" aria-label="Chi tiết hóa đơn" className="invoice-print-sheet my-8 w-full max-w-2xl rounded-lg border border-slate-200 bg-white p-8 shadow-lg print:max-w-none print:border-0 print:p-0 print:shadow-none">
            {/* Header / Actions in modal */}
            <div className="flex items-center justify-between pb-4 mb-6 border-b border-slate-100 print:hidden">
              <span className="inline-flex items-center gap-1.5 font-bold text-slate-900 text-lg">
                <Receipt size={22} className="text-primary" /> Chi tiết Hóa đơn thanh toán
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handlePrint}
                  className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-bold text-white hover:bg-primary-dark transition-colors shadow-soft"
                >
                  <Printer size={15} /> In Hóa đơn
                </button>
                <button
                  onClick={() => setSelectedId(null)}
                  className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
                >
                  <X size={20} />
                </button>
              </div>
            </div>

            {/* Printable Invoice Document Body */}
            <div className="space-y-6 text-slate-800 text-sm">
              {/* Brand Header */}
              <div className="flex justify-between items-start border-b border-slate-200 pb-6">
                <div>
                  <h1 className="text-2xl font-black tracking-wide text-primary">NIPPON PET CARE</h1>
                  <p className="text-xs text-slate-500 font-semibold mt-0.5">
                    Bệnh viện Thú y & Khách sạn Thú cưng Nhật Bản
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    18 Phạm Hùng, Phường Mỹ Đình 2, Nam Từ Liêm, Hà Nội
                  </p>
                  <p className="text-xs text-slate-500">Hotline: 1900 6868 &bull; Website: niponeto.vn</p>
                </div>

                <div className="text-right">
                  <span className="inline-block rounded-xl bg-primary/10 border border-primary/20 px-3 py-1 text-xs font-extrabold text-primary mb-2">
                    HÓA ĐƠN DỊCH VỤ
                  </span>
                  <p className="break-words text-xs font-bold text-slate-900">{selectedInvoice.invoiceCode}</p>
                  <p className="text-xs text-slate-500">Ngày phát hành: {new Date(selectedInvoice.issuedAt).toLocaleDateString("vi-VN")}</p>
                </div>
              </div>

              {/* Customer & Pet Details */}
              <div className="grid gap-4 rounded-xl border border-slate-100 bg-slate-50 p-4 text-xs sm:grid-cols-2">
                <div>
                  <p className="font-bold uppercase tracking-wider text-slate-400 mb-1">Khách hàng / Chủ nuôi</p>
                  <p className="font-bold text-slate-900 text-sm">
                    {owners.find((o) => o.id === selectedInvoice.ownerId)?.fullName}
                  </p>
                  <p className="text-slate-600 mt-0.5">
                    SĐT: {owners.find((o) => o.id === selectedInvoice.ownerId)?.phone}
                  </p>
                  <p className="text-slate-600">
                    Địa chỉ: {owners.find((o) => o.id === selectedInvoice.ownerId)?.address}
                  </p>
                </div>

                <div>
                  <p className="font-bold uppercase tracking-wider text-slate-400 mb-1">Thông tin Thú cưng</p>
                  <p className="font-bold text-slate-900 text-sm">
                    {pets.find((p) => p.id === selectedInvoice.petId)?.name}
                  </p>
                  <p className="text-slate-600 mt-0.5">
                    Giống: {pets.find((p) => p.id === selectedInvoice.petId)?.breed} (
                    {pets.find((p) => p.id === selectedInvoice.petId)?.species === "dog" ? "Chó" : "Mèo"})
                  </p>
                  <p className="text-slate-600">
                    Microchip: {pets.find((p) => p.id === selectedInvoice.petId)?.microchipId ?? "Không có"}
                  </p>
                </div>
              </div>

              {/* Items Table */}
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100 font-bold uppercase text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3">Mô tả dịch vụ</th>
                      <th className="px-4 py-3 text-center">Số lượng</th>
                      <th className="px-4 py-3 text-right">Đơn giá</th>
                      <th className="px-4 py-3 text-right">Thành tiền</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selectedInvoice.items.map((item) => (
                      <tr key={item.id}>
                        <td className="px-4 py-3 font-semibold text-slate-800">{item.description}</td>
                        <td className="px-4 py-3 text-center">{item.quantity}</td>
                        <td className="px-4 py-3 text-right">{formatCurrency(item.unitPrice)}</td>
                        <td className="px-4 py-3 text-right font-bold">{formatCurrency(item.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Invoice Summary */}
              <div className="flex justify-end pt-2">
                <div className="w-64 space-y-2 text-xs">
                  <div className="flex justify-between text-slate-600">
                    <span>Tạm tính:</span>
                    <span className="font-semibold">{formatCurrency(selectedInvoice.subtotal)}</span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Tiền thuế:</span>
                    <span className="font-semibold">{formatCurrency(selectedInvoice.taxAmount)}</span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Giảm giá:</span>
                    <span>{formatCurrency(selectedInvoice.discountAmount)}</span>
                  </div>
                  <div className="flex justify-between text-slate-900 font-bold text-base pt-2 border-t border-slate-200">
                    <span>Tổng thanh toán:</span>
                    <span className="text-primary">{formatCurrency(selectedInvoice.totalAmount)}</span>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border p-3">
                <p>Trạng thái: <strong>{PAYMENT_STATUS_LABELS[selectedInvoice.paymentStatus]}</strong></p>
                {selectedInvoice.paymentMethod && <p>Phương thức: {PAYMENT_METHOD_LABELS[selectedInvoice.paymentMethod]}</p>}
                {selectedInvoice.paymentChannel === "bank_transfer" && <p>Nội dung chuyển: {selectedInvoice.transferContent}</p>}
                {selectedInvoice.paymentChannel === "bank_transfer" && selectedInvoice.bankTransferDetails?.isDemo && <p>Dữ liệu thanh toán minh họa.</p>}
                {selectedInvoice.transferReference && <p>Mã giao dịch khách báo: {selectedInvoice.transferReference}</p>}
                {selectedInvoice.paidAt && <p>Thời điểm thu tiền: {new Date(selectedInvoice.paidAt).toLocaleString("vi-VN")}</p>}
                {selectedInvoice.notes && <p>Ghi chú: {selectedInvoice.notes}</p>}
              </div>
              <section className="rounded-lg border p-3 print:hidden">
                <h3 className="font-semibold">Lịch sử kiểm tra thanh toán</h3>
                {historyError && <p role="alert" className="text-rose-700">{historyError}</p>}
                {!historyError && paymentEvents.length === 0 && <p className="text-sm text-slate-500">Chưa có sự kiện được ghi nhận. Hóa đơn cũ có thể không có lịch sử người xác nhận.</p>}
                <ol className="mt-2 space-y-2">{paymentEvents.map(event => <li key={event.id} className="border-t pt-2 text-sm">
                  <strong>{event.action === "payment_confirmed" ? "Đã xác nhận thu tiền" : event.action === "transfer_reported" ? "Khách báo đã chuyển khoản" : "Nhân viên yêu cầu kiểm tra lại"}</strong>
                  <p>{event.actorName} ({event.actorRole}) · {new Date(event.createdAt).toLocaleString("vi-VN")}</p>
                  {event.reference && <p>Mã khách báo: {event.reference}</p>}
                  {event.reason && <p>Lý do: {event.reason}</p>}
                </li>)}</ol>
              </section>

              {/* Signatures */}
              <div className="grid grid-cols-2 gap-8 pt-8 text-center text-xs">
                <div>
                  <p className="font-bold text-slate-900">Khách hàng / Chủ nuôi</p>
                  <p className="text-[11px] text-slate-400 italic mt-0.5">(Ký và ghi rõ họ tên)</p>
                  <div className="h-16" />
                </div>
                <div>
                  <p className="font-bold text-slate-900">Đại diện Bệnh viện Thú y</p>
                  <p className="text-[11px] text-slate-400 italic mt-0.5">(Ký và đóng dấu)</p>
                  <div className="h-16 flex items-center justify-center font-bold text-primary italic">
                    Nippon Pet Care
                  </div>
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-100 text-right print:hidden">
              <button
                onClick={() => setSelectedId(null)}
                className="rounded-xl bg-slate-900 px-5 py-2 text-sm font-bold text-white hover:bg-slate-800"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      , document.body)}
    </AdminLayout>
  );
}
