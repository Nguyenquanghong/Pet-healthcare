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
type RegisterOwnerInput = Omit<Owner, "id" | "petIds">;
type CreatePetInput = Omit<Pet, "id" | "ownerId">;
type UpdatePetInput = Partial<Omit<Pet, "id" | "ownerId">>;
type AuthRole = "owner" | "admin" | null;

type AppState = { authRole: AuthRole; currentOwnerId: string; owners: Owner[]; pets: Pet[]; appointments: Appointment[]; medicalRecords: MedicalRecord[]; hotelBookings: HotelBooking[]; notifications: Notification[] };

type AppAction =
  | { type: "REGISTER_OWNER"; payload: RegisterOwnerInput }
  | { type: "LOGIN_OWNER"; payload: { phone: string } }
  | { type: "LOGIN_ADMIN" }
  | { type: "LOGOUT" }
  | { type: "CREATE_PET"; payload: CreatePetInput }
  | { type: "UPDATE_PET"; payload: { petId: string; input: UpdatePetInput } }
  | { type: "CREATE_HOTEL_BOOKING"; payload: CreateHotelBookingInput }
  | { type: "UPDATE_HOTEL_BOOKING_STATUS"; payload: { bookingId: string; status: HotelBookingStatus; internalNote?: string } }
  | { type: "ADD_DAILY_CARE_NOTE"; payload: { bookingId: string; note: string } }
  | { type: "CREATE_APPOINTMENT"; payload: CreateAppointmentInput }
  | { type: "UPDATE_APPOINTMENT_STATUS"; payload: { appointmentId: string; status: AppointmentStatus; internalNote?: string } }
  | { type: "SEND_REMINDER"; payload: { appointmentId: string } }
  | { type: "CREATE_MEDICAL_RECORD"; payload: CreateMedicalRecordInput }
  | { type: "MARK_NOTIFICATION_READ"; payload: { notificationId: string } }
  | { type: "MARK_ALL_NOTIFICATIONS_READ" }
  | { type: "SEND_CUSTOM_NOTIFICATION"; payload: { recipientOwnerId: string; title: string; message: string } };

type AppStoreValue = AppState & {
  currentOwner: Owner;
  ownerPets: Pet[];
  loginOwner: (phone: string) => boolean;
  loginAdmin: (username: string, password: string) => boolean;
  logout: () => void;
  registerOwner: (input: RegisterOwnerInput) => void;
  createPet: (input: CreatePetInput) => void;
  updatePet: (petId: string, input: UpdatePetInput) => void;
  createHotelBooking: (input: CreateHotelBookingInput) => void;
  updateHotelBookingStatus: (bookingId: string, status: HotelBookingStatus, internalNote?: string) => void;
  addDailyCareNote: (bookingId: string, note: string) => void;
  createAppointment: (input: CreateAppointmentInput) => void;
  updateAppointmentStatus: (appointmentId: string, status: AppointmentStatus, internalNote?: string) => void;
  sendReminder: (appointmentId: string) => void;
  createMedicalRecord: (input: CreateMedicalRecordInput) => void;
  markNotificationRead: (notificationId: string) => void;
  markAllNotificationsRead: () => void;
  sendCustomNotification: (recipientOwnerId: string, title: string, message: string) => void;
};

const STORAGE_KEY = "niponeto_app_state";
const now = new Date().toISOString();

const initialState: AppState = {
  authRole: null,
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
  if (action.type === "REGISTER_OWNER") {
    const owner: Owner = { id: createId("owner"), ...action.payload, petIds: [] };
    const createdAt = new Date().toISOString();
    const notification: Notification = {
      id: createId("noti"),
      recipientOwnerId: owner.id,
      type: "general",
      title: "Chào mừng đến với Nippon Pet Care",
      message: "Tài khoản chủ nuôi của bạn đã được tạo. Bạn có thể cập nhật hồ sơ thú cưng và đặt lịch dịch vụ ngay bây giờ.",
      status: "sent",
      createdAt,
      sentAt: createdAt,
    };
    return { ...state, authRole: "owner", currentOwnerId: owner.id, owners: [owner, ...state.owners], notifications: [notification, ...state.notifications] };
  }

  if (action.type === "LOGIN_OWNER") {
    const owner = state.owners.find((item) => item.phone.trim() === action.payload.phone.trim());
    return owner ? { ...state, authRole: "owner", currentOwnerId: owner.id } : state;
  }

  if (action.type === "LOGIN_ADMIN") return { ...state, authRole: "admin" };

  if (action.type === "LOGOUT") return { ...state, authRole: null };

  if (action.type === "CREATE_PET") {
    const pet: Pet = { id: createId("pet"), ownerId: state.currentOwnerId, ...action.payload };
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
          ? { ...pet, ...action.payload.input }
          : pet,
      ),
    };
  }

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
  if (action.type === "ADD_DAILY_CARE_NOTE") {
    const createdAt = new Date().toISOString();
    const noteId = `note_${Date.now()}`;
    const hotelBookings = state.hotelBookings.map((item) =>
      item.id === action.payload.bookingId
        ? { ...item, dailyCareNoteIds: [...item.dailyCareNoteIds, noteId], updatedAt: createdAt }
        : item
    );
    const booking = state.hotelBookings.find(b => b.id === action.payload.bookingId);
    const notification: Notification = { id: `noti_${Date.now()}`, recipientOwnerId: booking?.ownerId ?? state.currentOwnerId, type: "hotel_daily_update", title: "Cập nhật tình trạng thú cưng", message: action.payload.note, status: "sent", relatedBookingId: action.payload.bookingId, relatedPetId: booking?.petId, sentByStaffId: "staff_admin", createdAt, sentAt: createdAt };
    return { ...state, hotelBookings, notifications: [notification, ...state.notifications] };
  }
  if (action.type === "SEND_REMINDER") {
    const appointment = state.appointments.find(a => a.id === action.payload.appointmentId);
    if (!appointment) return state;
    const createdAt = new Date().toISOString();
    const notification: Notification = { id: `noti_${Date.now()}`, recipientOwnerId: appointment.ownerId, type: "appointment_reminder", title: "Nhắc lịch khám", message: `Nhắc nhở: Bạn có lịch ${appointment.serviceName} vào lúc ${appointment.time} ngày ${appointment.date} tại Bệnh viện Thú y Mỹ Đình.`, status: "sent", relatedAppointmentId: appointment.id, relatedPetId: appointment.petId, sentByStaffId: "staff_admin", createdAt, sentAt: createdAt };
    return { ...state, notifications: [notification, ...state.notifications] };
  }
  if (action.type === "SEND_CUSTOM_NOTIFICATION") {
    const createdAt = new Date().toISOString();
    const notification: Notification = { id: `noti_${Date.now()}`, recipientOwnerId: action.payload.recipientOwnerId, type: "general", title: action.payload.title, message: action.payload.message, status: "sent", createdAt, sentAt: createdAt };
    return { ...state, notifications: [notification, ...state.notifications] };
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
    return {
      ...state,
      currentOwner,
      ownerPets: state.pets.filter((pet) => pet.ownerId === state.currentOwnerId),
      loginOwner: (phone) => {
        const owner = state.owners.find((item) => item.phone.trim() === phone.trim());
        if (!owner) return false;
        dispatch({ type: "LOGIN_OWNER", payload: { phone } });
        return true;
      },
      loginAdmin: (username, password) => {
        const valid = username.trim().toLowerCase() === "admin" && password === "admin123";
        if (valid) dispatch({ type: "LOGIN_ADMIN" });
        return valid;
      },
      logout: () => dispatch({ type: "LOGOUT" }),
      registerOwner: (input) => dispatch({ type: "REGISTER_OWNER", payload: input }),
      createPet: (input) => dispatch({ type: "CREATE_PET", payload: input }),
      updatePet: (petId, input) => dispatch({ type: "UPDATE_PET", payload: { petId, input } }),
      createHotelBooking: (input) => dispatch({ type: "CREATE_HOTEL_BOOKING", payload: input }),
      updateHotelBookingStatus: (bookingId, status, internalNote) => dispatch({ type: "UPDATE_HOTEL_BOOKING_STATUS", payload: { bookingId, status, internalNote } }),
      addDailyCareNote: (bookingId, note) => dispatch({ type: "ADD_DAILY_CARE_NOTE", payload: { bookingId, note } }),
      createAppointment: (input) => dispatch({ type: "CREATE_APPOINTMENT", payload: input }),
      updateAppointmentStatus: (appointmentId, status, internalNote) => dispatch({ type: "UPDATE_APPOINTMENT_STATUS", payload: { appointmentId, status, internalNote } }),
      sendReminder: (appointmentId) => dispatch({ type: "SEND_REMINDER", payload: { appointmentId } }),
      createMedicalRecord: (input) => dispatch({ type: "CREATE_MEDICAL_RECORD", payload: input }),
      markNotificationRead: (notificationId) => dispatch({ type: "MARK_NOTIFICATION_READ", payload: { notificationId } }),
      markAllNotificationsRead: () => dispatch({ type: "MARK_ALL_NOTIFICATIONS_READ" }),
      sendCustomNotification: (recipientOwnerId, title, message) => dispatch({ type: "SEND_CUSTOM_NOTIFICATION", payload: { recipientOwnerId, title, message } }),
    };
  }, [state]);
  return <AppStoreContext.Provider value={value}>{children}</AppStoreContext.Provider>;
}

export function useAppStore() {
  const context = useContext(AppStoreContext);
  if (!context) throw new Error("useAppStore must be used within AppStoreProvider");
  return context;
}
