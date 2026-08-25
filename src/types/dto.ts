/**
 * Data Transfer Objects (DTOs) — NIPONETO Backend Integration Layer
 *
 * Các DTO này được định nghĩa để chuẩn hóa dữ liệu gửi/nhận khi kết nối với
 * backend thật (REST API / GraphQL). Hiện tại các service đang dùng mock store.
 *
 * Khi swap sang backend thật:
 *   - Thay thế các service call hiện tại bằng fetch/axios sử dụng các DTO này.
 *   - Server trả về dữ liệu theo cùng shape → không cần thay đổi UI.
 */

import type { AppointmentStatus, AppointmentType } from "./appointment";
import type { HotelBookingStatus } from "./booking";

// ---------------------------------------------------------------------------
// Auth DTOs
// ---------------------------------------------------------------------------
export type LoginOwnerDTO = {
  email: string;
  password: string;
};

export type LoginAdminDTO = {
  username: string;
  password: string;
};

export type RegisterOwnerDTO = {
  email: string;
  password?: string;
  confirmPassword?: string;
  passwordHash?: string;
  passwordSalt?: string;
  fullName?: string;
  phone?: string;
  address?: string;
};

// ---------------------------------------------------------------------------
// Pet DTOs
// ---------------------------------------------------------------------------
export type CreatePetDTO = {
  name: string;
  species: "dog" | "cat" | "other";
  breed?: string;
  gender?: "male" | "female";
  ageLabel?: string;
  weightKg?: number;
  microchipId?: string;
  healthStatus?: string;
  allergies?: string[];
  avatarUrl?: string;
};

export type UpdatePetDTO = Partial<CreatePetDTO>;

// ---------------------------------------------------------------------------
// Appointment DTOs
// ---------------------------------------------------------------------------
export type CreateAppointmentDTO = {
  petId: string;
  type: AppointmentType;
  serviceName: string;
  date: string; // ISO date string YYYY-MM-DD
  time: string; // HH:mm
  doctorId?: string;
  ownerNote?: string;
};

export type UpdateAppointmentDTO = {
  status?: AppointmentStatus;
  internalNote?: string;
  date?: string;
  time?: string;
  ownerNote?: string;
};

export type RescheduleAppointmentDTO = {
  date: string;
  time: string;
  ownerNote?: string;
};

// ---------------------------------------------------------------------------
// Hotel Booking DTOs
// ---------------------------------------------------------------------------
export type CreateHotelBookingDTO = {
  petId: string;
  checkIn: string; // ISO date
  checkOut: string; // ISO date
  roomType: "standard" | "deluxe" | "vip";
  serviceKeys: string[];
  ownerNote?: string;
};

export type UpdateHotelBookingStatusDTO = {
  status: HotelBookingStatus;
  internalNote?: string;
};

export type DailyCareNoteDTO = {
  bookingId: string;
  note: string;
  eatingStatus?: "good" | "normal" | "poor";
  mood?: "happy" | "calm" | "anxious" | "tired";
  visibleToOwner?: boolean;
};

// ---------------------------------------------------------------------------
// Medical Record DTOs
// ---------------------------------------------------------------------------
export type CreateMedicalRecordDTO = {
  petId: string;
  appointmentId?: string;
  doctorName: string;
  visitDate: string; // YYYY-MM-DD
  title: string;
  symptoms?: string;
  diagnosis: string;
  treatment: string;
  medications?: string;
  vaccineName?: string;
  followUpDate?: string;
  weightKg?: number;
  temperatureC?: number;
  heartRateBpm?: number;
};

export type UpdateMedicalRecordDTO = Partial<CreateMedicalRecordDTO>;

// ---------------------------------------------------------------------------
// Notification DTOs
// ---------------------------------------------------------------------------
export type SendCustomNotificationDTO = {
  recipientOwnerId: string;
  title: string;
  message: string;
};
