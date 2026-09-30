import { useMemo, useRef, useState } from "react";
import { Ban, CalendarClock, CheckCircle2, X } from "lucide-react";
import type { Appointment } from "../../../types/appointment";
import type { Pet } from "../../../types/pet";
import { appointmentStatusLabels } from "../../../utils/statusLabels";
import { compareBookingStatus } from "../../../utils/bookingOrder";
import { useAppStore } from "../../../store/AppStoreProvider";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Textarea } from "../../ui/Textarea";

type StatusTab = "all" | "pending" | "completed" | "cancelled";

const STATUS_VARIANTS: Record<string, "default" | "success" | "warning" | "danger" | "info"> = {
  pending: "warning",
  confirmed: "success",
  checked_in: "info",
  in_progress: "info",
  completed: "default",
  cancelled: "danger",
  no_show: "danger",
};

const STATUS_TABS: Array<{ key: StatusTab; label: string; description: string; countClass: string }> = [
  { key: "all", label: "Tất cả", description: "Toàn bộ lịch", countClass: "bg-slate-900 text-white" },
  { key: "pending", label: "Đang chờ", description: "Chờ xác nhận hoặc đang xử lý", countClass: "bg-amber-100 text-amber-800" },
  { key: "completed", label: "Đã hoàn thành", description: "Lịch hẹn đã hoàn tất", countClass: "bg-emerald-100 text-emerald-800" },
  { key: "cancelled", label: "Đã hủy", description: "Lịch đã hủy hoặc vắng mặt", countClass: "bg-rose-100 text-rose-800" },
];

interface OwnerAppointmentListProps {
  mode?: "medical" | "spa";
  appointments: Appointment[];
  pets: Pet[];
  selectedDate?: string;
  onClearDate?: () => void;
}

function getStatusTab(status: Appointment["status"]): Exclude<StatusTab, "all"> {
  if (status === "completed") return "completed";
  if (status === "cancelled" || status === "no_show") return "cancelled";
  return "pending";
}

export function OwnerAppointmentList({ mode = "medical", appointments, pets, selectedDate, onClearDate }: OwnerAppointmentListProps) {
  const { cancelAppointment, rescheduleAppointment } = useAppStore();
  const [activeTab, setActiveTab] = useState<StatusTab>("all");
  const [rescheduleItem, setRescheduleItem] = useState<Appointment | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [rescheduleTime, setRescheduleTime] = useState("");
  const [rescheduleNote, setRescheduleNote] = useState("");
  const [cancelItem, setCancelItem] = useState<Appointment | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [toastMsg, setToastMsg] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  const tabCounts = useMemo(() => {
    return appointments.reduce<Record<StatusTab, number>>(
      (acc, appointment) => {
        acc.all += 1;
        acc[getStatusTab(appointment.status)] += 1;
        return acc;
      },
      { all: 0, pending: 0, completed: 0, cancelled: 0 },
    );
  }, [appointments]);

  const visibleAppointments = useMemo(() => {
    return appointments.filter((appointment) => activeTab === "all" || getStatusTab(appointment.status) === activeTab)
      .sort(compareBookingStatus);
  }, [activeTab, appointments]);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    window.setTimeout(() => setToastMsg(""), 3500);
  };

  const openReschedule = (appointment: Appointment) => {
    setActionError("");
    setRescheduleItem(appointment);
    setRescheduleDate(appointment.date);
    setRescheduleTime(appointment.time);
    setRescheduleNote(appointment.ownerNote ?? "");
  };

  const handleConfirmReschedule = async () => {
    if (!rescheduleItem || !rescheduleDate || !rescheduleTime || submitting.current) return;
    submitting.current = true; setBusy(true); setActionError("");
    try {
      const refreshed = await rescheduleAppointment(rescheduleItem.id, {
        date: rescheduleDate, time: rescheduleTime, ownerNote: rescheduleNote.trim() || undefined,
      });
      setRescheduleItem(null);
      showToast(refreshed ? "Đã gửi yêu cầu đổi lịch và chờ xác nhận." : "Đã đổi lịch; danh sách chưa tải lại được. Hãy làm mới trang.");
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : "Không thể đổi lịch."); }
    finally { submitting.current = false; setBusy(false); }
  };

  const handleConfirmCancel = async () => {
    if (!cancelItem || submitting.current) return;
    submitting.current = true; setBusy(true); setActionError("");
    try {
      const refreshed = await cancelAppointment(cancelItem.id, cancelReason.trim() || undefined);
      setCancelItem(null); setCancelReason("");
      showToast(refreshed ? "Đã hủy lịch." : "Đã hủy lịch; danh sách chưa tải lại được. Hãy làm mới trang.");
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : "Không thể hủy lịch."); }
    finally { submitting.current = false; setBusy(false); }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-6 py-5">
        <div>
          <h2 className="text-xl font-bold text-slate-900">{mode === "spa" ? "Lịch Spa của bạn" : "Lịch khám của bạn"}</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            {selectedDate ? `${appointments.length} lịch hẹn vào ngày ${selectedDate}` : `${appointments.length} lịch hẹn`}
          </p>
        </div>
        {selectedDate && onClearDate && (
          <button
            type="button"
            onClick={onClearDate}
            className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 transition hover:border-primary/30 hover:text-primary"
          >
            Bỏ chọn ngày
          </button>
        )}
      </div>

      <div className="border-b border-slate-100 px-5 py-4">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {STATUS_TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`rounded-md border px-4 py-3 text-left transition-colors ${
                  isActive
                    ? "border-primary bg-primary/5"
                    : "border-slate-200 bg-white hover:border-primary/30 hover:bg-slate-50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-sm font-black ${isActive ? "text-primary" : "text-slate-900"}`}>{tab.label}</span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-black ${tab.countClass}`}>{tabCounts[tab.key]}</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">{tab.description}</p>
              </button>
            );
          })}
        </div>
      </div>

      {toastMsg && (
        <div className="mx-6 mt-4 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 animate-fadeIn">
          <CheckCircle2 size={16} />
          {toastMsg}
        </div>
      )}

      <div className="divide-y divide-slate-100">
        {visibleAppointments.map((appointment) => {
          const pet = pets.find((item) => item.id === appointment.petId);
          const canModify = ["pending", "confirmed"].includes(appointment.status);

          return (
            <div key={appointment.id} className="flex flex-col gap-4 px-6 py-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex flex-1 items-start gap-4">
                <div className="shrink-0 rounded-xl bg-primary/10 px-3 py-2 text-center">
                  <p className="text-xs font-bold text-primary">{appointment.date.slice(5).replace("-", "/")}</p>
                  <p className="text-sm font-black text-primary">{appointment.time}</p>
                </div>
                <div className="space-y-1">
                  <p className="font-bold text-slate-900">{appointment.serviceName}</p>
                  <p className="text-sm text-slate-500">
                    Cho <span className="font-semibold text-slate-700">{pet?.name ?? appointment.petId}</span> ({pet?.breed ?? "Thú cưng"})
                  </p>
                  {appointment.ownerNote && (
                    <p className="inline-block rounded-lg border border-slate-100 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-500">
                      Ghi chú: {appointment.ownerNote}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-2.5 sm:items-end">
                <Badge variant={STATUS_VARIANTS[appointment.status] ?? "default"}>
                  {appointmentStatusLabels[appointment.status]}
                </Badge>

                {canModify && (
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => openReschedule(appointment)}
                      className="inline-flex items-center gap-1 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/10 hover:text-primary-dark"
                      title={mode === "spa" ? "Đổi ngày hoặc giờ Spa" : "Đổi ngày hoặc giờ khám"}
                    >
                      <CalendarClock size={13} />
                      Đổi lịch
                    </button>
                    <button
                      type="button"
                      onClick={() => setCancelItem(appointment)}
                      className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-semibold text-rose-600 transition-colors hover:bg-rose-100 hover:text-rose-700"
                      title="Hủy lịch hẹn"
                    >
                      <Ban size={13} />
                      Hủy lịch
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {visibleAppointments.length === 0 && (
          <p className="px-6 py-12 text-center text-slate-400">
            {selectedDate ? "Không có lịch hẹn phù hợp trong ngày đã chọn." : "Không có lịch hẹn phù hợp."}
          </p>
        )}
      </div>

      {rescheduleItem && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4">
          <div className="max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto rounded-t-lg border border-slate-200 bg-white p-4 animate-scaleUp sm:rounded-lg sm:p-6">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <h3 className="flex items-center gap-2 text-lg font-bold text-slate-900">
                <CalendarClock size={20} className="text-primary" />
                Đổi lịch {mode === "spa" ? "Spa" : "khám"}
              </h3>
              <button type="button" onClick={() => setRescheduleItem(null)} className="rounded-lg p-1 text-slate-400 hover:text-slate-600">
                <X size={18} />
              </button>
            </div>

            <div className="my-4 space-y-4 text-sm">
              {actionError && <p role="alert" className="text-rose-700">{actionError}</p>}
              <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
                Dịch vụ: <span className="font-bold text-slate-900">{rescheduleItem.serviceName}</span>
                <br />
                Sau khi đổi lịch, lịch hẹn sẽ chuyển về trạng thái <strong>Chờ xác nhận</strong> để phòng khám kiểm tra.
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Input type="date" label="Ngày mới" value={rescheduleDate} onChange={(event) => setRescheduleDate(event.target.value)} />
                <Input type="time" label="Giờ mới" value={rescheduleTime} onChange={(event) => setRescheduleTime(event.target.value)} />
              </div>

              <Textarea
                label="Lý do đổi / Ghi chú bổ sung"
                placeholder="Ví dụ: Bận đột xuất vào buổi sáng, xin chuyển sang chiều..."
                value={rescheduleNote}
                onChange={(event) => setRescheduleNote(event.target.value)}
              />
            </div>

            <div className="flex gap-3 pt-2">
              <Button variant="outline" onClick={() => setRescheduleItem(null)} className="flex-1">
                Đóng
              </Button>
              <Button onClick={() => void handleConfirmReschedule()} disabled={busy || !rescheduleDate || !rescheduleTime} className="flex-1">
                Xác nhận đổi
              </Button>
            </div>
          </div>
        </div>
      )}

      {cancelItem && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4">
          <div className="max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto rounded-t-lg border border-slate-200 bg-white p-4 animate-scaleUp sm:rounded-lg sm:p-6">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <h3 className="flex items-center gap-2 text-lg font-bold text-rose-600">
                <Ban size={20} />
                Xác nhận hủy lịch {mode === "spa" ? "Spa" : "khám"}
              </h3>
              <button type="button" onClick={() => setCancelItem(null)} className="rounded-lg p-1 text-slate-400 hover:text-slate-600">
                <X size={18} />
              </button>
            </div>

            <div className="my-4 space-y-4 text-sm">
              {actionError && <p role="alert" className="text-rose-700">{actionError}</p>}
              <p className="text-slate-600">
                Bạn có chắc chắn muốn hủy lịch <strong>{cancelItem.serviceName}</strong> vào ngày <strong>{cancelItem.date}</strong> lúc{" "}
                <strong>{cancelItem.time}</strong> không?
              </p>

              <Textarea
                label="Lý do hủy (tùy chọn)"
                placeholder="Ví dụ: Thú cưng đã ổn định, bận việc gia đình..."
                value={cancelReason}
                onChange={(event) => setCancelReason(event.target.value)}
              />
            </div>

            <div className="flex gap-3 pt-2">
              <Button variant="outline" onClick={() => setCancelItem(null)} className="flex-1">
                Quay lại
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void handleConfirmCancel()} className="flex-1 bg-rose-600 text-white hover:bg-rose-700">
                Hủy lịch này
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
