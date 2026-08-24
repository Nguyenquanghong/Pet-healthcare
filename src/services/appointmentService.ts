/**
 * appointmentService — Service Layer cho Lịch khám
 *
 * Hiện tại: bọc các hàm từ useAppStore() trả về Promise.
 *
 * Khi swap sang backend thật:
 *   - getAppointments:      GET    /api/appointments?ownerId=...
 *   - createAppointment:    POST   /api/appointments
 *   - cancelAppointment:    PATCH  /api/appointments/:id/cancel
 *   - rescheduleAppointment:PATCH  /api/appointments/:id/reschedule
 *   - updateStatus:         PATCH  /api/appointments/:id/status
 *   - sendReminder:         POST   /api/appointments/:id/reminder
 */

import type { Appointment, AppointmentStatus } from "../types/appointment";
import type {
  CreateAppointmentDTO,
  RescheduleAppointmentDTO,
} from "../types/dto";
import { ApiError, ApiErrorCode } from "../utils/apiError";

const SIMULATED_DELAY = 150;
const delay = <T>(v: T): Promise<T> =>
  new Promise((r) => setTimeout(() => r(v), SIMULATED_DELAY));

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Lấy danh sách lịch khám (đang dùng dữ liệu từ store). */
export async function getAppointments(
  appointments: Appointment[],
): Promise<Appointment[]> {
  return delay(appointments);
}

// ---------------------------------------------------------------------------
// Write (Owner)
// ---------------------------------------------------------------------------

/**
 * Đặt lịch khám mới.
 * TODO Backend: POST /api/appointments
 */
export async function createAppointment(
  dto: CreateAppointmentDTO,
  storeFn: (input: CreateAppointmentDTO) => void,
): Promise<void> {
  if (!dto.petId || !dto.date || !dto.time) {
    throw new ApiError(
      ApiErrorCode.VALIDATION_ERROR,
      422,
      "Vui lòng điền đủ thông tin thú cưng, ngày và giờ khám.",
    );
  }
  storeFn(dto);
  return delay(undefined);
}

/**
 * Hủy lịch khám.
 * TODO Backend: PATCH /api/appointments/:id/cancel
 */
export async function cancelAppointment(
  appointmentId: string,
  ownerNote: string | undefined,
  storeFn: (id: string, note?: string) => void,
): Promise<void> {
  storeFn(appointmentId, ownerNote);
  return delay(undefined);
}

/**
 * Dời lịch khám.
 * TODO Backend: PATCH /api/appointments/:id/reschedule
 */
export async function rescheduleAppointment(
  appointmentId: string,
  dto: RescheduleAppointmentDTO,
  storeFn: (id: string, input: RescheduleAppointmentDTO) => void,
): Promise<void> {
  if (!dto.date || !dto.time) {
    throw new ApiError(
      ApiErrorCode.VALIDATION_ERROR,
      422,
      "Vui lòng chọn ngày và giờ mới để dời lịch.",
    );
  }
  storeFn(appointmentId, dto);
  return delay(undefined);
}

// ---------------------------------------------------------------------------
// Write (Admin)
// ---------------------------------------------------------------------------

/**
 * Cập nhật trạng thái lịch khám.
 * TODO Backend: PATCH /api/appointments/:id/status
 */
export async function updateAppointmentStatus(
  appointmentId: string,
  status: AppointmentStatus,
  internalNote: string | undefined,
  storeFn: (id: string, status: AppointmentStatus, note?: string) => void,
): Promise<void> {
  storeFn(appointmentId, status, internalNote);
  return delay(undefined);
}

/**
 * Gửi nhắc lịch khám cho chủ nuôi.
 * TODO Backend: POST /api/appointments/:id/reminder
 */
export async function sendAppointmentReminder(
  appointmentId: string,
  storeFn: (id: string) => void,
): Promise<void> {
  storeFn(appointmentId);
  return delay(undefined);
}
