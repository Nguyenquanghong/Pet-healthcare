import { usePagedList } from "../../services/usePagedList";
import { Pagination } from "../../components/ui/Pagination";
import { BookingStatusDialog, type StatusDialogSelection } from "./BookingStatusDialog";
import { useBookingAction } from "./useBookingAction";
import { apiClient } from "../../services/apiClient";
import { useMemo, useState } from "react";
import {
  Bell,
  CheckCircle2,
  UserCheck,
  XCircle,
  Stethoscope,
  FilePlus2,
  Search,
  Calendar as CalendarIcon,
  StickyNote,
  UserX,
  X,
  Clock,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { useAppStore } from "../../store/AppStoreProvider";
import { isSpaAppointmentType, type Appointment, type AppointmentStatus } from "../../types/appointment";
import { appointmentStatusLabels } from "../../utils/statusLabels";
import { compareBookingStatus } from "../../utils/bookingOrder";
import { AdminCreateButton } from "./AdminCreateDialog";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  confirmed: "bg-blue-50 text-blue-700 border-blue-200",
  checked_in: "bg-indigo-50 text-indigo-700 border-indigo-200",
  in_progress: "bg-violet-50 text-violet-700 border-violet-200",
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  cancelled: "bg-rose-50 text-rose-700 border-rose-200",
  no_show: "bg-slate-100 text-slate-600 border-slate-300",
};

const ALL_STATUSES: { key: string; label: string }[] = [
  { key: "all", label: "Tất cả" },
  { key: "pending", label: "Chờ xác nhận" },
  { key: "confirmed", label: "Đã xác nhận" },
  { key: "checked_in", label: "Đã check-in" },
  { key: "in_progress", label: "Đang thực hiện" },
  { key: "completed", label: "Hoàn thành" },
  { key: "no_show", label: "Vắng mặt (No-show)" },
  { key: "cancelled", label: "Đã hủy" },
];

export function AdminAppointmentsPage() {
  const {
    userRole,
    sendReminder,
  } = useAppStore();

  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [serviceFilter, setServiceFilter] = useState<"all" | "medical" | "spa">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [dateFilter, setDateFilter] = useState<string>("all"); // 'all' | 'today' | custom date
  const [customDate, setCustomDate] = useState("");

  const [cancelModal, setCancelModal] = useState<Appointment | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const [internalNoteModal, setInternalNoteModal] = useState<Appointment | null>(null);
  const [internalNoteText, setInternalNoteText] = useState("");

  const [createRecordModal, setCreateRecordModal] = useState<Appointment | null>(null);
  const [recordTitle, setRecordTitle] = useState("");
  const [recordSymptoms, setRecordSymptoms] = useState("");
  const [recordDiagnosis, setRecordDiagnosis] = useState("");
  const [recordTreatment, setRecordTreatment] = useState("");
  const [recordMedications, setRecordMedications] = useState("");
  const [recordFollowUpDate, setRecordFollowUpDate] = useState("");
  const [recordWeight, setRecordWeight] = useState("");
  const [recordTemp, setRecordTemp] = useState("");
  const [recordHeartRate, setRecordHeartRate] = useState("");

  const [toastMsg, setToastMsg] = useState("");
  const [statusDialog, setStatusDialog] = useState<StatusDialogSelection | null>(null);
  const { run: runAction, error: actionError } = useBookingAction();

  const todayStr = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

  const toast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3500);
  };

  const list = usePagedList<Appointment>("/appointments", { q: searchQuery, status: filterStatus, category: serviceFilter, date: dateFilter === "today" ? todayStr : dateFilter === "custom" ? customDate : undefined });
  const appointments = list.items, filteredAppointments = appointments, pets = list.related.pets, owners = list.related.owners;

  const handleStatusUpdate = (id: string, status: AppointmentStatus) => {
    const booking = appointments.find(item => item.id === id);
    if (booking) setStatusDialog({ booking, intent: status, pet: pets.find(pet => pet.id === booking.petId), owner: owners.find(owner => owner.id === booking.ownerId) });
  };

  const handleConfirmCancel = () => {
    if (!cancelModal) return;
    void runAction(() => apiClient.patch(`/appointments/${cancelModal.id}/status`, { status: "cancelled", expectedRevision: cancelModal.statusRevision,
      internalNote: cancelReason ? `Lý do hủy: ${cancelReason}` : undefined }), () => {
      setCancelModal(null); setCancelReason(""); toast("Đã hủy lịch hẹn thành công.");
    });
  };

  const handleSaveInternalNote = () => {
    if (!internalNoteModal) return;
    void runAction(() => apiClient.patch(`/appointments/${internalNoteModal.id}/status`, { status: internalNoteModal.status,
      expectedRevision: internalNoteModal.statusRevision, internalNote: internalNoteText.trim() }), () => {
      setInternalNoteModal(null); setInternalNoteText(""); toast("Đã cập nhật ghi chú nội bộ.");
    });
  };

  const openCreateRecordForAppointment = (a: Appointment) => {
    const pet = pets.find((p) => p.id === a.petId);
    setCreateRecordModal(a);
    setRecordTitle(`Khám ${a.serviceName}`);
    setRecordSymptoms(a.ownerNote ? `Ghi chú từ khách: ${a.ownerNote}` : "");
    setRecordDiagnosis("");
    setRecordTreatment("");
    setRecordMedications("");
    setRecordFollowUpDate("");
    setRecordWeight(pet?.weightKg ? String(pet.weightKg) : "");
    setRecordTemp("38.5");
    setRecordHeartRate("90");
  };

  const handleSaveMedicalRecord = () => {
    if (!createRecordModal || !recordTitle || !recordDiagnosis || !recordTreatment) return;

    void runAction(() => apiClient.post("/medical-records", {
      petId: createRecordModal.petId,
      appointmentId: createRecordModal.id,
      doctorName: "Bs. Mai Nguyễn",
      visitDate: createRecordModal.date,
      title: recordTitle.trim(),
      symptoms: recordSymptoms.trim(),
      diagnosis: recordDiagnosis.trim(),
      treatment: recordTreatment.trim(),
      medications: recordMedications.trim(),
      followUpDate: recordFollowUpDate || undefined,
      weightKg: Number(recordWeight) || undefined,
      temperatureC: Number(recordTemp) || undefined,
      heartRateBpm: Number(recordHeartRate) || undefined,
    }), () => {
      setCreateRecordModal(null);
      toast("Đã tạo hồ sơ y tế thành công! Lịch khám đã chuyển sang Hoàn thành.");
    });
  };

  return (
    <AdminLayout title="Quản lý lịch hẹn">
      <Pagination {...list} />
      <div className="mb-4 flex justify-end">
        <AdminCreateButton kind="appointment" onCreated={() => { setFilterStatus("all"); setServiceFilter("all"); setSearchQuery(""); setDateFilter("all"); }} />
      </div>
      {actionError && <p role="alert" className="fixed right-4 top-20 z-[100] max-w-md rounded-xl border border-rose-300 bg-white p-4 text-rose-700 shadow-lg">{actionError}</p>}
      {statusDialog && <BookingStatusDialog kind="appointment" selection={statusDialog} onClose={() => setStatusDialog(null)} onSaved={() => toast("Đã lưu thao tác và lịch sử.")} />}
      {toastMsg && (
        <div className="mb-4 flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-5 py-4 text-emerald-800 font-semibold animate-fadeIn">
          <CheckCircle2 size={18} />
          {toastMsg}
        </div>
      )}

      {/* Header Search & Filters Bar */}
      <div className="mb-6 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          {/* Search box */}
          <div className="relative w-full flex-1 md:max-w-md">
            <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Tìm theo tên thú cưng, chủ nuôi, sđt, dịch vụ..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-white pl-10 pr-4 py-2.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary shadow-xs"
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

          {/* Quick Date Filters */}
          <div className="flex w-full items-center gap-2 overflow-x-auto pb-1 md:w-auto">
            <button
              onClick={() => {
                setDateFilter("all");
                setCustomDate("");
              }}
              className={`shrink-0 rounded-xl border px-3.5 py-2 text-xs font-bold transition-colors ${
                dateFilter === "all"
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
            >
              Tất cả ngày
            </button>
            <button
              onClick={() => {
                setDateFilter("today");
                setCustomDate("");
              }}
              className={`shrink-0 rounded-xl border px-3.5 py-2 text-xs font-bold transition-colors ${
                dateFilter === "today"
                  ? "bg-primary text-white border-primary"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
            >
              Hôm nay ({todayStr})
            </button>
            <input
              type="date"
              value={customDate}
              onChange={(e) => {
                setCustomDate(e.target.value);
                setDateFilter("custom");
              }}
              className="min-w-36 shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold focus:border-primary focus:outline-none"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4" aria-label="Lọc loại lịch hẹn">
          {([
            { key: "all", label: "Tất cả dịch vụ" },
            { key: "medical", label: "Khám & điều trị" },
            { key: "spa", label: "Spa & grooming" },
          ] as const).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setServiceFilter(item.key)}
              className={`rounded-md border px-4 py-2 text-sm font-semibold transition-colors ${serviceFilter === item.key ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* Status Tabs */}
        <div className="flex flex-wrap gap-2 pt-1 border-t border-slate-100">
          {ALL_STATUSES.map((s) => {
            const count =
              s.key === "all"
                ? Object.values(list.counts).reduce((sum, count) => sum + count, 0)
                : (list.counts[s.key] ?? 0);

            return (
              <button
                key={s.key}
                onClick={() => setFilterStatus(s.key)}
                className={`rounded-xl border px-3.5 py-2 text-xs font-bold transition-colors ${
                  filterStatus === s.key
                    ? "bg-primary text-white border-primary shadow-xs"
                    : "bg-white text-slate-600 border-slate-200 hover:border-primary/40"
                }`}
              >
                {s.label}
                <span className="ml-1.5 rounded-full bg-black/10 px-1.5 py-0.5 text-[10px]">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-[940px] w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase font-bold">
              <tr>
                <th className="px-5 py-4">Thời gian</th>
                <th className="px-5 py-4">Thú cưng & Chủ nhân</th>
                <th className="px-5 py-4">Dịch vụ</th>
                <th className="px-5 py-4">Trạng thái</th>
                <th className="px-5 py-4">Ghi chú</th>
                <th className="px-5 py-4 text-right">Hành động & Quy trình</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredAppointments.map((a) => {
                const pet = pets.find((p) => p.id === a.petId);
                const owner = owners.find((o) => o.id === a.ownerId);
                const isSpa = isSpaAppointmentType(a.type);

                return (
                  <tr key={a.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="px-5 py-4 whitespace-nowrap">
                      <p className="font-bold text-slate-900 flex items-center gap-1.5">
                        <CalendarIcon size={14} className="text-primary" /> {a.date}
                      </p>
                      <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                        <Clock size={12} /> {a.time}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">{a.createdBy === "staff" ? "Nhân viên tạo" : "Khách tự đặt"}</p>
                    </td>

                    <td className="px-5 py-4">
                      <p className="font-bold text-slate-900">{pet?.name ?? a.petId}</p>
                      <p className="text-xs text-slate-500">
                        {owner?.fullName ?? a.ownerId} &bull; {owner?.phone}
                      </p>
                    </td>

                    <td className="px-5 py-4">
                      <p className="font-semibold text-slate-800">{a.serviceName}</p>
                      <div className="mt-1 flex items-center gap-2">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${isSpa ? "bg-cyan-50 text-cyan-700" : "bg-slate-100 text-slate-600"}`}>{isSpa ? "SPA" : "Y TẾ"}</span>
                        <span className="text-xs text-slate-400">{a.clinicName}</span>
                      </div>
                    </td>

                    <td className="px-5 py-4 whitespace-nowrap">
                      <span
                        className={`inline-block rounded-lg border px-2.5 py-1 text-xs font-bold ${
                          STATUS_COLORS[a.status] ?? "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {appointmentStatusLabels[a.status] ?? a.status}
                      </span>
                    </td>

                    <td className="px-5 py-4 max-w-[200px]">
                      {a.ownerNote && (
                        <p className="text-xs text-slate-600 truncate" title={a.ownerNote}>
                          💬 Khách: {a.ownerNote}
                        </p>
                      )}
                      {a.internalNote && (
                        <p className="text-xs text-indigo-700 font-medium truncate" title={a.internalNote}>
                          📌 Nội bộ: {a.internalNote}
                        </p>
                      )}
                      {!a.ownerNote && !a.internalNote && (
                        <span className="text-xs text-slate-300">—</span>
                      )}
                    </td>

                    <td className="px-5 py-4 text-right">
                      <div className="flex items-center justify-end flex-wrap gap-1.5">
                        {/* Internal note button */}
                        <button
                          onClick={() => {
                            setInternalNoteModal(a);
                            setInternalNoteText(a.internalNote ?? "");
                          }}
                          title="Ghi chú nội bộ"
                          className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors"
                        >
                          <StickyNote size={14} />
                        </button>

                        <button onClick={() => setStatusDialog({ booking: a, intent: "history", pet: pets.find(pet => pet.id === a.petId), owner: owners.find(owner => owner.id === a.ownerId) })} className="rounded-lg border px-2 py-1.5 text-xs">Lịch sử thao tác</button>
                        {(a.status === "checked_in" || (a.status === "completed" && userRole === "admin")) &&
                          <button onClick={() => setStatusDialog({ booking: a, intent: "undo", pet: pets.find(pet => pet.id === a.petId), owner: owners.find(owner => owner.id === a.ownerId) })} className="rounded-lg border border-amber-300 px-2 py-1.5 text-xs text-amber-800">{a.status === "checked_in" ? "Hoàn tác check-in" : "Mở lại dịch vụ"}</button>}
                        {/* Status workflow buttons */}
                        {a.status === "pending" && (
                          <button
                            onClick={() => handleStatusUpdate(a.id, "confirmed")}
                            className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-bold text-white hover:bg-primary-dark transition-colors"
                          >
                            <CheckCircle2 size={13} /> Xác nhận
                          </button>
                        )}

                        {a.status === "confirmed" && (
                          <>
                            <button
                              onClick={() => handleStatusUpdate(a.id, "checked_in")}
                              className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-indigo-700 transition-colors"
                            >
                              <UserCheck size={13} /> Check-in
                            </button>
                            <button
                              onClick={() => sendReminder(a.id)}
                              title="Gửi nhắc nhở"
                              className="rounded-lg bg-blue-500 p-2 text-white hover:bg-blue-600 transition-colors"
                            >
                              <Bell size={14} />
                            </button>
                            <button
                              onClick={() => handleStatusUpdate(a.id, "no_show")}
                              title="Đánh dấu vắng mặt"
                              className="rounded-lg bg-slate-200 p-2 text-slate-700 hover:bg-slate-300 transition-colors"
                            >
                              <UserX size={14} />
                            </button>
                          </>
                        )}

                        {a.status === "checked_in" && (
                          <button
                            onClick={() => handleStatusUpdate(a.id, "in_progress")}
                            className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-violet-700 transition-colors"
                          >
                            {isSpa ? <Sparkles size={13} /> : <Stethoscope size={13} />} {isSpa ? "Bắt đầu Spa" : "Bắt đầu khám"}
                          </button>
                        )}

                        {!isSpa && (a.status === "in_progress" || a.status === "checked_in") && (
                          <button
                            onClick={() => openCreateRecordForAppointment(a)}
                            className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 transition-colors shadow-xs"
                          >
                            <FilePlus2 size={13} /> Tạo bệnh án
                          </button>
                        )}

                        {a.status === "in_progress" && (
                          <button
                            onClick={() => handleStatusUpdate(a.id, "completed")}
                            className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-emerald-800 transition-colors"
                          >
                            <CheckCircle2 size={13} /> Hoàn thành
                          </button>
                        )}

                        {["pending", "confirmed"].includes(a.status) && (
                          <button
                            onClick={() => {
                              setCancelModal(a);
                              setCancelReason("");
                            }}
                            title="Hủy lịch"
                            className="rounded-lg bg-rose-500 p-2 text-white hover:bg-rose-600 transition-colors"
                          >
                            <XCircle size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}

              {filteredAppointments.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-400">
                    Không tìm thấy lịch hẹn phù hợp.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Internal Note Modal */}
      {internalNoteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md animate-scaleUp rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <StickyNote size={18} className="text-primary" />
                Ghi chú nội bộ lịch hẹn
              </h3>
              <button
                onClick={() => setInternalNoteModal(null)}
                className="text-slate-400 hover:text-slate-600 rounded-lg p-1"
              >
                <X size={18} />
              </button>
            </div>
            <div className="my-4 space-y-3">
              <p className="text-xs text-slate-500">
                Ghi chú này chỉ hiển thị cho Bác sĩ và nhân viên phòng khám.
              </p>
              <textarea
                className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary min-h-28"
                placeholder="Nhập dặn dò bác sĩ, tiền sử bệnh án, lưu ý tiếp đón..."
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

      {/* Cancel Confirmation Modal */}
      {cancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md animate-scaleUp rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-lg font-bold text-rose-600 flex items-center gap-2">
                <XCircle size={20} />
                Hủy lịch hẹn
              </h3>
              <button
                onClick={() => setCancelModal(null)}
                className="text-slate-400 hover:text-slate-600 rounded-lg p-1"
              >
                <X size={18} />
              </button>
            </div>

            <div className="my-4 space-y-3 text-sm">
              <p className="text-slate-600">
                Nhập lý do hủy cho lịch <strong>{cancelModal.serviceName}</strong> ngày{" "}
                <strong>{cancelModal.date}</strong>:
              </p>
              <textarea
                className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm focus:border-primary focus:outline-none min-h-24"
                placeholder="Lý do hủy (bác sĩ bận, trùng lịch, khách xin hủy...)"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setCancelModal(null)}
                className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50"
              >
                Quay lại
              </button>
              <button
                onClick={handleConfirmCancel}
                className="flex-1 rounded-xl bg-rose-600 py-2.5 text-sm font-bold text-white hover:bg-rose-700"
              >
                Xác nhận hủy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Medical Record Modal linked to Appointment */}
      {createRecordModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 p-4">
          <div className="my-8 max-h-[90vh] w-full max-w-2xl animate-scaleUp overflow-y-auto rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
            <div className="flex items-center justify-between pb-4 border-b border-slate-100">
              <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                <FilePlus2 size={22} className="text-primary" />
                Tạo bệnh án từ lịch khám
              </h3>
              <button
                onClick={() => setCreateRecordModal(null)}
                className="text-slate-400 hover:text-slate-600 rounded-lg p-1"
              >
                <X size={20} />
              </button>
            </div>

            <div className="my-4 space-y-4">
              <div className="rounded-xl bg-blue-50 border border-blue-200 p-3.5 text-xs text-blue-900 space-y-1">
                <p>
                  <strong>Thú cưng:</strong> {pets.find((p) => p.id === createRecordModal.petId)?.name} (
                  {pets.find((p) => p.id === createRecordModal.petId)?.breed})
                </p>
                <p>
                  <strong>Lịch khám:</strong> {createRecordModal.serviceName} lúc {createRecordModal.time} ngày{" "}
                  {createRecordModal.date}
                </p>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">
                  Tiêu đề hồ sơ *
                </label>
                <input
                  className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                  value={recordTitle}
                  onChange={(e) => setRecordTitle(e.target.value)}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Triệu chứng
                  </label>
                  <textarea
                    className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:border-primary focus:outline-none min-h-20"
                    value={recordSymptoms}
                    onChange={(e) => setRecordSymptoms(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Chẩn đoán *
                  </label>
                  <textarea
                    className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:border-primary focus:outline-none min-h-20"
                    value={recordDiagnosis}
                    onChange={(e) => setRecordDiagnosis(e.target.value)}
                    placeholder="Nhập chẩn đoán y khoa..."
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Hướng điều trị *
                  </label>
                  <textarea
                    className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:border-primary focus:outline-none min-h-20"
                    value={recordTreatment}
                    onChange={(e) => setRecordTreatment(e.target.value)}
                    placeholder="Phương pháp điều trị..."
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Thuốc kê đơn
                  </label>
                  <textarea
                    className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:border-primary focus:outline-none min-h-20"
                    value={recordMedications}
                    onChange={(e) => setRecordMedications(e.target.value)}
                    placeholder="Ví dụ: Amoxicillin 250mg 2 lần/ngày..."
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Cân nặng (kg)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-primary focus:outline-none"
                    value={recordWeight}
                    onChange={(e) => setRecordWeight(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Nhiệt độ (°C)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-primary focus:outline-none"
                    value={recordTemp}
                    onChange={(e) => setRecordTemp(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Nhịp tim (bpm)
                  </label>
                  <input
                    type="number"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-primary focus:outline-none"
                    value={recordHeartRate}
                    onChange={(e) => setRecordHeartRate(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">
                  Ngày tái khám (tùy chọn)
                </label>
                <input
                  type="date"
                  className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                  value={recordFollowUpDate}
                  onChange={(e) => setRecordFollowUpDate(e.target.value)}
                />
              </div>
            </div>

            <div className="pt-4 border-t border-slate-100 flex gap-3 justify-end">
              <button
                onClick={() => setCreateRecordModal(null)}
                className="rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50"
              >
                Hủy
              </button>
              <button
                onClick={handleSaveMedicalRecord}
                disabled={!recordTitle || !recordDiagnosis || !recordTreatment}
                className="rounded-xl bg-primary px-6 py-2.5 text-sm font-bold text-white hover:bg-primary-dark disabled:opacity-50 transition-colors shadow-soft"
              >
                Lưu bệnh án & Hoàn thành lịch
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
