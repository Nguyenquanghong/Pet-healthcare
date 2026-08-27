import { useMemo, useState } from "react";
import {
  Printer,
  Receipt,
  Search,
  CheckCircle2,
  Clock,
  X,
  CreditCard,
  Building,
  FileText,
  Eye,
  Check,
} from "lucide-react";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { useAppStore } from "../../store/AppStoreProvider";
import type { Invoice, PaymentStatus } from "../../types/invoice";
import { formatCurrency } from "../../utils/formatCurrency";

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

export function AdminBillingPage() {
  const { appointments, hotelBookings, pets, owners } = useAppStore();

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [toastMsg, setToastMsg] = useState("");

  const toast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3500);
  };

  // Dynamically generate invoices from store appointments & hotel bookings
  const invoices = useMemo<Invoice[]>(() => {
    const list: Invoice[] = [];

    // Map appointments to invoices
    appointments.forEach((a, idx) => {
      const pet = pets.find((p) => p.id === a.petId);
      const isPaid = ["completed", "confirmed", "in_progress"].includes(a.status);
      const unitPrice = 250000;
      const subtotal = unitPrice;
      const taxAmount = Math.round(subtotal * 0.08);
      const totalAmount = subtotal + taxAmount;

      list.push({
        id: `inv_app_${a.id}`,
        invoiceCode: `INV-APP-2026-${String(idx + 1).padStart(3, "0")}`,
        type: "appointment",
        ownerId: a.ownerId,
        petId: a.petId,
        relatedId: a.id,
        items: [
          {
            id: `item_1_${a.id}`,
            description: `Dịch vụ khám: ${a.serviceName} (${pet?.name ?? "Thú cưng"})`,
            unitPrice,
            quantity: 1,
            amount: unitPrice,
          },
        ],
        subtotal,
        taxAmount,
        discountAmount: 0,
        totalAmount,
        paymentStatus: isPaid ? "paid" : "unpaid",
        paymentMethod: isPaid ? "credit_card" : undefined,
        issuedAt: a.createdAt || a.date,
        paidAt: isPaid ? a.createdAt || a.date : undefined,
        notes: a.ownerNote,
      });
    });

    // Map hotel bookings to invoices
    hotelBookings.forEach((b, idx) => {
      const pet = pets.find((p) => p.id === b.petId);
      const isPaid = ["checked_out", "in_stay"].includes(b.status);
      const subtotal = b.totalAmount;
      const taxAmount = Math.round(subtotal * 0.08);
      const totalAmount = subtotal + taxAmount;

      list.push({
        id: `inv_htl_${b.id}`,
        invoiceCode: `INV-HTL-2026-${String(idx + 1).padStart(3, "0")}`,
        type: "hotel_booking",
        ownerId: b.ownerId,
        petId: b.petId,
        relatedId: b.id,
        items: [
          {
            id: `item_htl_${b.id}`,
            description: `Phòng lưu trú ${b.roomType.toUpperCase()} (${b.nights} đêm) — Bé ${pet?.name ?? "Thú cưng"}`,
            unitPrice: Math.round(b.totalAmount / b.nights),
            quantity: b.nights,
            amount: b.totalAmount,
          },
        ],
        subtotal,
        taxAmount,
        discountAmount: 0,
        totalAmount,
        paymentStatus: isPaid ? "paid" : "unpaid",
        paymentMethod: isPaid ? "bank_transfer" : undefined,
        issuedAt: b.createdAt || b.checkIn,
        paidAt: isPaid ? b.createdAt || b.checkIn : undefined,
        notes: b.ownerNote,
      });
    });

    return list;
  }, [appointments, hotelBookings, pets]);

  const [localPaymentStatuses, setLocalPaymentStatuses] = useState<Record<string, PaymentStatus>>({});

  const filteredInvoices = useMemo(() => {
    return invoices.filter((inv) => {
      const currentStatus = localPaymentStatuses[inv.id] ?? inv.paymentStatus;
      if (statusFilter !== "all" && currentStatus !== statusFilter) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const pet = pets.find((p) => p.id === inv.petId);
        const owner = owners.find((o) => o.id === inv.ownerId);

        const matchCode = inv.invoiceCode.toLowerCase().includes(q);
        const matchOwner = owner?.fullName.toLowerCase().includes(q) || owner?.phone.includes(q);
        const matchPet = pet?.name.toLowerCase().includes(q);

        if (!matchCode && !matchOwner && !matchPet) return false;
      }
      return true;
    });
  }, [invoices, statusFilter, searchQuery, pets, owners, localPaymentStatuses]);

  const handleMarkAsPaid = (invId: string) => {
    setLocalPaymentStatuses((prev) => ({ ...prev, [invId]: "paid" }));
    toast("Đã chuyển trạng thái hóa đơn sang Đã thanh toán!");
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <AdminLayout title="Quản lý Hóa đơn & Thanh toán">
      {toastMsg && (
        <div className="mb-4 flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-5 py-4 text-emerald-800 font-semibold animate-fadeIn">
          <CheckCircle2 size={18} /> {toastMsg}
        </div>
      )}

      {/* Header Search & Controls */}
      <div className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Tìm theo mã hóa đơn, tên chủ nuôi, thú cưng..."
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
                <th className="px-5 py-4">Tổng tiền (gồm VAT)</th>
                <th className="px-5 py-4">Trạng thái</th>
                <th className="px-5 py-4 text-right">Hành động</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredInvoices.map((inv) => {
                const pet = pets.find((p) => p.id === inv.petId);
                const owner = owners.find((o) => o.id === inv.ownerId);
                const currentStatus = localPaymentStatuses[inv.id] ?? inv.paymentStatus;

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
                      {inv.issuedAt.slice(0, 10)}
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
                    </td>

                    <td className="px-5 py-4 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => setSelectedInvoice(inv)}
                          title="Xem / In hóa đơn"
                          className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 transition-colors"
                        >
                          <Printer size={14} className="text-primary" /> Xem / In
                        </button>

                        {currentStatus === "unpaid" && (
                          <button
                            onClick={() => handleMarkAsPaid(inv.id)}
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

              {filteredInvoices.length === 0 && (
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
      {selectedInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/60 p-4">
          <div className="my-8 w-full max-w-2xl animate-scaleUp rounded-lg border border-slate-200 bg-white p-8 shadow-lg print:max-w-none print:border-0 print:p-0 print:shadow-none">
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
                  onClick={() => setSelectedInvoice(null)}
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
                  <p className="text-sm font-bold text-slate-900">{selectedInvoice.invoiceCode}</p>
                  <p className="text-xs text-slate-500">Ngày phát hành: {selectedInvoice.issuedAt.slice(0, 10)}</p>
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
                    <span>Thuế GTGT (VAT 8%):</span>
                    <span className="font-semibold">{formatCurrency(selectedInvoice.taxAmount)}</span>
                  </div>
                  <div className="flex justify-between text-slate-900 font-bold text-base pt-2 border-t border-slate-200">
                    <span>Tổng thanh toán:</span>
                    <span className="text-primary">{formatCurrency(selectedInvoice.totalAmount)}</span>
                  </div>
                </div>
              </div>

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
                onClick={() => setSelectedInvoice(null)}
                className="rounded-xl bg-slate-900 px-5 py-2 text-sm font-bold text-white hover:bg-slate-800"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
