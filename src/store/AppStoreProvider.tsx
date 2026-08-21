import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import type { Appointment, AppointmentStatus, AppointmentType } from "../types/appointment";
import type { HotelBooking, HotelBookingStatus } from "../types/booking";
import type { MedicalRecord } from "../types/medicalRecord";
import type { Notification } from "../types/notification";
import type { Owner } from "../types/owner";
import type { Pet } from "../types/pet";
import { calculateBookingTotal, calculateNights } from "../utils/bookingCalculator";
import { createId } from "../utils/id";

type AppStoreProviderProps = { children: ReactNode };

type CreateHotelBookingInput = { petId: string; checkIn: string; checkOut: string; roomType: HotelBooking["roomType"]; serviceKeys: HotelBooking["serviceKeys"]; ownerNote?: string };
type CreateAppointmentInput = { petId: string; type: AppointmentType; serviceName: string; date: string; time: string; doctorId?: string; ownerNote?: string };
type CreateMedicalRecordInput = Omit<MedicalRecord, "id" | "ownerId" | "createdAt" | "updatedAt">;

type AppState = { currentOwnerId: string; owners: Owner[]; pets: Pet[]; appointments: Appointment[]; medicalRecords: MedicalRecord[]; hotelBookings: HotelBooking[]; notifications: Notification[] };

type AppAction =
  | { type: "CREATE_HOTEL_BOOKING"; payload: CreateHotelBookingInput }
  | { type: "UPDATE_HOTEL_BOOKING_STATUS"; payload: { bookingId: string; status: HotelBookingStatus; internalNote?: string } }
  | { type: "CREATE_APPOINTMENT"; payload: CreateAppointmentInput }
  | { type: "UPDATE_APPOINTMENT_STATUS"; payload: { appointmentId: string; status: AppointmentStatus; internalNote?: string } }
  | { type: "CREATE_MEDICAL_RECORD"; payload: CreateMedicalRecordInput }
  | { type: "MARK_NOTIFICATION_READ"; payload: { notificationId: string } }
  | { type: "MARK_ALL_NOTIFICATIONS_READ" };

type AppStoreValue = AppState & {
  currentOwner: Owner;
  ownerPets: Pet[];
  createHotelBooking: (input: CreateHotelBookingInput) => void;
  updateHotelBookingStatus: (bookingId: string, status: HotelBookingStatus, internalNote?: string) => void;
  createAppointment: (input: CreateAppointmentInput) => void;
  updateAppointmentStatus: (appointmentId: string, status: AppointmentStatus, internalNote?: string) => void;
  createMedicalRecord: (input: CreateMedicalRecordInput) => void;
  markNotificationRead: (notificationId: string) => void;
  markAllNotificationsRead: () => void;
};

const STORAGE_KEY = "niponeto_app_state";
const now = new Date().toISOString();

const initialState: AppState = {
  currentOwnerId: "owner_1",
  owners: [{ id: "owner_1", fullName: "Nguyễn Văn A", phone: "0901234567", email: "owner@example.com", address: "Mỹ Đình, Hà Nội", petIds: ["pet_mochi", "pet_yuki"] }],
  pets: [
    { id: "pet_mochi", ownerId: "owner_1", name: "Mochi", species: "dog", breed: "Shiba Inu", gender: "male", ageLabel: "2 tuổi", weightKg: 8.4, microchipId: "JP-2026-MOCHI", healthStatus: "healthy", allergies: ["Không"] },
    { id: "pet_yuki", ownerId: "owner_1", name: "Yuki", species: "dog", breed: "Shiba Inu", gender: "female", ageLabel: "1 tuổi", weightKg: 7.2, microchipId: "JP-2026-YUKI", healthStatus: "stable", allergies: ["Thịt bò"] },
    { id: "pet_sashimi", ownerId: "owner_2", name: "Sashimi", species: "cat", breed: "Scottish Fold", gender: "female", ageLabel: "1 tuổi", weightKg: 4.1, healthStatus: "vaccination_due" },
  ],
  appointments: [
    { id: "appointment_1", petId: "pet_mochi", ownerId: "owner_1", doctorId: "doctor_mai", type: "general_checkup", serviceName: "Khám tổng quát", clinicName: "Bệnh viện Thú y Mỹ Đình", date: "2026-11-02", time: "09:00", status: "confirmed", createdBy: "owner", createdAt: now, updatedAt: now },
    { id: "appointment_2", petId: "pet_yuki", ownerId: "owner_1", doctorId: "doctor_sato", type: "vaccination", serviceName: "Tiêm phòng", clinicName: "Bệnh viện Thú y Mỹ Đình", date: "2026-11-03", time: "10:30", status: "pending", ownerNote: "Ưu tiên buổi sáng.", createdBy: "owner", createdAt: now, updatedAt: now },
  ],
  medicalRecords: [
    { id: "record_1", petId: "pet_mochi", ownerId: "owner_1", appointmentId: "appointment_1", doctorName: "Bs. Mai Nguyễn", visitDate: "2026-10-28", title: "Annual Checkup & Vaccination", symptoms: "Khám định kỳ, không có triệu chứng bất thường.", diagnosis: "Sức khỏe ổn định, cân nặng phù hợp giống Shiba Inu.", treatment: "Tiêm vaccine nhắc lại và tư vấn dinh dưỡng.", medications: "Vitamin tổng hợp 7 ngày", vaccineName: "DHPPi + Lepto", followUpDate: "2027-04-28", weightKg: 8.4, temperatureC: 38.2, heartRateBpm: 92, createdAt: now, updatedAt: now },
    { id: "record_2", petId: "pet_yuki", ownerId: "owner_1", doctorName: "Dr. Kenji Sato", visitDate: "2026-10-14", title: "Dermatology Consult", symptoms: "Ngứa nhẹ sau khi đổi thức ăn.", diagnosis: "Nghi dị ứng protein bò.", treatment: "Ngưng thức ăn chứa bò, theo dõi da trong 14 ngày.", medications: "Sữa tắm dịu nhẹ 2 lần/tuần", followUpDate: "2026-11-14", weightKg: 7.2, temperatureC: 38.4, heartRateBpm: 96, createdAt: now, updatedAt: now },
  ],
  hotelBookings: [
    { id: "booking_1", petId: "pet_yuki", ownerId: "owner_1", checkIn: "2026-11-10", checkOut: "2026-11-13", nights: 3, roomType: "deluxe", serviceKeys: ["special_diet"], totalAmount: 20100, status: "pending", ownerNote: "Yuki cần chế độ ăn ít muối.", dailyCareNoteIds: [], createdAt: now, updatedAt: now },
    { id: "booking_2", petId: "pet_mochi", ownerId: "owner_1", checkIn: "2026-11-18", checkOut: "2026-11-20", nights: 2, roomType: "standard", serviceKeys: ["daily_walk"], totalAmount: 7600, status: "confirmed", dailyCareNoteIds: [], createdAt: now, updatedAt: now },
  ],
  notifications: [
    { id: "noti_1", recipientOwnerId: "owner_1", type: "appointment_reminder", title: "Nhắc lịch khám", message: "Mochi có lịch khám vào 09:00 ngày mai tại Bệnh viện Thú y Mỹ Đình.", status: "sent", relatedPetId: "pet_mochi", relatedAppointmentId: "appointment_1", createdAt: now, sentAt: now },
    { id: "noti_2", recipientOwnerId: "owner_1", type: "vaccination_reminder", title: "Nhắc tiêm phòng", message: "Yuki cần tiêm phòng nhắc lại trong tuần này.", status: "sent", relatedPetId: "pet_yuki", createdAt: now, sentAt: now },
  ],
};

const AppStoreContext = createContext<AppStoreValue | null>(null);

function appointmentNotification(appointment: Appointment, status: AppointmentStatus): Notification | null {
  const createdAt = new Date().toISOString();
  if (status === "confirmed") return { id: createId("noti"), recipientOwnerId: appointment.ownerId, type: "appointment_confirmed", title: "Lịch khám đã được xác nhận", message: `Lịch ${appointment.serviceName} lúc ${appointment.time} ngày ${appointment.date} đã được xác nhận.`, status: "sent", relatedAppointmentId: appointment.id, relatedPetId: appointment.petId, sentByStaffId: "staff_admin", createdAt, sentAt: createdAt };
  if (status === "cancelled") return { id: createId("noti"), recipientOwnerId: appointment.ownerId, type: "appointment_cancelled", title: "Lịch khám đã bị hủy", message: `Lịch ${appointment.serviceName} ngày ${appointment.date} chưa thể thực hiện. Vui lòng chọn thời gian khác.`, status: "sent", relatedAppointmentId: appointment.id, relatedPetId: appointment.petId, sentByStaffId: "staff_admin", createdAt, sentAt: createdAt };
  if (status === "completed") return { id: createId("noti"), recipientOwnerId: appointment.ownerId, type: "medical_record_updated", title: "Lịch khám đã hoàn thành", message: `Lịch khám ${appointment.serviceName} đã hoàn thành. Hồ sơ y tế sẽ được cập nhật.`, status: "sent", relatedAppointmentId: appointment.id, relatedPetId: appointment.petId, sentByStaffId: "staff_admin", createdAt, sentAt: createdAt };
  return null;
}

function bookingNotification(booking: HotelBooking, status: HotelBookingStatus): Notification | null {
  const createdAt = new Date().toISOString();
  if (status === "confirmed") return { id: createId("noti"), recipientOwnerId: booking.ownerId, type: "hotel_booking_confirmed", title: "Hotel booking đã được xác nhận", message: `Yêu cầu lưu trú từ ${booking.checkIn} đến ${booking.checkOut} đã được bệnh viện xác nhận.`, status: "sent", relatedBookingId: booking.id, relatedPetId: booking.petId, sentByStaffId: "staff_admin", createdAt, sentAt: createdAt };
  if (status === "rejected") return { id: createId("noti"), recipientOwnerId: booking.ownerId, type: "general", title: "Hotel booking bị từ chối", message: `Yêu cầu lưu trú từ ${booking.checkIn} đến ${booking.checkOut} chưa thể xác nhận. Vui lòng chọn ngày/phòng khác.`, status: "sent", relatedBookingId: booking.id, relatedPetId: booking.petId, sentByStaffId: "staff_admin", createdAt, sentAt: createdAt };
  return null;
}

function medicalRecordNotification(record: MedicalRecord): Notification {
  const createdAt = new Date().toISOString();
  return { id: createId("noti"), recipientOwnerId: record.ownerId, type: "medical_record_updated", title: "Hồ sơ y tế mới đã được cập nhật", message: `Bác sĩ đã cập nhật hồ sơ ${record.title} ngày ${record.visitDate}. Bạn có thể xem chi tiết trong mục Medical Records.`, status: "sent", relatedAppointmentId: record.appointmentId, relatedPetId: record.petId, sentByStaffId: "staff_admin", createdAt, sentAt: createdAt };
}

function normalizeState(state: AppState): AppState {
  return { ...initialState, ...state, appointments: state.appointments ?? initialState.appointments, medicalRecords: state.medicalRecords ?? initialState.medicalRecords, hotelBookings: state.hotelBookings ?? initialState.hotelBookings, notifications: state.notifications ?? initialState.notifications };
}

function appStoreReducer(state: AppState, action: AppAction): AppState {
  if (action.type === "CREATE_MEDICAL_RECORD") {
    const pet = state.pets.find((item) => item.id === action.payload.petId);
    const createdAt = new Date().toISOString();
    const record: MedicalRecord = { ...action.payload, id: createId("record"), ownerId: pet?.ownerId ?? state.currentOwnerId, createdAt, updatedAt: createdAt };
    const updatedAppointments = record.appointmentId ? state.appointments.map((appointment) => appointment.id === record.appointmentId ? { ...appointment, status: "completed" as const, updatedAt: createdAt } : appointment) : state.appointments;
    return { ...state, appointments: updatedAppointments, medicalRecords: [record, ...state.medicalRecords], notifications: [medicalRecordNotification(record), ...state.notifications] };
  }

  if (action.type === "CREATE_APPOINTMENT") {
    const pet = state.pets.find((item) => item.id === action.payload.petId);
    const createdAt = new Date().toISOString();
    const appointment: Appointment = { id: createId("appointment"), petId: action.payload.petId, ownerId: pet?.ownerId ?? state.currentOwnerId, doctorId: action.payload.doctorId, type: action.payload.type, serviceName: action.payload.serviceName, clinicName: "Bệnh viện Thú y Mỹ Đình", date: action.payload.date, time: action.payload.time, status: "pending", ownerNote: action.payload.ownerNote, createdBy: "owner", createdAt, updatedAt: createdAt };
    const notification: Notification = { id: createId("noti"), recipientOwnerId: appointment.ownerId, type: "appointment_reminder", title: "Đã gửi yêu cầu đặt lịch", message: `Lịch ${appointment.serviceName} lúc ${appointment.time} ngày ${appointment.date} đang chờ xác nhận.`, status: "sent", relatedAppointmentId: appointment.id, relatedPetId: appointment.petId, createdAt, sentAt: createdAt };
    return { ...state, appointments: [appointment, ...state.appointments], notifications: [notification, ...state.notifications] };
  }
  if (action.type === "UPDATE_APPOINTMENT_STATUS") {
    let changed: Appointment | undefined;
    const appointments = state.appointments.map((item) => item.id === action.payload.appointmentId ? (changed = { ...item, status: action.payload.status, internalNote: action.payload.internalNote, updatedAt: new Date().toISOString() }) : item);
    const notification = changed ? appointmentNotification(changed, action.payload.status) : null;
    return { ...state, appointments, notifications: notification ? [notification, ...state.notifications] : state.notifications };
  }
  if (action.type === "CREATE_HOTEL_BOOKING") {
    const pet = state.pets.find((item) => item.id === action.payload.petId);
    const nights = Math.max(calculateNights(action.payload.checkIn, action.payload.checkOut), 1);
    const createdAt = new Date().toISOString();
    const booking: HotelBooking = { id: createId("booking"), petId: action.payload.petId, ownerId: pet?.ownerId ?? state.currentOwnerId, checkIn: action.payload.checkIn, checkOut: action.payload.checkOut, nights, roomType: action.payload.roomType, serviceKeys: action.payload.serviceKeys, totalAmount: calculateBookingTotal(action.payload.roomType, action.payload.serviceKeys, nights), status: "pending", ownerNote: action.payload.ownerNote, dailyCareNoteIds: [], createdAt, updatedAt: createdAt };
    const notification: Notification = { id: createId("noti"), recipientOwnerId: booking.ownerId, type: "hotel_booking_created", title: "Đã gửi yêu cầu hotel booking", message: `Yêu cầu lưu trú ${nights} đêm đang chờ bệnh viện xác nhận.`, status: "sent", relatedBookingId: booking.id, relatedPetId: booking.petId, createdAt, sentAt: createdAt };
    return { ...state, hotelBookings: [booking, ...state.hotelBookings], notifications: [notification, ...state.notifications] };
  }
  if (action.type === "UPDATE_HOTEL_BOOKING_STATUS") {
    let changed: HotelBooking | undefined;
    const hotelBookings = state.hotelBookings.map((item) => item.id === action.payload.bookingId ? (changed = { ...item, status: action.payload.status, internalNote: action.payload.internalNote, updatedAt: new Date().toISOString() }) : item);
    const notification = changed ? bookingNotification(changed, action.payload.status) : null;
    return { ...state, hotelBookings, notifications: notification ? [notification, ...state.notifications] : state.notifications };
  }
  if (action.type === "MARK_NOTIFICATION_READ") return { ...state, notifications: state.notifications.map((item) => item.id === action.payload.notificationId ? { ...item, status: "read" } : item) };
  if (action.type === "MARK_ALL_NOTIFICATIONS_READ") return { ...state, notifications: state.notifications.map((item) => item.recipientOwnerId === state.currentOwnerId ? { ...item, status: "read" } : item) };
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
  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }, [state]);
  const value = useMemo<AppStoreValue>(() => {
    const currentOwner = state.owners.find((owner) => owner.id === state.currentOwnerId) ?? state.owners[0];
    return { ...state, currentOwner, ownerPets: state.pets.filter((pet) => pet.ownerId === state.currentOwnerId), createHotelBooking: (input) => dispatch({ type: "CREATE_HOTEL_BOOKING", payload: input }), updateHotelBookingStatus: (bookingId, status, internalNote) => dispatch({ type: "UPDATE_HOTEL_BOOKING_STATUS", payload: { bookingId, status, internalNote } }), createAppointment: (input) => dispatch({ type: "CREATE_APPOINTMENT", payload: input }), updateAppointmentStatus: (appointmentId, status, internalNote) => dispatch({ type: "UPDATE_APPOINTMENT_STATUS", payload: { appointmentId, status, internalNote } }), createMedicalRecord: (input) => dispatch({ type: "CREATE_MEDICAL_RECORD", payload: input }), markNotificationRead: (notificationId) => dispatch({ type: "MARK_NOTIFICATION_READ", payload: { notificationId } }), markAllNotificationsRead: () => dispatch({ type: "MARK_ALL_NOTIFICATIONS_READ" }) };
  }, [state]);
  return <AppStoreContext.Provider value={value}>{children}</AppStoreContext.Provider>;
}

export function useAppStore() {
  const context = useContext(AppStoreContext);
  if (!context) throw new Error("useAppStore must be used within AppStoreProvider");
  return context;
}
