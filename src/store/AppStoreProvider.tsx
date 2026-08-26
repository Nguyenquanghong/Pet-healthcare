import { createContext, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import type { Appointment, AppointmentStatus, AppointmentType } from "../types/appointment";
import type { DailyCareNote, HotelBooking, HotelBookingStatus } from "../types/booking";
import type { MedicalRecord } from "../types/medicalRecord";
import type { MedicalImage } from "../types/medicalImage";
import type { Notification } from "../types/notification";
import type { Owner } from "../types/owner";
import type { Pet } from "../types/pet";
import { calculateBookingTotal, calculateNights } from "../utils/bookingCalculator";
import { createId } from "../utils/id";
import { verifyPassword } from "../utils/passwordHash";

type AppStoreProviderProps = { children: ReactNode };

type CreateHotelBookingInput = { petId: string; checkIn: string; checkOut: string; roomType: HotelBooking["roomType"]; serviceKeys: HotelBooking["serviceKeys"]; ownerNote?: string };
type CreateAppointmentInput = { petId: string; type: AppointmentType; serviceName: string; date: string; time: string; doctorId?: string; ownerNote?: string };
type RescheduleAppointmentInput = { date: string; time: string; ownerNote?: string };
type CreateMedicalRecordInput = Omit<MedicalRecord, "id" | "ownerId" | "createdAt" | "updatedAt">;
type UpdateMedicalRecordInput = Partial<Omit<MedicalRecord, "id" | "ownerId" | "createdAt">>;
type RegisterOwnerInput = {
  fullName?: string;
  phone?: string;
  email: string;
  passwordHash: string;
  passwordSalt: string;
  address?: string;
};
type CreatePetInput = Omit<Pet, "id" | "ownerId">;
type UpdatePetInput = Partial<Omit<Pet, "id" | "ownerId">>;
type RescueReportInput = { petId: string; finderName?: string; finderPhone: string; location: string; note?: string };
type UploadMedicalImageInput = { petId: string; title: string; imageUrl: string; mimeType: string };
type AuthRole = "owner" | "admin" | null;

type AddDailyCareNoteInput = {
  bookingId: string;
  note: string;
  eatingStatus?: "good" | "normal" | "poor";
  mood?: "happy" | "calm" | "anxious" | "tired";
  visibleToOwner?: boolean;
};

type AppState = {
  authRole: AuthRole;
  currentOwnerId: string;
  owners: Owner[];
  pets: Pet[];
  appointments: Appointment[];
  medicalRecords: MedicalRecord[];
  medicalImages: MedicalImage[];
  hotelBookings: HotelBooking[];
  dailyCareNotes: DailyCareNote[];
  notifications: Notification[];
};

type AppAction =
  | { type: "REGISTER_OWNER"; payload: RegisterOwnerInput }
  | { type: "LOGIN_OWNER"; payload: { email: string } }
  | { type: "LOGIN_ADMIN" }
  | { type: "LOGOUT" }
  | { type: "CREATE_PET"; payload: CreatePetInput }
  | { type: "UPDATE_PET"; payload: { petId: string; input: UpdatePetInput } }
  | { type: "SUBMIT_RESCUE_REPORT"; payload: RescueReportInput }
  | { type: "CREATE_HOTEL_BOOKING"; payload: CreateHotelBookingInput }
  | { type: "UPDATE_HOTEL_BOOKING_STATUS"; payload: { bookingId: string; status: HotelBookingStatus; internalNote?: string } }
  | { type: "UPDATE_HOTEL_BOOKING_INTERNAL_NOTE"; payload: { bookingId: string; internalNote: string } }
  | { type: "CANCEL_HOTEL_BOOKING"; payload: { bookingId: string; ownerNote?: string } }
  | { type: "ADD_DAILY_CARE_NOTE"; payload: AddDailyCareNoteInput }
  | { type: "CREATE_APPOINTMENT"; payload: CreateAppointmentInput }
  | { type: "CANCEL_APPOINTMENT"; payload: { appointmentId: string; ownerNote?: string } }
  | { type: "RESCHEDULE_APPOINTMENT"; payload: { appointmentId: string; input: RescheduleAppointmentInput } }
  | { type: "UPDATE_APPOINTMENT_STATUS"; payload: { appointmentId: string; status: AppointmentStatus; internalNote?: string } }
  | { type: "UPDATE_APPOINTMENT_INTERNAL_NOTE"; payload: { appointmentId: string; internalNote: string } }
  | { type: "SEND_REMINDER"; payload: { appointmentId: string } }
  | { type: "CREATE_MEDICAL_RECORD"; payload: CreateMedicalRecordInput }
  | { type: "UPDATE_MEDICAL_RECORD"; payload: { recordId: string; input: UpdateMedicalRecordInput } }
  | { type: "DELETE_MEDICAL_RECORD"; payload: { recordId: string } }
  | { type: "UPLOAD_MEDICAL_IMAGE"; payload: UploadMedicalImageInput }
  | { type: "DELETE_MEDICAL_IMAGE"; payload: { imageId: string } }
  | { type: "MARK_NOTIFICATION_READ"; payload: { notificationId: string } }
  | { type: "MARK_ALL_NOTIFICATIONS_READ" }
  | { type: "DELETE_NOTIFICATION"; payload: { notificationId: string } }
  | { type: "SEND_CUSTOM_NOTIFICATION"; payload: { recipientOwnerId: string; title: string; message: string } }
  | { type: "RESET_STORE_DATA" };

type AppStoreValue = AppState & {
  isLoading: boolean;
  currentOwner: Owner;
  ownerPets: Pet[];
  loginOwner: (email: string, password: string) => Promise<boolean>;
  loginAdmin: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  registerOwner: (input: RegisterOwnerInput) => Promise<void>;
  createPet: (input: CreatePetInput) => void;
  updatePet: (petId: string, input: UpdatePetInput) => void;
  submitRescueReport: (input: RescueReportInput) => void;
  createHotelBooking: (input: CreateHotelBookingInput) => void;
  updateHotelBookingStatus: (bookingId: string, status: HotelBookingStatus, internalNote?: string) => void;
  updateHotelBookingInternalNote: (bookingId: string, internalNote: string) => void;
  cancelHotelBooking: (bookingId: string, ownerNote?: string) => void;
  addDailyCareNote: (
    bookingId: string,
    note: string,
    eatingStatus?: "good" | "normal" | "poor",
    mood?: "happy" | "calm" | "anxious" | "tired"
  ) => void;
  createAppointment: (input: CreateAppointmentInput) => void;
  cancelAppointment: (appointmentId: string, ownerNote?: string) => void;
  rescheduleAppointment: (appointmentId: string, input: RescheduleAppointmentInput) => void;
  updateAppointmentStatus: (appointmentId: string, status: AppointmentStatus, internalNote?: string) => void;
  updateAppointmentInternalNote: (appointmentId: string, internalNote: string) => void;
  sendReminder: (appointmentId: string) => void;
  createMedicalRecord: (input: CreateMedicalRecordInput) => void;
  updateMedicalRecord: (recordId: string, input: UpdateMedicalRecordInput) => void;
  deleteMedicalRecord: (recordId: string) => void;
  uploadMedicalImage: (input: UploadMedicalImageInput) => void;
  deleteMedicalImage: (imageId: string) => void;
  markNotificationRead: (notificationId: string) => void;
  markAllNotificationsRead: () => void;
  deleteNotification: (notificationId: string) => void;
  sendCustomNotification: (recipientOwnerId: string, title: string, message: string) => void;
  resetStoreData: () => void;
};

const STORAGE_KEY = "niponeto_app_state";
const DEMO_OWNER_EMAIL = "owner@example.com";
const DEMO_OWNER_PASSWORD_HASH = "2AaUO5pi+D5fOIXcKJSLzJYmMZFmJ0whrUQyh4Tz9DM=";
const DEMO_OWNER_PASSWORD_SALT = "bmlwb25ldG8tZGVtby1vd25lci1zYWx0";
const DEMO_ADMIN_USERNAME = "admin";
const DEMO_ADMIN_PASSWORD_HASH = "Csbdv6XeLCUGafp03chOaooQPLVl+OhEPT/B+/Jic30=";
const DEMO_ADMIN_PASSWORD_SALT = "bmlwb25ldG8tZGVtby1hZG1pbi1zYWx0";
const now = new Date().toISOString();

function createQrToken(petId: string) {
  return `${petId}_${Math.random().toString(36).slice(2, 10)}`;
}

function getDefaultPublicProfile(pet?: Partial<Pet>): NonNullable<Pet["publicProfile"]> {
  return {
    showOwnerPhone: true,
    showOwnerEmail: false,
    showOwnerAddress: false,
    showMedicalAlerts: true,
    rescueNote: "Please keep my pet safe and contact me as soon as possible.",
    ...pet?.publicProfile,
  };
}

function normalizePet(pet: Pet): Pet {
  return {
    ...pet,
    qrToken: pet.qrToken ?? createQrToken(pet.id),
    qrEnabled: pet.qrEnabled ?? true,
    publicProfile: getDefaultPublicProfile(pet),
  };
}

const initialState: AppState = {
  authRole: null,
  currentOwnerId: "owner_1",
  owners: [
    {
      id: "owner_1",
      fullName: "Nguyễn Văn A",
      phone: "0901234567",
      email: "owner@example.com",
      passwordHash: DEMO_OWNER_PASSWORD_HASH,
      passwordSalt: DEMO_OWNER_PASSWORD_SALT,
      address: "Mỹ Đình, Hà Nội",
      petIds: ["pet_mochi", "pet_yuki"],
    },
  ],
  pets: [
    { id: "pet_mochi", ownerId: "owner_1", name: "Mochi", species: "dog", breed: "Shiba Inu", gender: "male", ageLabel: "2 tuổi", weightKg: 8.4, microchipId: "JP-2026-MOCHI", healthStatus: "healthy", allergies: ["Không"], identifyingMarks: "Lông vàng nâu, đuôi cuộn tròn.", lastSeenLocation: "Mỹ Đình, Hà Nội", qrToken: "rescue_mochi_demo", qrEnabled: true, publicProfile: getDefaultPublicProfile({ publicProfile: { showOwnerPhone: true, showOwnerEmail: false, showOwnerAddress: false, showMedicalAlerts: true, rescueNote: "Mochi hơi nhát. Vui lòng không đuổi theo, hãy gọi chủ nuôi ngay." } }) },
    { id: "pet_yuki", ownerId: "owner_1", name: "Yuki", species: "dog", breed: "Shiba Inu", gender: "female", ageLabel: "1 tuổi", weightKg: 7.2, microchipId: "JP-2026-YUKI", healthStatus: "stable", allergies: ["Thịt bò"], identifyingMarks: "Nhỏ con, có vòng cổ màu đỏ.", qrToken: "rescue_yuki_demo", qrEnabled: true, publicProfile: getDefaultPublicProfile({ publicProfile: { showOwnerPhone: true, showOwnerEmail: false, showOwnerAddress: false, showMedicalAlerts: true, rescueNote: "Yuki dị ứng thịt bò, vui lòng không cho ăn đồ lạ." } }) },
    { id: "pet_sashimi", ownerId: "owner_2", name: "Sashimi", species: "cat", breed: "Scottish Fold", gender: "female", ageLabel: "1 tuổi", weightKg: 4.1, healthStatus: "vaccination_due", qrToken: "rescue_sashimi_demo", qrEnabled: true, publicProfile: getDefaultPublicProfile() },
  ],
  appointments: [
    { id: "appointment_1", petId: "pet_mochi", ownerId: "owner_1", doctorId: "doctor_mai", type: "general_checkup", serviceName: "Khám tổng quát", clinicName: "Bệnh viện Thú y Mỹ Đình", date: "2026-11-02", time: "09:00", status: "confirmed", createdBy: "owner", createdAt: now, updatedAt: now },
    { id: "appointment_2", petId: "pet_yuki", ownerId: "owner_1", doctorId: "doctor_sato", type: "vaccination", serviceName: "Tiêm phòng", clinicName: "Bệnh viện Thú y Mỹ Đình", date: "2026-11-03", time: "10:30", status: "pending", ownerNote: "Ưu tiên buổi sáng.", createdBy: "owner", createdAt: now, updatedAt: now },
  ],
  medicalRecords: [
    { id: "record_1", petId: "pet_mochi", ownerId: "owner_1", appointmentId: "appointment_1", doctorName: "Bs. Mai Nguyễn", visitDate: "2026-10-28", title: "Annual Checkup & Vaccination", symptoms: "Khám định kỳ, không có triệu chứng bất thường.", diagnosis: "Sức khỏe ổn định, cân nặng phù hợp giống Shiba Inu.", treatment: "Tiêm vaccine nhắc lại và tư vấn dinh dưỡng.", medications: "Vitamin tổng hợp 7 ngày", vaccineName: "DHPPi + Lepto", followUpDate: "2027-04-28", weightKg: 8.4, temperatureC: 38.2, heartRateBpm: 92, createdAt: now, updatedAt: now },
    { id: "record_2", petId: "pet_yuki", ownerId: "owner_1", doctorName: "Dr. Kenji Sato", visitDate: "2026-10-14", title: "Dermatology Consult", symptoms: "Ngứa nhẹ sau khi đổi thức ăn.", diagnosis: "Nghi dị ứng protein bò.", treatment: "Ngưng thức ăn chứa bò, theo dõi da trong 14 ngày.", medications: "Sữa tắm dịu nhẹ 2 lần/tuần", followUpDate: "2026-11-14", weightKg: 7.2, temperatureC: 38.4, heartRateBpm: 96, createdAt: now, updatedAt: now },
  ],
  medicalImages: [],
  hotelBookings: [
    { id: "booking_1", petId: "pet_yuki", ownerId: "owner_1", checkIn: "2026-11-10", checkOut: "2026-11-13", nights: 3, roomType: "deluxe", serviceKeys: ["special_diet"], totalAmount: 20100, status: "pending", ownerNote: "Yuki cần chế độ ăn ít muối.", dailyCareNoteIds: [], createdAt: now, updatedAt: now },
    { id: "booking_2", petId: "pet_mochi", ownerId: "owner_1", checkIn: "2026-11-18", checkOut: "2026-11-20", nights: 2, roomType: "standard", serviceKeys: ["daily_walk"], totalAmount: 7600, status: "in_stay", dailyCareNoteIds: ["note_1"], createdAt: now, updatedAt: now },
  ],
  dailyCareNotes: [
    {
      id: "note_1",
      bookingId: "booking_2",
      date: "2026-11-19",
      eatingStatus: "good",
      mood: "happy",
      note: "Bé Mochi hôm nay ăn ngon miệng, đi dạo 30 phút trong sân vườn và rất hợp tác.",
      visibleToOwner: true,
      createdByStaffId: "staff_admin",
      createdAt: now,
    },
  ],
  notifications: [
    { id: "noti_1", recipientOwnerId: "owner_1", recipientRole: "owner", type: "appointment_reminder", title: "Nhắc lịch khám", message: "Mochi có lịch khám vào 09:00 ngày mai tại Bệnh viện Thú y Mỹ Đình.", status: "sent", actionUrl: "/owner/appointments", relatedPetId: "pet_mochi", relatedAppointmentId: "appointment_1", createdAt: now, sentAt: now },
    { id: "noti_2", recipientOwnerId: "owner_1", recipientRole: "owner", type: "vaccination_reminder", title: "Nhắc tiêm phòng", message: "Yuki cần tiêm phòng nhắc lại trong tuần này.", status: "sent", actionUrl: "/owner/appointments", relatedPetId: "pet_yuki", createdAt: now, sentAt: now },
    { id: "noti_3", recipientRole: "admin", type: "appointment_created", title: "Lịch khám mới", message: "Yuki (Chủ nuôi: Nguyễn Văn A) vừa đặt lịch tiêm phòng lúc 10:30 ngày 2026-11-03.", status: "sent", actionUrl: "/admin/appointments", relatedPetId: "pet_yuki", relatedAppointmentId: "appointment_2", createdAt: now, sentAt: now },
  ],
};

const AppStoreContext = createContext<AppStoreValue | null>(null);

function appointmentNotification(appointment: Appointment, status: AppointmentStatus): Notification | null {
  const createdAt = new Date().toISOString();
  if (status === "confirmed")
    return {
      id: createId("noti"),
      recipientOwnerId: appointment.ownerId,
      recipientRole: "owner",
      type: "appointment_confirmed",
      title: "Lịch khám đã được xác nhận",
      message: `Lịch ${appointment.serviceName} lúc ${appointment.time} ngày ${appointment.date} đã được xác nhận.`,
      status: "sent",
      actionUrl: "/owner/appointments",
      relatedAppointmentId: appointment.id,
      relatedPetId: appointment.petId,
      sentByStaffId: "staff_admin",
      createdAt,
      sentAt: createdAt,
    };
  if (status === "cancelled")
    return {
      id: createId("noti"),
      recipientOwnerId: appointment.ownerId,
      recipientRole: "owner",
      type: "appointment_cancelled",
      title: "Lịch khám đã bị hủy",
      message: `Lịch ${appointment.serviceName} ngày ${appointment.date} đã được hủy.`,
      status: "sent",
      actionUrl: "/owner/appointments",
      relatedAppointmentId: appointment.id,
      relatedPetId: appointment.petId,
      sentByStaffId: "staff_admin",
      createdAt,
      sentAt: createdAt,
    };
  if (status === "completed")
    return {
      id: createId("noti"),
      recipientOwnerId: appointment.ownerId,
      recipientRole: "owner",
      type: "medical_record_updated",
      title: "Lịch khám đã hoàn thành",
      message: `Lịch khám ${appointment.serviceName} đã hoàn thành. Hồ sơ y tế sẽ được cập nhật.`,
      status: "sent",
      actionUrl: "/owner/medical-records",
      relatedAppointmentId: appointment.id,
      relatedPetId: appointment.petId,
      sentByStaffId: "staff_admin",
      createdAt,
      sentAt: createdAt,
    };
  return null;
}

function bookingNotification(booking: HotelBooking, status: HotelBookingStatus): Notification | null {
  const createdAt = new Date().toISOString();
  if (status === "confirmed")
    return {
      id: createId("noti"),
      recipientOwnerId: booking.ownerId,
      recipientRole: "owner",
      type: "hotel_booking_confirmed",
      title: "Hotel booking đã được xác nhận",
      message: `Yêu cầu lưu trú từ ${booking.checkIn} đến ${booking.checkOut} đã được bệnh viện xác nhận.`,
      status: "sent",
      actionUrl: "/owner/hotel-booking",
      relatedBookingId: booking.id,
      relatedPetId: booking.petId,
      sentByStaffId: "staff_admin",
      createdAt,
      sentAt: createdAt,
    };
  if (status === "rejected")
    return {
      id: createId("noti"),
      recipientOwnerId: booking.ownerId,
      recipientRole: "owner",
      type: "general",
      title: "Hotel booking bị từ chối",
      message: `Yêu cầu lưu trú từ ${booking.checkIn} đến ${booking.checkOut} chưa thể xác nhận. Vui lòng chọn ngày/phòng khác.`,
      status: "sent",
      actionUrl: "/owner/hotel-booking",
      relatedBookingId: booking.id,
      relatedPetId: booking.petId,
      sentByStaffId: "staff_admin",
      createdAt,
      sentAt: createdAt,
    };
  if (status === "cancelled")
    return {
      id: createId("noti"),
      recipientOwnerId: booking.ownerId,
      recipientRole: "owner",
      type: "hotel_booking_cancelled",
      title: "Hotel booking đã hủy",
      message: `Yêu cầu lưu trú từ ${booking.checkIn} đến ${booking.checkOut} đã được hủy.`,
      status: "sent",
      actionUrl: "/owner/hotel-booking",
      relatedBookingId: booking.id,
      relatedPetId: booking.petId,
      sentByStaffId: "staff_admin",
      createdAt,
      sentAt: createdAt,
    };
  if (status === "in_stay")
    return {
      id: createId("noti"),
      recipientOwnerId: booking.ownerId,
      recipientRole: "owner",
      type: "general",
      title: "Thú cưng đã nhận phòng",
      message: `Thú cưng đã check-in khách sạn thành công và đang được chăm sóc chu đáo.`,
      status: "sent",
      actionUrl: "/owner/hotel-booking",
      relatedBookingId: booking.id,
      relatedPetId: booking.petId,
      sentByStaffId: "staff_admin",
      createdAt,
      sentAt: createdAt,
    };
  if (status === "checked_out")
    return {
      id: createId("noti"),
      recipientOwnerId: booking.ownerId,
      recipientRole: "owner",
      type: "hotel_checked_out",
      title: "Hoàn tất lưu trú khách sạn",
      message: `Thú cưng đã hoàn tất kỳ lưu trú và được bàn giao cho chủ nuôi. Cảm ơn bạn đã tin tưởng dịch vụ!`,
      status: "sent",
      actionUrl: "/owner/hotel-booking",
      relatedBookingId: booking.id,
      relatedPetId: booking.petId,
      sentByStaffId: "staff_admin",
      createdAt,
      sentAt: createdAt,
    };
  return null;
}

function medicalRecordNotification(record: MedicalRecord): Notification {
  const createdAt = new Date().toISOString();
  return {
    id: createId("noti"),
    recipientOwnerId: record.ownerId,
    recipientRole: "owner",
    type: "medical_record_updated",
    title: "Hồ sơ y tế mới đã được cập nhật",
    message: `Bác sĩ đã cập nhật hồ sơ ${record.title} ngày ${record.visitDate}. Bạn có thể xem chi tiết trong mục Bệnh án.`,
    status: "sent",
    actionUrl: "/owner/medical-records",
    relatedAppointmentId: record.appointmentId,
    relatedPetId: record.petId,
    sentByStaffId: "staff_admin",
    createdAt,
    sentAt: createdAt,
  };
}

function normalizeState(state: AppState): AppState {
  const rawBookings = (state.hotelBookings ?? initialState.hotelBookings) as (HotelBooking | { status: string })[];
  const normalizedBookings: HotelBooking[] = rawBookings.map((b) => {
    let status: HotelBookingStatus = b.status as HotelBookingStatus;
    if ((b.status as string) === "checked_in") status = "in_stay";
    if ((b.status as string) === "completed") status = "checked_out";
    return {
      ...(b as HotelBooking),
      status,
      dailyCareNoteIds: (b as HotelBooking).dailyCareNoteIds ?? [],
    };
  });

  const normalizedOwners = (state.owners ?? initialState.owners).map((owner) => {
    if (owner.email?.trim().toLowerCase() !== DEMO_OWNER_EMAIL) return owner;
    return {
      ...owner,
      passwordHash: owner.passwordHash ?? DEMO_OWNER_PASSWORD_HASH,
      passwordSalt: owner.passwordSalt ?? DEMO_OWNER_PASSWORD_SALT,
    };
  });

  return {
    ...initialState,
    ...state,
    owners: normalizedOwners,
    pets: (state.pets ?? initialState.pets).map(normalizePet),
    appointments: state.appointments ?? initialState.appointments,
    medicalRecords: state.medicalRecords ?? initialState.medicalRecords,
    medicalImages: state.medicalImages ?? initialState.medicalImages,
    hotelBookings: normalizedBookings,
    dailyCareNotes: state.dailyCareNotes ?? initialState.dailyCareNotes ?? [],
    notifications: state.notifications ?? initialState.notifications,
  };
}

function appStoreReducer(state: AppState, action: AppAction): AppState {
  if (action.type === "RESET_STORE_DATA") {
    localStorage.removeItem(STORAGE_KEY);
    return initialState;
  }

  if (action.type === "REGISTER_OWNER") {
    const owner: Owner = {
      id: createId("owner"),
      fullName: action.payload.fullName?.trim() || action.payload.email.split("@")[0],
      phone: action.payload.phone?.trim() || "",
      email: action.payload.email.trim().toLowerCase(),
      passwordHash: action.payload.passwordHash,
      passwordSalt: action.payload.passwordSalt,
      address: action.payload.address?.trim() || undefined,
      petIds: [],
    };
    const createdAt = new Date().toISOString();
    const notification: Notification = {
      id: createId("noti"),
      recipientOwnerId: owner.id,
      recipientRole: "owner",
      type: "general",
      title: "Chào mừng đến với Nippon Pet Care",
      message: "Tài khoản chủ nuôi của bạn đã được tạo. Bạn có thể cập nhật hồ sơ thú cưng và đặt lịch dịch vụ ngay bây giờ.",
      status: "sent",
      actionUrl: "/owner/dashboard",
      createdAt,
      sentAt: createdAt,
    };
    return { ...state, authRole: "owner", currentOwnerId: owner.id, owners: [owner, ...state.owners], notifications: [notification, ...state.notifications] };
  }

  if (action.type === "LOGIN_OWNER") {
    const owner = state.owners.find((item) => item.email?.trim().toLowerCase() === action.payload.email.trim().toLowerCase());
    return owner ? { ...state, authRole: "owner", currentOwnerId: owner.id } : state;
  }

  if (action.type === "LOGIN_ADMIN") return { ...state, authRole: "admin" };

  if (action.type === "LOGOUT") return { ...state, authRole: null };

  if (action.type === "CREATE_PET") {
    const id = createId("pet");
    const pet: Pet = normalizePet({ id, ownerId: state.currentOwnerId, ...action.payload });
    const owners = state.owners.map((owner) =>
      owner.id === state.currentOwnerId ? { ...owner, petIds: [...owner.petIds, pet.id] } : owner,
    );
    return { ...state, owners, pets: [pet, ...state.pets] };
  }

  if (action.type === "UPDATE_PET") {
    return {
      ...state,
      pets: state.pets.map((pet) =>
        pet.id === action.payload.petId && pet.ownerId === state.currentOwnerId
          ? normalizePet({ ...pet, ...action.payload.input })
          : pet,
      ),
    };
  }

  if (action.type === "SUBMIT_RESCUE_REPORT") {
    const pet = state.pets.find((item) => item.id === action.payload.petId && item.qrEnabled !== false);
    if (!pet) return state;

    const createdAt = new Date().toISOString();
    const notification: Notification = {
      id: createId("noti"),
      recipientOwnerId: pet.ownerId,
      recipientRole: "owner",
      type: "pet_rescue_report",
      title: `Có người vừa tìm thấy ${pet.name}`,
      message: `${action.payload.finderName?.trim() || "Người tìm thấy"} báo đã gặp ${pet.name} tại ${action.payload.location}. SĐT liên hệ: ${action.payload.finderPhone}.${action.payload.note ? ` Ghi chú: ${action.payload.note}` : ""}`,
      status: "sent",
      actionUrl: "/owner/notifications",
      relatedPetId: pet.id,
      createdAt,
      sentAt: createdAt,
    };

    return { ...state, notifications: [notification, ...state.notifications] };
  }

  if (action.type === "CREATE_MEDICAL_RECORD") {
    const pet = state.pets.find((item) => item.id === action.payload.petId);
    const createdAt = new Date().toISOString();
    const record: MedicalRecord = { ...action.payload, id: createId("record"), ownerId: pet?.ownerId ?? state.currentOwnerId, createdAt, updatedAt: createdAt };
    const updatedAppointments = record.appointmentId
      ? state.appointments.map((appointment) =>
          appointment.id === record.appointmentId ? { ...appointment, status: "completed" as const, updatedAt: createdAt } : appointment
        )
      : state.appointments;
    return { ...state, appointments: updatedAppointments, medicalRecords: [record, ...state.medicalRecords], notifications: [medicalRecordNotification(record), ...state.notifications] };
  }

  if (action.type === "UPDATE_MEDICAL_RECORD") {
    const createdAt = new Date().toISOString();
    const nextPet = action.payload.input.petId
      ? state.pets.find((pet) => pet.id === action.payload.input.petId)
      : undefined;
    const medicalRecords = state.medicalRecords.map((item) =>
      item.id === action.payload.recordId
        ? { ...item, ...action.payload.input, ownerId: nextPet?.ownerId ?? item.ownerId, updatedAt: createdAt }
        : item
    );
    return { ...state, medicalRecords };
  }

  if (action.type === "DELETE_MEDICAL_RECORD") {
    return {
      ...state,
      medicalRecords: state.medicalRecords.filter((item) => item.id !== action.payload.recordId),
    };
  }

  if (action.type === "UPLOAD_MEDICAL_IMAGE") {
    const pet = state.pets.find((item) => item.id === action.payload.petId);
    if (!pet) return state;
    const createdAt = new Date().toISOString();
    const image: MedicalImage = {
      ...action.payload,
      id: createId("image"),
      ownerId: pet.ownerId,
      uploadedByStaffId: "staff_admin",
      createdAt,
    };
    return { ...state, medicalImages: [image, ...state.medicalImages] };
  }

  if (action.type === "DELETE_MEDICAL_IMAGE") {
    return { ...state, medicalImages: state.medicalImages.filter((item) => item.id !== action.payload.imageId) };
  }

  if (action.type === "CREATE_APPOINTMENT") {
    const pet = state.pets.find((item) => item.id === action.payload.petId);
    const owner = state.owners.find((item) => item.id === (pet?.ownerId ?? state.currentOwnerId));
    const createdAt = new Date().toISOString();
    const appointment: Appointment = {
      id: createId("appointment"),
      petId: action.payload.petId,
      ownerId: pet?.ownerId ?? state.currentOwnerId,
      doctorId: action.payload.doctorId,
      type: action.payload.type,
      serviceName: action.payload.serviceName,
      clinicName: "Bệnh viện Thú y Mỹ Đình",
      date: action.payload.date,
      time: action.payload.time,
      status: "pending",
      ownerNote: action.payload.ownerNote,
      createdBy: "owner",
      createdAt,
      updatedAt: createdAt,
    };

    const ownerNotification: Notification = {
      id: createId("noti"),
      recipientOwnerId: appointment.ownerId,
      recipientRole: "owner",
      type: "appointment_created",
      title: "Đã gửi yêu cầu đặt lịch",
      message: `Lịch ${appointment.serviceName} lúc ${appointment.time} ngày ${appointment.date} đang chờ xác nhận.`,
      status: "sent",
      actionUrl: "/owner/appointments",
      relatedAppointmentId: appointment.id,
      relatedPetId: appointment.petId,
      createdAt,
      sentAt: createdAt,
    };

    const adminNotification: Notification = {
      id: createId("noti"),
      recipientRole: "admin",
      type: "appointment_created",
      title: "Lịch khám mới",
      message: `Bệnh nhân ${pet?.name ?? "Pet"} (Chủ: ${owner?.fullName ?? "Khách hàng"}) vừa đặt lịch ${appointment.serviceName} ngày ${appointment.date} lúc ${appointment.time}.`,
      status: "sent",
      actionUrl: "/admin/appointments",
      relatedAppointmentId: appointment.id,
      relatedPetId: appointment.petId,
      createdAt,
      sentAt: createdAt,
    };

    return {
      ...state,
      appointments: [appointment, ...state.appointments],
      notifications: [adminNotification, ownerNotification, ...state.notifications],
    };
  }

  if (action.type === "CANCEL_APPOINTMENT") {
    const appointment = state.appointments.find((item) => item.id === action.payload.appointmentId);
    if (!appointment || !["pending", "confirmed"].includes(appointment.status)) return state;
    const pet = state.pets.find((item) => item.id === appointment.petId);
    const createdAt = new Date().toISOString();
    const updatedAppointments = state.appointments.map((item) =>
      item.id === action.payload.appointmentId
        ? {
            ...item,
            status: "cancelled" as const,
            ownerNote: action.payload.ownerNote ? `${item.ownerNote ? `${item.ownerNote} | ` : ""}Lý do hủy: ${action.payload.ownerNote}` : item.ownerNote,
            updatedAt: createdAt,
          }
        : item
    );

    const ownerNoti: Notification = {
      id: createId("noti"),
      recipientOwnerId: appointment.ownerId,
      recipientRole: "owner",
      type: "appointment_cancelled",
      title: "Lịch khám đã hủy",
      message: `Bạn đã hủy lịch ${appointment.serviceName} ngày ${appointment.date} thành công.`,
      status: "sent",
      actionUrl: "/owner/appointments",
      relatedAppointmentId: appointment.id,
      relatedPetId: appointment.petId,
      createdAt,
      sentAt: createdAt,
    };

    const adminNoti: Notification = {
      id: createId("noti"),
      recipientRole: "admin",
      type: "appointment_cancelled",
      title: "Lịch khám bị hủy",
      message: `Lịch ${appointment.serviceName} của ${pet?.name ?? "Pet"} ngày ${appointment.date} vừa bị hủy.`,
      status: "sent",
      actionUrl: "/admin/appointments",
      relatedAppointmentId: appointment.id,
      relatedPetId: appointment.petId,
      createdAt,
      sentAt: createdAt,
    };

    return { ...state, appointments: updatedAppointments, notifications: [adminNoti, ownerNoti, ...state.notifications] };
  }

  if (action.type === "RESCHEDULE_APPOINTMENT") {
    const appointment = state.appointments.find((item) => item.id === action.payload.appointmentId);
    if (!appointment || !["pending", "confirmed"].includes(appointment.status)) return state;
    const pet = state.pets.find((item) => item.id === appointment.petId);
    const createdAt = new Date().toISOString();
    const updatedAppointments = state.appointments.map((item) =>
      item.id === action.payload.appointmentId
        ? {
            ...item,
            date: action.payload.input.date,
            time: action.payload.input.time,
            status: "pending" as const,
            ownerNote: action.payload.input.ownerNote ? action.payload.input.ownerNote : item.ownerNote,
            updatedAt: createdAt,
          }
        : item
    );

    const ownerNoti: Notification = {
      id: createId("noti"),
      recipientOwnerId: appointment.ownerId,
      recipientRole: "owner",
      type: "appointment_rescheduled",
      title: "Yêu cầu dời lịch khám đã gửi",
      message: `Lịch ${appointment.serviceName} đã được yêu cầu chuyển sang ${action.payload.input.time} ngày ${action.payload.input.date} và đang chờ xác nhận.`,
      status: "sent",
      actionUrl: "/owner/appointments",
      relatedAppointmentId: appointment.id,
      relatedPetId: appointment.petId,
      createdAt,
      sentAt: createdAt,
    };

    const adminNoti: Notification = {
      id: createId("noti"),
      recipientRole: "admin",
      type: "appointment_rescheduled",
      title: "Yêu cầu dời lịch khám",
      message: `Lịch ${appointment.serviceName} của ${pet?.name ?? "Pet"} vừa yêu cầu dời sang ${action.payload.input.time} ngày ${action.payload.input.date}.`,
      status: "sent",
      actionUrl: "/admin/appointments",
      relatedAppointmentId: appointment.id,
      relatedPetId: appointment.petId,
      createdAt,
      sentAt: createdAt,
    };

    return { ...state, appointments: updatedAppointments, notifications: [adminNoti, ownerNoti, ...state.notifications] };
  }

  if (action.type === "UPDATE_APPOINTMENT_STATUS") {
    let changed: Appointment | undefined;
    const appointments = state.appointments.map((item) =>
      item.id === action.payload.appointmentId
        ? (changed = {
            ...item,
            status: action.payload.status,
            internalNote: action.payload.internalNote !== undefined ? action.payload.internalNote : item.internalNote,
            updatedAt: new Date().toISOString(),
          })
        : item
    );
    const notification = changed ? appointmentNotification(changed, action.payload.status) : null;
    return { ...state, appointments, notifications: notification ? [notification, ...state.notifications] : state.notifications };
  }

  if (action.type === "UPDATE_APPOINTMENT_INTERNAL_NOTE") {
    const appointments = state.appointments.map((item) =>
      item.id === action.payload.appointmentId
        ? { ...item, internalNote: action.payload.internalNote, updatedAt: new Date().toISOString() }
        : item
    );
    return { ...state, appointments };
  }

  if (action.type === "CREATE_HOTEL_BOOKING") {
    const pet = state.pets.find((item) => item.id === action.payload.petId);
    const owner = state.owners.find((item) => item.id === (pet?.ownerId ?? state.currentOwnerId));
    const nights = Math.max(calculateNights(action.payload.checkIn, action.payload.checkOut), 1);
    const createdAt = new Date().toISOString();
    const booking: HotelBooking = {
      id: createId("booking"),
      petId: action.payload.petId,
      ownerId: pet?.ownerId ?? state.currentOwnerId,
      checkIn: action.payload.checkIn,
      checkOut: action.payload.checkOut,
      nights,
      roomType: action.payload.roomType,
      serviceKeys: action.payload.serviceKeys,
      totalAmount: calculateBookingTotal(action.payload.roomType, action.payload.serviceKeys, nights),
      status: "pending",
      ownerNote: action.payload.ownerNote,
      dailyCareNoteIds: [],
      createdAt,
      updatedAt: createdAt,
    };

    const ownerNoti: Notification = {
      id: createId("noti"),
      recipientOwnerId: booking.ownerId,
      recipientRole: "owner",
      type: "hotel_booking_created",
      title: "Đã gửi yêu cầu hotel booking",
      message: `Yêu cầu lưu trú ${nights} đêm đang chờ bệnh viện xác nhận.`,
      status: "sent",
      actionUrl: "/owner/hotel-booking",
      relatedBookingId: booking.id,
      relatedPetId: booking.petId,
      createdAt,
      sentAt: createdAt,
    };

    const adminNoti: Notification = {
      id: createId("noti"),
      recipientRole: "admin",
      type: "hotel_booking_created",
      title: "Hotel booking mới",
      message: `Bệnh nhân ${pet?.name ?? "Pet"} (Chủ: ${owner?.fullName ?? "Khách hàng"}) vừa đặt phòng lưu trú ${nights} đêm (${booking.checkIn} → ${booking.checkOut}).`,
      status: "sent",
      actionUrl: "/admin/hotel-bookings",
      relatedBookingId: booking.id,
      relatedPetId: booking.petId,
      createdAt,
      sentAt: createdAt,
    };

    return { ...state, hotelBookings: [booking, ...state.hotelBookings], notifications: [adminNoti, ownerNoti, ...state.notifications] };
  }

  if (action.type === "CANCEL_HOTEL_BOOKING") {
    const booking = state.hotelBookings.find((item) => item.id === action.payload.bookingId);
    if (!booking || !["pending", "confirmed"].includes(booking.status)) return state;
    const pet = state.pets.find((item) => item.id === booking.petId);
    const createdAt = new Date().toISOString();
    const hotelBookings = state.hotelBookings.map((item) =>
      item.id === action.payload.bookingId
        ? {
            ...item,
            status: "cancelled" as const,
            ownerNote: action.payload.ownerNote ? `${item.ownerNote ? `${item.ownerNote} | ` : ""}Lý do hủy: ${action.payload.ownerNote}` : item.ownerNote,
            updatedAt: createdAt,
          }
        : item
    );

    const ownerNoti: Notification = {
      id: createId("noti"),
      recipientOwnerId: booking.ownerId,
      recipientRole: "owner",
      type: "hotel_booking_cancelled",
      title: "Hotel booking đã hủy",
      message: `Bạn đã hủy đặt phòng lưu trú từ ${booking.checkIn} đến ${booking.checkOut} thành công.`,
      status: "sent",
      actionUrl: "/owner/hotel-booking",
      relatedBookingId: booking.id,
      relatedPetId: booking.petId,
      createdAt,
      sentAt: createdAt,
    };

    const adminNoti: Notification = {
      id: createId("noti"),
      recipientRole: "admin",
      type: "hotel_booking_cancelled",
      title: "Hotel booking bị hủy",
      message: `Kỳ lưu trú của ${pet?.name ?? "Pet"} từ ${booking.checkIn} đến ${booking.checkOut} vừa bị hủy bởi chủ nuôi.`,
      status: "sent",
      actionUrl: "/admin/hotel-bookings",
      relatedBookingId: booking.id,
      relatedPetId: booking.petId,
      createdAt,
      sentAt: createdAt,
    };

    return { ...state, hotelBookings, notifications: [adminNoti, ownerNoti, ...state.notifications] };
  }

  if (action.type === "UPDATE_HOTEL_BOOKING_STATUS") {
    let changed: HotelBooking | undefined;
    const hotelBookings = state.hotelBookings.map((item) =>
      item.id === action.payload.bookingId
        ? (changed = {
            ...item,
            status: action.payload.status,
            internalNote: action.payload.internalNote !== undefined ? action.payload.internalNote : item.internalNote,
            updatedAt: new Date().toISOString(),
          })
        : item
    );
    const notification = changed ? bookingNotification(changed, action.payload.status) : null;
    return { ...state, hotelBookings, notifications: notification ? [notification, ...state.notifications] : state.notifications };
  }

  if (action.type === "UPDATE_HOTEL_BOOKING_INTERNAL_NOTE") {
    const hotelBookings = state.hotelBookings.map((item) =>
      item.id === action.payload.bookingId
        ? { ...item, internalNote: action.payload.internalNote, updatedAt: new Date().toISOString() }
        : item
    );
    return { ...state, hotelBookings };
  }

  if (action.type === "ADD_DAILY_CARE_NOTE") {
    const createdAt = new Date().toISOString();
    const careNoteId = createId("care_note");
    const booking = state.hotelBookings.find((b) => b.id === action.payload.bookingId);
    const newCareNote: DailyCareNote = {
      id: careNoteId,
      bookingId: action.payload.bookingId,
      date: new Date().toISOString().slice(0, 10),
      eatingStatus: action.payload.eatingStatus ?? "normal",
      mood: action.payload.mood ?? "calm",
      note: action.payload.note,
      visibleToOwner: action.payload.visibleToOwner ?? true,
      createdByStaffId: "staff_admin",
      createdAt,
    };

    const hotelBookings = state.hotelBookings.map((item) =>
      item.id === action.payload.bookingId
        ? { ...item, dailyCareNoteIds: [...item.dailyCareNoteIds, careNoteId], updatedAt: createdAt }
        : item
    );
    const notification: Notification = {
      id: createId("noti"),
      recipientOwnerId: booking?.ownerId ?? state.currentOwnerId,
      recipientRole: "owner",
      type: "hotel_daily_update",
      title: "Cập nhật tình trạng thú cưng",
      message: action.payload.note,
      status: "sent",
      actionUrl: "/owner/hotel-booking",
      relatedBookingId: action.payload.bookingId,
      relatedPetId: booking?.petId,
      sentByStaffId: "staff_admin",
      createdAt,
      sentAt: createdAt,
    };
    return {
      ...state,
      dailyCareNotes: [newCareNote, ...state.dailyCareNotes],
      hotelBookings,
      notifications: [notification, ...state.notifications],
    };
  }

  if (action.type === "SEND_REMINDER") {
    const appointment = state.appointments.find((a) => a.id === action.payload.appointmentId);
    if (!appointment) return state;
    const createdAt = new Date().toISOString();
    const notification: Notification = {
      id: createId("noti"),
      recipientOwnerId: appointment.ownerId,
      recipientRole: "owner",
      type: "appointment_reminder",
      title: "Nhắc lịch khám",
      message: `Nhắc nhở: Bạn có lịch ${appointment.serviceName} vào lúc ${appointment.time} ngày ${appointment.date} tại Bệnh viện Thú y Mỹ Đình.`,
      status: "sent",
      actionUrl: "/owner/appointments",
      relatedAppointmentId: appointment.id,
      relatedPetId: appointment.petId,
      sentByStaffId: "staff_admin",
      createdAt,
      sentAt: createdAt,
    };
    return { ...state, notifications: [notification, ...state.notifications] };
  }

  if (action.type === "SEND_CUSTOM_NOTIFICATION") {
    const createdAt = new Date().toISOString();
    const notification: Notification = {
      id: createId("noti"),
      recipientOwnerId: action.payload.recipientOwnerId,
      recipientRole: "owner",
      type: "general",
      title: action.payload.title,
      message: action.payload.message,
      status: "sent",
      actionUrl: "/owner/notifications",
      createdAt,
      sentAt: createdAt,
    };
    return { ...state, notifications: [notification, ...state.notifications] };
  }

  if (action.type === "MARK_NOTIFICATION_READ") {
    return { ...state, notifications: state.notifications.map((item) => (item.id === action.payload.notificationId ? { ...item, status: "read" } : item)) };
  }

  if (action.type === "MARK_ALL_NOTIFICATIONS_READ") {
    return {
      ...state,
      notifications: state.notifications.map((item) => {
        if (state.authRole === "admin" && item.recipientRole === "admin") {
          return { ...item, status: "read" };
        }
        if (state.authRole === "owner" && item.recipientOwnerId === state.currentOwnerId) {
          return { ...item, status: "read" };
        }
        return item;
      }),
    };
  }

  if (action.type === "DELETE_NOTIFICATION") {
    return {
      ...state,
      notifications: state.notifications.filter((item) => item.id !== action.payload.notificationId),
    };
  }

  return state;
}

function loadInitialState() {
  try {
    const persisted = localStorage.getItem(STORAGE_KEY);
    return persisted ? normalizeState(JSON.parse(persisted) as AppState) : initialState;
  } catch {
    return initialState;
  }
}

export function AppStoreProvider({ children }: AppStoreProviderProps) {
  const [state, dispatch] = useReducer(appStoreReducer, undefined, loadInitialState);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const value = useMemo<AppStoreValue>(() => {
    const currentOwner = state.owners.find((owner) => owner.id === state.currentOwnerId) ?? state.owners[0];
    return {
      ...state,
      isLoading,
      currentOwner,
      ownerPets: state.pets.filter((pet) => pet.ownerId === state.currentOwnerId),
      loginOwner: async (email, password) => {
        const owner = state.owners.find((item) => item.email?.trim().toLowerCase() === email.trim().toLowerCase());
        if (!owner) return false;
        const validPassword = await verifyPassword(password, owner.passwordHash, owner.passwordSalt);
        if (!validPassword) return false;
        dispatch({ type: "LOGIN_OWNER", payload: { email } });
        return true;
      },
      loginAdmin: async (username, password) => {
        const valid =
          username.trim().toLowerCase() === DEMO_ADMIN_USERNAME &&
          (await verifyPassword(password, DEMO_ADMIN_PASSWORD_HASH, DEMO_ADMIN_PASSWORD_SALT));
        if (valid) dispatch({ type: "LOGIN_ADMIN" });
        return valid;
      },
      logout: () => dispatch({ type: "LOGOUT" }),
      registerOwner: async (input) => dispatch({ type: "REGISTER_OWNER", payload: input }),
      createPet: (input) => dispatch({ type: "CREATE_PET", payload: input }),
      updatePet: (petId, input) => dispatch({ type: "UPDATE_PET", payload: { petId, input } }),
      submitRescueReport: (input) => dispatch({ type: "SUBMIT_RESCUE_REPORT", payload: input }),
      createHotelBooking: (input) => dispatch({ type: "CREATE_HOTEL_BOOKING", payload: input }),
      updateHotelBookingStatus: (bookingId, status, internalNote) => dispatch({ type: "UPDATE_HOTEL_BOOKING_STATUS", payload: { bookingId, status, internalNote } }),
      updateHotelBookingInternalNote: (bookingId, internalNote) => dispatch({ type: "UPDATE_HOTEL_BOOKING_INTERNAL_NOTE", payload: { bookingId, internalNote } }),
      cancelHotelBooking: (bookingId, ownerNote) => dispatch({ type: "CANCEL_HOTEL_BOOKING", payload: { bookingId, ownerNote } }),
      addDailyCareNote: (bookingId, note, eatingStatus, mood) =>
        dispatch({ type: "ADD_DAILY_CARE_NOTE", payload: { bookingId, note, eatingStatus, mood } }),
      createAppointment: (input) => dispatch({ type: "CREATE_APPOINTMENT", payload: input }),
      cancelAppointment: (appointmentId, ownerNote) => dispatch({ type: "CANCEL_APPOINTMENT", payload: { appointmentId, ownerNote } }),
      rescheduleAppointment: (appointmentId, input) => dispatch({ type: "RESCHEDULE_APPOINTMENT", payload: { appointmentId, input } }),
      updateAppointmentStatus: (appointmentId, status, internalNote) => dispatch({ type: "UPDATE_APPOINTMENT_STATUS", payload: { appointmentId, status, internalNote } }),
      updateAppointmentInternalNote: (appointmentId, internalNote) => dispatch({ type: "UPDATE_APPOINTMENT_INTERNAL_NOTE", payload: { appointmentId, internalNote } }),
      sendReminder: (appointmentId) => dispatch({ type: "SEND_REMINDER", payload: { appointmentId } }),
      createMedicalRecord: (input) => dispatch({ type: "CREATE_MEDICAL_RECORD", payload: input }),
      updateMedicalRecord: (recordId, input) => dispatch({ type: "UPDATE_MEDICAL_RECORD", payload: { recordId, input } }),
      deleteMedicalRecord: (recordId) => dispatch({ type: "DELETE_MEDICAL_RECORD", payload: { recordId } }),
      uploadMedicalImage: (input) => dispatch({ type: "UPLOAD_MEDICAL_IMAGE", payload: input }),
      deleteMedicalImage: (imageId) => dispatch({ type: "DELETE_MEDICAL_IMAGE", payload: { imageId } }),
      markNotificationRead: (notificationId) => dispatch({ type: "MARK_NOTIFICATION_READ", payload: { notificationId } }),
      markAllNotificationsRead: () => dispatch({ type: "MARK_ALL_NOTIFICATIONS_READ" }),
      deleteNotification: (notificationId) => dispatch({ type: "DELETE_NOTIFICATION", payload: { notificationId } }),
      sendCustomNotification: (recipientOwnerId, title, message) => dispatch({ type: "SEND_CUSTOM_NOTIFICATION", payload: { recipientOwnerId, title, message } }),
      resetStoreData: () => dispatch({ type: "RESET_STORE_DATA" }),
    };
  }, [state, isLoading]);

  return <AppStoreContext.Provider value={value}>{children}</AppStoreContext.Provider>;
}

export function useAppStore() {
  const context = useContext(AppStoreContext);
  if (!context) throw new Error("useAppStore must be used within AppStoreProvider");
  return context;
}
