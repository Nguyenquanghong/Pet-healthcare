import { useState } from "react";
import { CheckCircle2, LogIn, LogOut, MessageSquarePlus, XCircle } from "lucide-react";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { useAppStore } from "../../store/AppStoreProvider";
import { formatCurrency } from "../../utils/formatCurrency";
import { bookingStatusLabels } from "../../utils/statusLabels";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  confirmed: "bg-blue-50 text-blue-700 border-blue-200",
  in_stay: "bg-indigo-50 text-indigo-700 border-indigo-200",
  checked_in: "bg-indigo-50 text-indigo-700 border-indigo-200",
  checked_out: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-rose-50 text-rose-700 border-rose-200",
  cancelled: "bg-slate-100 text-slate-500 border-slate-200",
};

const TABS = ["all", "pending", "confirmed", "in_stay", "checked_out"] as const;
type TabKey = (typeof TABS)[number];

export function AdminHotelBookingsPage() {
  const { hotelBookings, owners, pets, updateHotelBookingStatus, addDailyCareNote } = useAppStore();
  const [tab, setTab] = useState<TabKey>("all");
  const [dailyNoteModal, setDailyNoteModal] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  const filtered = tab === "all" ? hotelBookings : hotelBookings.filter(b => b.status === tab);

  const toast = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(""), 3000);
  };

  const handleStatus = (id: string, status: "confirmed" | "rejected" | "in_stay" | "checked_out") => {
    updateHotelBookingStatus(id, status);
    toast(`Đã cập nhật: ${bookingStatusLabels[status] ?? status}`);
  };

  const handleDailyNote = () => {
    if (!dailyNoteModal || !noteText.trim()) return;
    addDailyCareNote(dailyNoteModal, noteText.trim());
    setDailyNoteModal(null);
    setNoteText("");
    toast("Đã gửi cập nhật tình trạng thú cưng đến chủ nhân.");
  };

  const tabLabel: Record<TabKey, string> = {
    all: "Tất cả",
    pending: "Chờ xác nhận",
    confirmed: "Đã xác nhận",
    in_stay: "Đang lưu trú",
    checked_out: "Hoàn thành",
  };

  return (
    <AdminLayout title="Quản lý Hotel Bookings">
      {successMsg && (
        <div className="mb-4 flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-5 py-4 text-emerald-800 font-semibold">
          <CheckCircle2 size={18} />
          {successMsg}
        </div>
      )}

      {/* Tabs */}
      <div className="mb-6 flex flex-wrap gap-2">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-xl border px-4 py-2 text-sm font-semibold transition-colors ${
              tab === t
                ? "bg-primary text-white border-primary"
                : "bg-white text-slate-600 border-slate-200 hover:border-primary hover:text-primary"
            }`}
          >
            {tabLabel[t]}
            {t !== "all" && (
              <span className="ml-2 rounded-full bg-black/10 px-1.5 py-0.5 text-xs">
                {hotelBookings.filter(b => b.status === t || (t === "in_stay" && b.status === "in_stay")).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Cards grid */}
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map(b => {
          const pet = pets.find(p => p.id === b.petId);
          const owner = owners.find(o => o.id === b.ownerId);
          return (
            <div key={b.id} className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden hover:shadow-md transition-shadow">
              <div className="p-5">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900">{pet?.name ?? b.petId}</h3>
                    <p className="text-sm text-slate-500">{owner?.fullName} · {pet?.breed}</p>
                  </div>
                  <span className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${STATUS_COLORS[b.status]}`}>
                    {bookingStatusLabels[b.status]}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm mb-4">
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-400 mb-0.5">Check-in</p>
                    <p className="font-bold text-slate-800">{b.checkIn}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-400 mb-0.5">Check-out</p>
                    <p className="font-bold text-slate-800">{b.checkOut}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-400 mb-0.5">Phòng</p>
                    <p className="font-bold text-slate-800 capitalize">{b.roomType}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-xs text-slate-400 mb-0.5">Tổng tiền</p>
                    <p className="font-bold text-primary">{formatCurrency(b.totalAmount)}</p>
                  </div>
                </div>

                {b.ownerNote && (
                  <div className="mb-4 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                    <span className="font-bold">Ghi chú: </span>{b.ownerNote}
                  </div>
                )}

                {b.dailyCareNoteIds.length > 0 && (
                  <p className="mb-3 text-xs text-slate-500 font-medium">
                    📝 {b.dailyCareNoteIds.length} cập nhật chăm sóc đã gửi
                  </p>
                )}
              </div>

              <div className="border-t border-slate-100 bg-slate-50 px-5 py-3 flex flex-wrap gap-2">
                {b.status === "pending" && (
                  <>
                    <button onClick={() => handleStatus(b.id, "confirmed")} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-white hover:bg-primary-dark transition-colors">
                      <CheckCircle2 size={14} /> Xác nhận
                    </button>
                    <button onClick={() => handleStatus(b.id, "rejected")} className="flex items-center gap-1.5 rounded-lg bg-rose-500 px-3 py-2 text-xs font-bold text-white hover:bg-rose-600 transition-colors">
                      <XCircle size={14} /> Từ chối
                    </button>
                  </>
                )}
                {b.status === "confirmed" && (
                  <button onClick={() => handleStatus(b.id, "in_stay")} className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-bold text-white hover:bg-indigo-700 transition-colors">
                    <LogIn size={14} /> Check-in pet
                  </button>
                )}
                {b.status === "in_stay" && (
                  <>
                    <button onClick={() => { setDailyNoteModal(b.id); setNoteText(""); }} className="flex items-center gap-1.5 rounded-lg bg-blue-500 px-3 py-2 text-xs font-bold text-white hover:bg-blue-600 transition-colors">
                      <MessageSquarePlus size={14} /> Cập nhật hàng ngày
                    </button>
                    <button onClick={() => handleStatus(b.id, "checked_out")} className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-700 transition-colors">
                      <LogOut size={14} /> Check-out
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="col-span-full py-16 text-center text-slate-400">
            Không có booking nào.
          </div>
        )}
      </div>

      {/* Daily Note Modal */}
      {dailyNoteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900 mb-2">Cập nhật chăm sóc hàng ngày</h3>
            <p className="text-sm text-slate-500 mb-4">Nội dung sẽ được gửi thông báo đến chủ thú cưng.</p>
            <textarea
              className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary min-h-28"
              placeholder="Ví dụ: Bé Mochi hôm nay ăn ngon, chạy nhảy vui vẻ. Đã tắm và vệ sinh sạch sẽ..."
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
            />
            <div className="mt-4 flex gap-3">
              <button onClick={() => setDailyNoteModal(null)} className="flex-1 rounded-xl border border-slate-200 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 transition-colors">
                Hủy
              </button>
              <button onClick={handleDailyNote} disabled={!noteText.trim()} className="flex-1 rounded-xl bg-primary py-3 text-sm font-bold text-white hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                Gửi cập nhật
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}