import { BookingStatusDialog, type StatusDialogSelection } from "./BookingStatusDialog";
import { useBookingAction } from "./useBookingAction";
import { apiClient } from "../../services/apiClient";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  CheckCircle2,
  LogIn,
  LogOut,
  MessageSquarePlus,
  XCircle,
  X,
  Search,
  History,
  StickyNote,
  HeartPulse,
  Smile,
  BedDouble,
} from "lucide-react";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { useAppStore } from "../../store/AppStoreProvider";
import type { DailyCareNote, HotelBooking, HotelBookingStatus } from "../../types/booking";
import type { Invoice } from "../../types/invoice";
import { formatCurrency } from "../../utils/formatCurrency";
import { bookingStatusLabels, eatingStatusLabels, moodLabels } from "../../utils/statusLabels";
import { compareBookingStatus } from "../../utils/bookingOrder";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  confirmed: "bg-blue-50 text-blue-700 border-blue-200",
  in_stay: "bg-indigo-50 text-indigo-700 border-indigo-200",
  checked_out: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-rose-50 text-rose-700 border-rose-200",
  cancelled: "bg-slate-100 text-slate-500 border-slate-200",
};

const TABS = ["all", "pending", "confirmed", "in_stay", "checked_out", "rejected", "cancelled"] as const;
type TabKey = (typeof TABS)[number];

export function AdminHotelBookingsPage() {
  const {
    hotelBookings,
    dailyCareNotes,
    owners,
    pets,
    userRole,
  } = useAppStore();

  const [tab, setTab] = useState<TabKey>("all");
  const [roomTypeFilter, setRoomTypeFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Modals
  const [dailyNoteModal, setDailyNoteModal] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [eatingStatus, setEatingStatus] = useState<"good" | "normal" | "poor">("good");
  const [mood, setMood] = useState<"happy" | "calm" | "anxious" | "tired">("happy");

  const [rejectModal, setRejectModal] = useState<HotelBooking | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const [careHistoryModal, setCareHistoryModal] = useState<HotelBooking | null>(null);

  const [internalNoteModal, setInternalNoteModal] = useState<HotelBooking | null>(null);
  const [internalNoteText, setInternalNoteText] = useState("");

  const [toastMsg, setToastMsg] = useState("");
  const [statusDialog, setStatusDialog] = useState<StatusDialogSelection | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoiceLoadError, setInvoiceLoadError] = useState("");
  const { run: runAction, error: actionError } = useBookingAction();
  useEffect(() => {
    let active = true;
    void apiClient.get<Invoice[]>("/invoices").then(items => { if (active) setInvoices(items); })
      .catch(reason => { if (active) setInvoiceLoadError(reason instanceof Error ? reason.message : "Không tải được hóa đơn."); });
    return () => { active = false; };
  }, []);

  const toast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3500);
  };

  const handleStatus = (id: string, status: HotelBookingStatus) => {
    const booking = hotelBookings.find(item => item.id === id);
    if (booking) setStatusDialog({ booking, intent: status });
  };

  const handleConfirmReject = () => {
    if (!rejectModal) return;
    void runAction(() => apiClient.patch(`/hotel-bookings/${rejectModal.id}/status`, { status: "rejected", expectedRevision: rejectModal.statusRevision,
      internalNote: rejectReason ? `Lý do từ chối: ${rejectReason}` : undefined }), () => {
      setRejectModal(null); setRejectReason(""); toast("Đã từ chối booking.");
    });
  };

  const handleDailyNote = () => {
    if (!dailyNoteModal || !noteText.trim()) return;
    void runAction(() => apiClient.post(`/hotel-bookings/${dailyNoteModal}/care-notes`, { note: noteText.trim(), eatingStatus, mood }), () => {
      setDailyNoteModal(null); setNoteText(""); setEatingStatus("good"); setMood("happy");
      toast("Đã gửi cập nhật tình trạng chăm sóc hàng ngày.");
    });
  };

  const handleSaveInternalNote = () => {
    if (!internalNoteModal) return;
    void runAction(() => apiClient.patch(`/hotel-bookings/${internalNoteModal.id}/status`, { status: internalNoteModal.status,
      expectedRevision: internalNoteModal.statusRevision, internalNote: internalNoteText.trim() }), () => {
      setInternalNoteModal(null); setInternalNoteText(""); toast("Đã lưu ghi chú nội bộ.");
    });
  };

  const filteredBookings = useMemo(() => {
    return hotelBookings.filter((b) => {
      // Tab filter
      if (tab !== "all" && b.status !== tab) return false;

      // Room type filter
      if (roomTypeFilter !== "all" && b.roomType !== roomTypeFilter) return false;

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const pet = pets.find((p) => p.id === b.petId);
        const owner = owners.find((o) => o.id === b.ownerId);

        const matchPet = pet?.name.toLowerCase().includes(q) || pet?.breed.toLowerCase().includes(q);
        const matchOwner = owner?.fullName.toLowerCase().includes(q) || owner?.phone.includes(q);
        const matchRoom = b.roomType.toLowerCase().includes(q);
        const matchDates = b.checkIn.includes(q) || b.checkOut.includes(q);

        if (!matchPet && !matchOwner && !matchRoom && !matchDates) return false;
      }

      return true;
    }).sort(compareBookingStatus);
  }, [hotelBookings, tab, roomTypeFilter, searchQuery, pets, owners]);

  const tabLabel: Record<TabKey, string> = {
    all: "Tất cả",
    pending: "Chờ xác nhận",
    confirmed: "Đã xác nhận",
    in_stay: "Đang lưu trú",
    checked_out: "Hoàn thành",
    rejected: "Từ chối",
    cancelled: "Đã hủy",
  };

  return (
    <AdminLayout title="Quản lý Hotel Bookings">
      {actionError && <p role="alert" className="fixed right-4 top-20 z-[100] max-w-md rounded-xl border border-rose-300 bg-white p-4 text-rose-700 shadow-lg">{actionError}</p>}
      {invoiceLoadError && <p role="alert" className="mb-4 text-sm text-rose-700">{invoiceLoadError} Không thể xác định điều kiện check-out.</p>}
      {statusDialog && <BookingStatusDialog kind="hotel" selection={statusDialog} onClose={() => setStatusDialog(null)} onSaved={() => toast("Đã lưu thao tác và lịch sử.")} />}
      {toastMsg && (
        <div className="mb-4 flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-5 py-4 text-emerald-800 font-semibold animate-fadeIn">
          <CheckCircle2 size={18} />
          {toastMsg}
        </div>
      )}

      {/* Filter and Search controls */}
      <div className="mb-6 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="relative flex-1 max-w-md">
            <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Tìm theo thú cưng, chủ nuôi, sđt, phòng, ngày..."
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

          <div className="flex items-center gap-2">
            <label className="text-xs font-bold text-slate-500 uppercase">Loại phòng:</label>
            <select
              value={roomTypeFilter}
              onChange={(e) => setRoomTypeFilter(e.target.value)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold focus:border-primary focus:outline-none"
            >
              <option value="all">Tất cả phòng</option>
              <option value="standard">Standard</option>
              <option value="deluxe">Deluxe</option>
              <option value="vip">VIP</option>
            </select>
          </div>
        </div>

        {/* Status Tabs */}
        <div className="flex flex-wrap gap-2 pt-1 border-t border-slate-100">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-xl border px-3.5 py-2 text-xs font-bold transition-colors ${
                tab === t
                  ? "bg-primary text-white border-primary shadow-xs"
                  : "bg-white text-slate-600 border-slate-200 hover:border-primary/40"
              }`}
            >
              {tabLabel[t]}
              <span className="ml-1.5 rounded-full bg-black/10 px-1.5 py-0.5 text-[10px]">
                {t === "all" ? hotelBookings.length : hotelBookings.filter((b) => b.status === t).length}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Cards grid */}
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {filteredBookings.map((b) => {
          const pet = pets.find((p) => p.id === b.petId);
          const owner = owners.find((o) => o.id === b.ownerId);
          const relatedNotes = dailyCareNotes.filter((n) => n.bookingId === b.id);
          const invoice = invoices.find(item => item.hotelBookingId === b.id);

          return (
            <div
              key={b.id}
              data-testid={`hotel-booking-${b.id}`}
              className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden hover:shadow-md transition-shadow flex flex-col justify-between"
            >
              <div className="p-5">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 flex items-center gap-1.5">
                      <BedDouble size={18} className="text-primary" /> {pet?.name ?? b.petId}
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Chủ nuôi: <strong>{owner?.fullName}</strong> ({owner?.phone})
                    </p>
                  </div>
                  <span
                    className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${
                      STATUS_COLORS[b.status] ?? "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {bookingStatusLabels[b.status] ?? b.status}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2.5 text-xs mb-4">
                  <div className="rounded-xl bg-slate-50 p-2.5">
                    <p className="text-[11px] text-slate-400 mb-0.5 font-bold uppercase">Check-in</p>
                    <p className="font-bold text-slate-800">{b.checkIn}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-2.5">
                    <p className="text-[11px] text-slate-400 mb-0.5 font-bold uppercase">Check-out</p>
                    <p className="font-bold text-slate-800">{b.checkOut}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-2.5">
                    <p className="text-[11px] text-slate-400 mb-0.5 font-bold uppercase">Phòng ({b.nights} đêm)</p>
                    <p className="font-bold text-slate-800 capitalize">{b.roomType}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-2.5">
                    <p className="text-[11px] text-slate-400 mb-0.5 font-bold uppercase">Tổng tiền</p>
                    <p className="font-bold text-primary">{formatCurrency(b.totalAmount)}</p>
                  </div>
                </div>

                {b.ownerNote && (
                  <div className="mb-3 rounded-xl bg-amber-50 border border-amber-200 p-2.5 text-xs text-amber-900">
                    <span className="font-bold">💬 Dặn dò của chủ: </span>
                    {b.ownerNote}
                  </div>
                )}

                {b.internalNote && (
                  <div className="mb-3 rounded-xl bg-indigo-50 border border-indigo-200 p-2.5 text-xs text-indigo-900">
                    <span className="font-bold">📌 Ghi chú nội bộ: </span>
                    {b.internalNote}
                  </div>
                )}

                <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-100">
                  <span className="text-slate-500 font-medium">
                    📝 {relatedNotes.length} nhật ký chăm sóc
                  </span>
                  {relatedNotes.length > 0 && (
                    <button
                      onClick={() => setCareHistoryModal(b)}
                      className="text-primary font-bold hover:underline inline-flex items-center gap-1"
                    >
                      <History size={12} /> Xem lịch sử
                    </button>
                  )}
                </div>
              </div>

              {/* Action Buttons Footer */}
              <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 flex flex-wrap items-center justify-between gap-2">
                <button
                  onClick={() => {
                    setInternalNoteModal(b);
                    setInternalNoteText(b.internalNote ?? "");
                  }}
                  title="Ghi chú nội bộ"
                  className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-100 transition-colors"
                >
                  <StickyNote size={14} />
                </button>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button onClick={() => setStatusDialog({ booking: b, intent: "history" })} className="rounded-lg border px-2 py-1.5 text-xs">Lịch sử thao tác</button>
                  {(b.status === "in_stay" || (b.status === "checked_out" && userRole === "admin")) &&
                    <button onClick={() => setStatusDialog({ booking: b, intent: "undo" })} className="rounded-lg border border-amber-300 px-2 py-1.5 text-xs text-amber-800">{b.status === "in_stay" ? "Hoàn tác check-in" : "Hoàn tác trả thú cưng"}</button>}

                  {b.status === "pending" && (
                    <>
                      <button
                        onClick={() => handleStatus(b.id, "confirmed")}
                        className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-white hover:bg-primary-dark transition-colors"
                      >
                        <CheckCircle2 size={13} /> Xác nhận
                      </button>
                      <button
                        onClick={() => {
                          setRejectModal(b);
                          setRejectReason("");
                        }}
                        className="flex items-center gap-1 rounded-lg bg-rose-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-rose-600 transition-colors"
                      >
                        <XCircle size={13} /> Từ chối
                      </button>
                    </>
                  )}

                  {b.status === "confirmed" && (
                    <button
                      onClick={() => handleStatus(b.id, "in_stay")}
                      className="flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700 transition-colors shadow-xs"
                    >
                      <LogIn size={13} /> Check-in pet
                    </button>
                  )}

                  {b.status === "in_stay" && (
                    <>
                      <Link to={invoice ? "/admin/billing" : `/admin/billing?hotelBookingId=${encodeURIComponent(b.id)}`} className="rounded-lg border border-primary px-3 py-1.5 text-xs font-bold text-primary">{invoice ? "Xem hóa đơn" : "Chốt hóa đơn"}</Link>
                      <button
                        onClick={() => {
                          setDailyNoteModal(b.id);
                          setNoteText("");
                          setEatingStatus("good");
                          setMood("happy");
                        }}
                        className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-700 transition-colors"
                      >
                        <MessageSquarePlus size={13} /> Cập nhật nhật ký
                      </button>
                      <button
                        onClick={() => handleStatus(b.id, "checked_out")}
                        disabled={invoice?.paymentStatus !== "paid"}
                        title={invoice?.paymentStatus === "paid" ? "Xác nhận bàn giao thú cưng" : "Cần chốt hóa đơn và xác nhận đã thu đủ tiền"}
                        className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <LogOut size={13} /> {invoice?.paymentStatus === "paid" ? "Check-out" : "Chờ thanh toán"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {filteredBookings.length === 0 && (
          <div className="col-span-full py-16 text-center text-slate-400">
            Không tìm thấy hotel booking phù hợp.
          </div>
        )}
      </div>

      {/* Reject Modal */}
      {rejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md animate-scaleUp rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-lg font-bold text-rose-600 flex items-center gap-2">
                <XCircle size={20} />
                Từ chối hotel booking
              </h3>
              <button onClick={() => setRejectModal(null)} className="text-slate-400 hover:text-slate-600 p-1">
                <X size={18} />
              </button>
            </div>
            <div className="my-4 space-y-3 text-sm text-slate-600">
              <p>
                Nhập lý do từ chối yêu cầu lưu trú của thú cưng{" "}
                <strong>{pets.find((p) => p.id === rejectModal.petId)?.name}</strong>:
              </p>
              <textarea
                className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:border-primary focus:outline-none min-h-24"
                placeholder="Lý do từ chối (hết phòng, thú cưng chưa đạt điều kiện tiêm phòng...)"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setRejectModal(null)}
                className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50"
              >
                Hủy
              </button>
              <button
                onClick={handleConfirmReject}
                className="flex-1 rounded-xl bg-rose-600 py-2.5 text-sm font-bold text-white hover:bg-rose-700"
              >
                Xác nhận từ chối
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Daily Note Modal */}
      {dailyNoteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-lg animate-scaleUp rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                <MessageSquarePlus size={20} className="text-primary" />
                Cập nhật chăm sóc hàng ngày
              </h3>
              <button onClick={() => setDailyNoteModal(null)} className="text-slate-400 hover:text-slate-600 p-1">
                <X size={18} />
              </button>
            </div>

            <p className="text-xs text-slate-500 my-3">
              Thông tin nhật ký này sẽ được gửi tới chủ nuôi và lưu lại trong lịch sử chăm sóc.
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                  Tình trạng ăn uống
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(["good", "normal", "poor"] as const).map((status) => (
                    <button
                      key={status}
                      type="button"
                      onClick={() => setEatingStatus(status)}
                      className={`rounded-xl border px-3 py-2.5 text-xs font-bold transition-colors ${
                        eatingStatus === status
                          ? "bg-primary text-white border-primary shadow-xs"
                          : "bg-slate-50 text-slate-700 border-slate-200 hover:border-primary/40"
                      }`}
                    >
                      {eatingStatusLabels[status]}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                  Tâm trạng thú cưng
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {(["happy", "calm", "anxious", "tired"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMood(m)}
                      className={`rounded-xl border px-3 py-2 text-xs font-bold transition-colors text-left ${
                        mood === m
                          ? "bg-indigo-600 text-white border-indigo-600 shadow-xs"
                          : "bg-slate-50 text-slate-700 border-slate-200 hover:border-indigo-400"
                      }`}
                    >
                      {moodLabels[m]}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                  Ghi chú chi tiết *
                </label>
                <textarea
                  className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:border-primary focus:outline-none min-h-28"
                  placeholder="Ví dụ: Bé Mochi hôm nay ăn ngon miệng, đi dạo sân vườn 30 phút. Đã chải lông và vệ sinh sạch sẽ..."
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                />
              </div>
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setDailyNoteModal(null)}
                className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50"
              >
                Hủy
              </button>
              <button
                onClick={handleDailyNote}
                disabled={!noteText.trim()}
                className="flex-1 rounded-xl bg-primary py-2.5 text-sm font-bold text-white hover:bg-primary-dark disabled:opacity-50 transition-colors"
              >
                Gửi nhật ký chăm sóc
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Internal Note Modal */}
      {internalNoteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md animate-scaleUp rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <StickyNote size={18} className="text-primary" />
                Ghi chú nội bộ Hotel Booking
              </h3>
              <button
                onClick={() => setInternalNoteModal(null)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X size={18} />
              </button>
            </div>
            <div className="my-4 space-y-3">
              <p className="text-xs text-slate-500">Ghi chú này chỉ hiển thị cho nhân viên bệnh viện/khách sạn.</p>
              <textarea
                className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:border-primary focus:outline-none min-h-28"
                placeholder="Nhập ghi chú phòng, dị ứng thuốc, dặn dò điều dưỡng..."
                value={internalNoteText}
                onChange={(e) => setInternalNoteText(e.target.value)}
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setInternalNoteModal(null)}
                className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50"
              >
                Hủy
              </button>
              <button
                onClick={handleSaveInternalNote}
                className="flex-1 rounded-xl bg-primary py-2.5 text-sm font-bold text-white hover:bg-primary-dark"
              >
                Lưu ghi chú
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full Daily Care History Modal */}
      {careHistoryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 p-4">
          <div className="my-8 max-h-[90vh] w-full max-w-xl animate-scaleUp overflow-y-auto rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
            <div className="flex items-center justify-between pb-4 border-b border-slate-100">
              <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                <History size={22} className="text-indigo-600" />
                Lịch sử chăm sóc hàng ngày
              </h3>
              <button
                onClick={() => setCareHistoryModal(null)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X size={20} />
              </button>
            </div>

            <div className="my-4 space-y-3">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-100 text-xs text-slate-600">
                Thú cưng:{" "}
                <strong className="text-slate-900">
                  {pets.find((p) => p.id === careHistoryModal.petId)?.name}
                </strong>{" "}
                &bull; Phòng: <span className="capitalize">{careHistoryModal.roomType}</span> &bull; Đêm:{" "}
                {careHistoryModal.checkIn} &rarr; {careHistoryModal.checkOut}
              </div>

              {dailyCareNotes.filter((n) => n.bookingId === careHistoryModal.id).length === 0 ? (
                <p className="py-8 text-center text-slate-400 text-sm">Chưa có nhật ký nào cho booking này.</p>
              ) : (
                <div className="space-y-3">
                  {dailyCareNotes
                    .filter((n) => n.bookingId === careHistoryModal.id)
                    .map((note) => (
                      <div
                        key={note.id}
                        className="rounded-xl border border-indigo-100 bg-indigo-50/30 p-4 text-xs space-y-2"
                      >
                        <div className="flex items-center justify-between text-slate-500 font-medium">
                          <span className="font-bold text-slate-900">{note.date}</span>
                          <div className="flex gap-1.5">
                            <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 font-bold text-emerald-700 border border-emerald-200">
                              <HeartPulse size={10} /> {eatingStatusLabels[note.eatingStatus]}
                            </span>
                            <span className="inline-flex items-center gap-1 rounded bg-indigo-50 px-2 py-0.5 font-bold text-indigo-700 border border-indigo-200">
                              <Smile size={10} /> {moodLabels[note.mood]}
                            </span>
                          </div>
                        </div>
                        <p className="text-slate-700 text-sm leading-relaxed">{note.note}</p>
                      </div>
                    ))}
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-slate-100 text-right">
              <button
                onClick={() => setCareHistoryModal(null)}
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
