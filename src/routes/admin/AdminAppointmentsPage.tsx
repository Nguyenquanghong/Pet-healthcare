import { useState } from "react";
import { Bell, CheckCircle2, UserCheck, XCircle } from "lucide-react";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { useAppStore } from "../../store/AppStoreProvider";
import { appointmentStatusLabels } from "../../utils/statusLabels";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  confirmed: "bg-blue-50 text-blue-700 border-blue-200",
  checked_in: "bg-indigo-50 text-indigo-700 border-indigo-200",
  in_progress: "bg-violet-50 text-violet-700 border-violet-200",
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  cancelled: "bg-rose-50 text-rose-700 border-rose-200",
};

export function AdminAppointmentsPage() {
  const { appointments, owners, pets, updateAppointmentStatus, sendReminder } = useAppStore();
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [noteModal, setNoteModal] = useState<{ id: string; action: "cancel" } | null>(null);
  const [noteText, setNoteText] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  const filtered = filterStatus === "all" ? appointments : appointments.filter(a => a.status === filterStatus);

  const toast = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(""), 3000);
  };

  const handleAction = (id: string, status: "confirmed" | "checked_in" | "completed") => {
    updateAppointmentStatus(id, status);
    toast(`Đã cập nhật trạng thái: ${appointmentStatusLabels[status]}`);
  };

  const handleCancel = () => {
    if (!noteModal) return;
    updateAppointmentStatus(noteModal.id, "cancelled", noteText);
    setNoteModal(null);
    setNoteText("");
    toast("Đã hủy lịch khám.");
  };

  const handleReminder = (id: string) => {
    sendReminder(id);
    toast("Đã gửi nhắc lịch đến chủ thú cưng.");
  };

  return (
    <AdminLayout title="Quản lý lịch khám">
      {successMsg && (
        <div className="mb-4 flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-5 py-4 text-emerald-800 font-semibold">
          <CheckCircle2 size={18} />
          {successMsg}
        </div>
      )}

      {/* Filter */}
      <div className="mb-6 flex flex-wrap gap-2">
        {["all", "pending", "confirmed", "checked_in", "completed", "cancelled"].map(s => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`rounded-xl border px-4 py-2 text-sm font-semibold transition-colors ${
              filterStatus === s
                ? "bg-primary text-white border-primary"
                : "bg-white text-slate-600 border-slate-200 hover:border-primary hover:text-primary"
            }`}
          >
            {s === "all" ? "Tất cả" : appointmentStatusLabels[s as keyof typeof appointmentStatusLabels] ?? s}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase font-bold">
              <tr>
                <th className="px-6 py-4">Thời gian</th>
                <th className="px-6 py-4">Thú cưng</th>
                <th className="px-6 py-4">Chủ nhân</th>
                <th className="px-6 py-4">Dịch vụ</th>
                <th className="px-6 py-4">Trạng thái</th>
                <th className="px-6 py-4">Ghi chú</th>
                <th className="px-6 py-4">Hành động</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(a => {
                const pet = pets.find(p => p.id === a.petId);
                const owner = owners.find(o => o.id === a.ownerId);
                return (
                  <tr key={a.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-6 py-4">
                      <p className="font-bold text-slate-900">{a.date}</p>
                      <p className="text-slate-500">{a.time}</p>
                    </td>
                    <td className="px-6 py-4">
                      <p className="font-semibold text-slate-900">{pet?.name ?? a.petId}</p>
                      <p className="text-xs text-slate-400">{pet?.breed}</p>
                    </td>
                    <td className="px-6 py-4 text-slate-700">{owner?.fullName ?? a.ownerId}</td>
                    <td className="px-6 py-4 text-slate-700">{a.serviceName}</td>
                    <td className="px-6 py-4">
                      <span className={`inline-block rounded-lg border px-2.5 py-1 text-xs font-bold ${STATUS_COLORS[a.status] ?? "bg-slate-100 text-slate-600"}`}>
                        {appointmentStatusLabels[a.status]}
                      </span>
                    </td>
                    <td className="px-6 py-4 max-w-[150px]">
                      <p className="text-xs text-slate-500 truncate">{a.ownerNote ?? a.internalNote ?? "—"}</p>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          disabled={a.status !== "pending"}
                          onClick={() => handleAction(a.id, "confirmed")}
                          title="Xác nhận"
                          className="rounded-lg bg-primary p-2 text-white hover:bg-primary-dark disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          <CheckCircle2 size={14} />
                        </button>
                        <button
                          disabled={a.status !== "confirmed"}
                          onClick={() => handleAction(a.id, "checked_in")}
                          title="Check-in"
                          className="rounded-lg bg-amber-500 p-2 text-white hover:bg-amber-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          <UserCheck size={14} />
                        </button>
                        <button
                          disabled={!["checked_in", "in_progress"].includes(a.status)}
                          onClick={() => handleAction(a.id, "completed")}
                          title="Hoàn thành"
                          className="rounded-lg bg-emerald-600 p-2 text-white hover:bg-emerald-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          <CheckCircle2 size={14} />
                        </button>
                        <button
                          disabled={["pending", "confirmed"].indexOf(a.status) === -1}
                          onClick={() => handleReminder(a.id)}
                          title="Gửi nhắc lịch"
                          className="rounded-lg bg-blue-500 p-2 text-white hover:bg-blue-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          <Bell size={14} />
                        </button>
                        <button
                          disabled={["completed", "cancelled"].includes(a.status)}
                          onClick={() => setNoteModal({ id: a.id, action: "cancel" })}
                          title="Hủy lịch"
                          className="rounded-lg bg-rose-500 p-2 text-white hover:bg-rose-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          <XCircle size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="px-6 py-12 text-center text-slate-400">Không có dữ liệu.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Cancel Modal */}
      {noteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-900 mb-2">Hủy lịch khám</h3>
            <p className="text-sm text-slate-500 mb-4">Vui lòng nhập lý do hủy để thông báo đến chủ thú cưng.</p>
            <textarea
              className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary min-h-24"
              placeholder="Lý do hủy lịch..."
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
            />
            <div className="mt-4 flex gap-3">
              <button
                onClick={() => setNoteModal(null)}
                className="flex-1 rounded-xl border border-slate-200 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 transition-colors"
              >
                Quay lại
              </button>
              <button
                onClick={handleCancel}
                className="flex-1 rounded-xl bg-rose-500 py-3 text-sm font-bold text-white hover:bg-rose-600 transition-colors"
              >
                Xác nhận hủy
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
