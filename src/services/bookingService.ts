/**
 * bookingService — Service Layer cho Hotel Booking & Daily Care Notes
 *
 * Hiện tại: bọc các hàm từ useAppStore() trả về Promise.
 *
 * Khi swap sang backend thật:
 *   - getBookings:            GET    /api/hotel-bookings?ownerId=...
 *   - createBooking:          POST   /api/hotel-bookings
 *   - cancelBooking:          PATCH  /api/hotel-bookings/:id/cancel
 *   - updateBookingStatus:    PATCH  /api/hotel-bookings/:id/status
 *   - addDailyCareNote:       POST   /api/hotel-bookings/:id/care-notes
 *   - getDailyCareNotes:      GET    /api/hotel-bookings/:id/care-notes
 */

import type { DailyCareNote, HotelBooking, HotelBookingStatus } from "../types/booking";
import type {
  CreateHotelBookingDTO,
  DailyCareNoteDTO,
  UpdateHotelBookingStatusDTO,
} from "../types/dto";
import { ApiError, ApiErrorCode } from "../utils/apiError";

const SIMULATED_DELAY = 150;
const delay = <T>(v: T): Promise<T> =>
  new Promise((r) => setTimeout(() => r(v), SIMULATED_DELAY));

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Lấy danh sách hotel bookings từ store. */
export async function getHotelBookings(
  bookings: HotelBooking[],
): Promise<HotelBooking[]> {
  return delay(bookings);
}

/** Lấy danh sách daily care notes từ store. */
export async function getDailyCareNotes(
  notes: DailyCareNote[],
  bookingId: string,
): Promise<DailyCareNote[]> {
  return delay(notes.filter((n) => n.bookingId === bookingId));
}

// ---------------------------------------------------------------------------
// Write (Owner)
// ---------------------------------------------------------------------------

/**
 * Đặt phòng khách sạn mới.
 * TODO Backend: POST /api/hotel-bookings
 */
export async function createHotelBooking(
  dto: CreateHotelBookingDTO,
  storeFn: (input: CreateHotelBookingDTO) => void,
): Promise<void> {
  if (!dto.petId || !dto.checkIn || !dto.checkOut) {
    throw new ApiError(
      ApiErrorCode.VALIDATION_ERROR,
      422,
      "Vui lòng chọn thú cưng, ngày check-in và check-out.",
    );
  }
  if (dto.checkIn >= dto.checkOut) {
    throw new ApiError(
      ApiErrorCode.VALIDATION_ERROR,
      422,
      "Ngày check-out phải sau ngày check-in.",
    );
  }
  storeFn(dto);
  return delay(undefined);
}

/**
 * Hủy hotel booking.
 * TODO Backend: PATCH /api/hotel-bookings/:id/cancel
 */
export async function cancelHotelBooking(
  bookingId: string,
  ownerNote: string | undefined,
  storeFn: (id: string, note?: string) => void,
): Promise<void> {
  storeFn(bookingId, ownerNote);
  return delay(undefined);
}

// ---------------------------------------------------------------------------
// Write (Admin)
// ---------------------------------------------------------------------------

/**
 * Cập nhật trạng thái hotel booking.
 * TODO Backend: PATCH /api/hotel-bookings/:id/status
 */
export async function updateHotelBookingStatus(
  bookingId: string,
  dto: UpdateHotelBookingStatusDTO,
  storeFn: (id: string, status: HotelBookingStatus, note?: string) => void,
): Promise<void> {
  storeFn(bookingId, dto.status, dto.internalNote);
  return delay(undefined);
}

/**
 * Thêm nhật ký chăm sóc hàng ngày.
 * TODO Backend: POST /api/hotel-bookings/:id/care-notes
 */
export async function addDailyCareNote(
  dto: DailyCareNoteDTO,
  storeFn: (
    bookingId: string,
    note: string,
    eatingStatus?: "good" | "normal" | "poor",
    mood?: "happy" | "calm" | "anxious" | "tired",
  ) => void,
): Promise<void> {
  if (!dto.note.trim()) {
    throw new ApiError(
      ApiErrorCode.VALIDATION_ERROR,
      422,
      "Nội dung nhật ký chăm sóc không được để trống.",
    );
  }
  storeFn(dto.bookingId, dto.note, dto.eatingStatus, dto.mood);
  return delay(undefined);
}
