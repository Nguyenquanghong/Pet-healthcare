import { useState } from "react";
import { CalendarClock, Ban, CheckCircle2, X } from "lucide-react";
import type { Appointment } from "../../../types/appointment";
import type { Pet } from "../../../types/pet";
import { appointmentStatusLabels } from "../../../utils/statusLabels";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Textarea } from "../../ui/Textarea";
import { useAppStore } from "../../../store/AppStoreProvider";

const STATUS_VARIANTS: Record<string, "default" | "success" | "warning" | "danger" | "info"> = {
  pending: "warning",
  confirmed: "success",
  checked_in: "info",
  in_progress: "info",
  completed: "default",
  cancelled: "danger",
  no_show: "danger",
};

interface OwnerAppointmentListProps {
  appointments: Appointment[];
  pets: Pet[];
}

export function OwnerAppointmentList({ appointments, pets }: OwnerAppointmentListProps) {
  const { cancelAppointment, rescheduleAppointment } = useAppStore();

  const [rescheduleItem, setRescheduleItem] = useState<Appointment | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [rescheduleTime, setRescheduleTime] = useState("");
  const [rescheduleNote, setRescheduleNote] = useState("");

  const [cancelItem, setCancelItem] = useState<Appointment | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [toastMsg, setToastMsg] = useState("");

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3500);
  };

  const openReschedule = (appointment: Appointment) => {
    setRescheduleItem(appointment);
    setRescheduleDate(appointment.date);
    setRescheduleTime(appointment.time);
    setRescheduleNote(appointment.ownerNote ?? "");
  };

  const handleConfirmReschedule = () => {
    if (!rescheduleItem || !rescheduleDate || !rescheduleTime) return;
    rescheduleAppointment(rescheduleItem.id, {
      date: rescheduleDate,
      time: rescheduleTime,
      ownerNote: rescheduleNote.trim() || undefined,
    });
    setRescheduleItem(null);
    showToast("Đã gửi yêu cầu dời lịch khám! Lịch hẹn đang chờ phòng khám xác nhận.");
  };

  const handleConfirmCancel = () => {
    if (!cancelItem) return;
    cancelAppointment(cancelItem.id, cancelReason.trim() || undefined);
    setCancelItem(null);
    setCancelReason("");
    showToast("Đã hủy lịch khám thành công.");
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-slate-100 px-6 py-5 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Lịch khám của bạn</h2>
          <p className="text-sm text-slate-500 mt-0.5">{appointments.length} lịch hẹn</p>
        </div>
      </div>

      {toastMsg && (
        <div className="mx-6 mt-4 flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm font-semibold text-emerald-800 animate-fadeIn">
          <CheckCircle2 size={16} />
          {toastMsg}
        </div>
      )}

      <div className="divide-y divide-slate-100">
        {appointments.map((appointment) => {
          const pet = pets.find((item) => item.id === appointment.petId);
          const canModify = ["pending", "confirmed"].includes(appointment.status);

          return (
            <div key={appointment.id} className="flex flex-col gap-4 px-6 py-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-start gap-4 flex-1">
                <div className="flex-shrink-0 rounded-xl bg-primary/10 px-3 py-2 text-center">
                  <p className="text-xs font-bold text-primary">{appointment.date.slice(5).replace("-", "/")}</p>
                  <p className="text-sm font-black text-primary">{appointment.time}</p>
                </div>
                <div className="space-y-1">
                  <p className="font-bold text-slate-900">{appointment.serviceName}</p>
                  <p className="text-sm text-slate-500">
                    Cho <span className="font-semibold text-slate-700">{pet?.name ?? appointment.petId}</span> ({pet?.breed ?? "Thú cưng"})
                  </p>
                  {appointment.ownerNote && (
                    <p className="text-xs text-slate-500 bg-slate-50 border border-slate-100 rounded-lg px-2.5 py-1.5 inline-block">
                      📝 {appointment.ownerNote}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex flex-col sm:items-end gap-2.5">
                <Badge variant={STATUS_VARIANTS[appointment.status] ?? "default"}>
                  {appointmentStatusLabels[appointment.status]}
                </Badge>

                {canModify && (
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => openReschedule(appointment)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:text-primary-dark bg-primary/5 hover:bg-primary/10 border border-primary/20 px-2.5 py-1.5 rounded-lg transition-colors"
                      title="Đổi ngày hoặc giờ khám"
                    >
                      <CalendarClock size={13} />
                      Đổi lịch
                    </button>
                    <button
                      onClick={() => setCancelItem(appointment)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 px-2.5 py-1.5 rounded-lg transition-colors"
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
        {appointments.length === 0 && (
          <p className="px-6 py-12 text-center text-slate-400">Bạn chưa có lịch khám nào.</p>
        )}
      </div>

      {/* Reschedule Modal */}
      {rescheduleItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl animate-scaleUp">
            <div className="flex items-center justify-between pb-4 border-b border-slate-100">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <CalendarClock size={20} className="text-primary" />
                Đổi lịch khám
              </h3>
              <button
                onClick={() => setRescheduleItem(null)}
                className="text-slate-400 hover:text-slate-600 rounded-lg p-1"
              >
                <X size={18} />
              </button>
            </div>

            <div className="my-4 space-y-4 text-sm">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-100 text-slate-600 text-xs leading-relaxed">
                Dịch vụ: <span className="font-bold text-slate-900">{rescheduleItem.serviceName}</span>
                <br />
                Sau khi đổi lịch, lịch hẹn sẽ được chuyển về trạng thái <strong>Chờ xác nhận</strong> để phòng khám kiểm tra lịch bác sĩ.
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Input
                  type="date"
                  label="Ngày mới"
                  value={rescheduleDate}
                  onChange={(e) => setRescheduleDate(e.target.value)}
                />
                <Input
                  type="time"
                  label="Giờ mới"
                  value={rescheduleTime}
                  onChange={(e) => setRescheduleTime(e.target.value)}
                />
              </div>

              <Textarea
                label="Lý do đổi / Ghi chú bổ sung"
                placeholder="Ví dụ: Bận đột xuất vào buổi sáng, xin chuyển sang chiều..."
                value={rescheduleNote}
                onChange={(e) => setRescheduleNote(e.target.value)}
              />
            </div>

            <div className="flex gap-3 pt-2">
              <Button
                variant="outline"
                onClick={() => setRescheduleItem(null)}
                className="flex-1"
              >
                Đóng
              </Button>
              <Button
                onClick={handleConfirmReschedule}
                disabled={!rescheduleDate || !rescheduleTime}
                className="flex-1"
              >
                Xác nhận đổi
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel Modal */}
      {cancelItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl animate-scaleUp">
            <div className="flex items-center justify-between pb-4 border-b border-slate-100">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2 text-rose-600">
                <Ban size={20} />
                Xác nhận hủy lịch khám
              </h3>
              <button
                onClick={() => setCancelItem(null)}
                className="text-slate-400 hover:text-slate-600 rounded-lg p-1"
              >
                <X size={18} />
              </button>
            </div>

            <div className="my-4 space-y-4 text-sm">
              <p className="text-slate-600">
                Bạn có chắc chắn muốn hủy lịch <strong>{cancelItem.serviceName}</strong> vào ngày{" "}
                <strong>{cancelItem.date}</strong> lúc <strong>{cancelItem.time}</strong> không?
              </p>

              <Textarea
                label="Lý do hủy (tùy chọn)"
                placeholder="Ví dụ: Thú cưng đã ổn định, bận việc gia đình..."
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
              />
            </div>

            <div className="flex gap-3 pt-2">
              <Button
                variant="outline"
                onClick={() => setCancelItem(null)}
                className="flex-1"
              >
                Quay lại
              </Button>
              <Button
                variant="danger"
                onClick={handleConfirmCancel}
                className="flex-1 bg-rose-600 hover:bg-rose-700 text-white"
              >
                Hủy lịch này
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}