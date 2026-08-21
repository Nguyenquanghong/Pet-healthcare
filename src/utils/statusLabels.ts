import type { AppointmentStatus } from "../types/appointment";
import type { HotelBookingStatus } from "../types/booking";
import type { PetHealthStatus } from "../types/pet";

export const appointmentStatusLabels: Record<AppointmentStatus, string> = {
  pending: "Chờ xác nhận",
  confirmed: "Đã xác nhận",
  checked_in: "Đã check-in",
  in_progress: "Đang khám",
  completed: "Hoàn thành",
  cancelled: "Đã hủy",
  no_show: "Không đến",
};

export const bookingStatusLabels: Record<HotelBookingStatus, string> = {
  pending: "Chờ xác nhận",
  confirmed: "Đã xác nhận",
  rejected: "Từ chối",
  checked_in: "Đã nhận thú cưng",
  in_stay: "Đang lưu trú",
  checked_out: "Đã trả thú cưng",
  cancelled: "Đã hủy",
};

export const petHealthLabels: Record<PetHealthStatus, string> = {
  healthy: "Khỏe mạnh",
  vaccination_due: "Cần tiêm phòng",
  under_treatment: "Đang điều trị",
  critical: "Cần theo dõi",
  stable: "Ổn định",
};

export const statusTone = (status: string) => {
  if (["confirmed", "completed", "healthy", "checked_out"].includes(status)) return "bg-emerald-100 text-emerald-700 border-emerald-200";
  if (["pending", "vaccination_due", "in_progress", "in_stay", "checked_in"].includes(status)) return "bg-amber-100 text-amber-700 border-amber-200";
  if (["cancelled", "rejected", "critical", "no_show"].includes(status)) return "bg-rose-100 text-rose-700 border-rose-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
};