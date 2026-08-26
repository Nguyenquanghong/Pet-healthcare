import type { Appointment } from "../types/appointment";
import type { HotelBooking } from "../types/booking";
import type { Pet } from "../types/pet";
import { formatDate } from "./date";

export const appointmentConfirmedMessage = (appointment: Appointment, pet?: Pet) => ({
  title: "Lịch khám đã được xác nhận",
  message: `${pet?.name ?? "Thú cưng"} có lịch ${appointment.serviceName} vào ${appointment.time} ngày ${formatDate(appointment.date)} tại ${appointment.clinicName}.`,
});

export const appointmentReminderMessage = (appointment: Appointment, pet?: Pet) => ({
  title: "Nhắc lịch khám",
  message: `${pet?.name ?? "Thú cưng"} có lịch ${appointment.serviceName} vào ${appointment.time} ngày ${formatDate(appointment.date)}. Vui lòng đến đúng giờ.`,
});

export const hotelBookingConfirmedMessage = (booking: HotelBooking, pet?: Pet) => ({
  title: "Đặt phòng khách sạn đã được xác nhận",
  message: `Booking cho ${pet?.name ?? "thú cưng"} từ ${formatDate(booking.checkIn)} đến ${formatDate(booking.checkOut)} đã được Bệnh viện Thú y Mỹ Đình xác nhận.`,
});

export const medicalRecordUpdatedMessage = (pet?: Pet) => ({
  title: "Hồ sơ y tế mới đã được cập nhật",
  message: `Bác sĩ đã cập nhật hồ sơ y tế mới cho ${pet?.name ?? "thú cưng"}. Bạn có thể xem chi tiết trong mục Medical Records.`,
});