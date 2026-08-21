import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import type { HotelBooking, HotelBookingStatus } from "../types/booking";
import type { Notification } from "../types/notification";
import type { Owner } from "../types/owner";
import type { Pet } from "../types/pet";
import { calculateBookingTotal, calculateNights } from "../utils/bookingCalculator";
import { createId } from "../utils/id";

type AppStoreProviderProps = {
  children: ReactNode;
};

type CreateHotelBookingInput = {
  petId: string;
  checkIn: string;
  checkOut: string;
  roomType: HotelBooking["roomType"];
  serviceKeys: HotelBooking["serviceKeys"];
  ownerNote?: string;
};

type AppState = {
  currentOwnerId: string;
  owners: Owner[];
  pets: Pet[];
  hotelBookings: HotelBooking[];
  notifications: Notification[];
};

type AppAction =
  | { type: "CREATE_HOTEL_BOOKING"; payload: CreateHotelBookingInput }
  | { type: "UPDATE_HOTEL_BOOKING_STATUS"; payload: { bookingId: string; status: HotelBookingStatus; internalNote?: string } }
  | { type: "MARK_NOTIFICATION_READ"; payload: { notificationId: string } }
  | { type: "MARK_ALL_NOTIFICATIONS_READ" };

type AppStoreValue = AppState & {
  currentOwner: Owner;
  ownerPets: Pet[];
  createHotelBooking: (input: CreateHotelBookingInput) => void;
  updateHotelBookingStatus: (bookingId: string, status: HotelBookingStatus, internalNote?: string) => void;
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
  hotelBookings: [
    { id: "booking_1", petId: "pet_yuki", ownerId: "owner_1", checkIn: "2026-11-10", checkOut: "2026-11-13", nights: 3, roomType: "deluxe", serviceKeys: ["special_diet"], totalAmount: 20100, status: "pending", ownerNote: "Yuki cần chế độ ăn ít muối.", dailyCareNoteIds: [], createdAt: now, updatedAt: now },
    { id: "booking_2", petId: "pet_mochi", ownerId: "owner_1", checkIn: "2026-11-18", checkOut: "2026-11-20", nights: 2, roomType: "standard", serviceKeys: ["daily_walk"], totalAmount: 7600, status: "confirmed", dailyCareNoteIds: [], createdAt: now, updatedAt: now },
  ],
  notifications: [
    { id: "noti_1", recipientOwnerId: "owner_1", type: "appointment_reminder", title: "Nhắc lịch khám", message: "Mochi có lịch khám vào 09:00 ngày mai tại Bệnh viện Thú y Mỹ Đình.", status: "sent", relatedPetId: "pet_mochi", createdAt: now, sentAt: now },
    { id: "noti_2", recipientOwnerId: "owner_1", type: "vaccination_reminder", title: "Nhắc tiêm phòng", message: "Sashimi cần tiêm phòng nhắc lại trong tuần này.", status: "sent", relatedPetId: "pet_sashimi", createdAt: now, sentAt: now },
  ],
};

const AppStoreContext = createContext<AppStoreValue | null>(null);

function createBookingNotification(booking: HotelBooking, status: HotelBookingStatus): Notification | null {
  if (status === "confirmed") return { id: createId("noti"), recipientOwnerId: booking.ownerId, type: "hotel_booking_confirmed", title: "Hotel booking đã được xác nhận", message: `Yêu cầu lưu trú từ ${booking.checkIn} đến ${booking.checkOut} đã được bệnh viện xác nhận.`, status: "sent", relatedBookingId: booking.id, relatedPetId: booking.petId, sentByStaffId: "staff_admin", createdAt: new Date().toISOString(), sentAt: new Date().toISOString() };
  if (status === "rejected") return { id: createId("noti"), recipientOwnerId: booking.ownerId, type: "general", title: "Hotel booking bị từ chối", message: `Yêu cầu lưu trú từ ${booking.checkIn} đến ${booking.checkOut} chưa thể xác nhận. Vui lòng chọn ngày/phòng khác.`, status: "sent", relatedBookingId: booking.id, relatedPetId: booking.petId, sentByStaffId: "staff_admin", createdAt: new Date().toISOString(), sentAt: new Date().toISOString() };
  return null;
}

function appStoreReducer(state: AppState, action: AppAction): AppState {
  if (action.type === "CREATE_HOTEL_BOOKING") {
    const pet = state.pets.find((item) => item.id === action.payload.petId);
    const nights = Math.max(calculateNights(action.payload.checkIn, action.payload.checkOut), 1);
    const createdAt = new Date().toISOString();
    const booking: HotelBooking = { id: createId("booking"), petId: action.payload.petId, ownerId: pet?.ownerId ?? state.currentOwnerId, checkIn: action.payload.checkIn, checkOut: action.payload.checkOut, nights, roomType: action.payload.roomType, serviceKeys: action.payload.serviceKeys, totalAmount: calculateBookingTotal(action.payload.roomType, action.payload.serviceKeys, nights), status: "pending", ownerNote: action.payload.ownerNote, dailyCareNoteIds: [], createdAt, updatedAt: createdAt };
    const notification: Notification = { id: createId("noti"), recipientOwnerId: booking.ownerId, type: "hotel_booking_created", title: "Đã gửi yêu cầu hotel booking", message: `Yêu cầu lưu trú ${nights} đêm đang chờ bệnh viện xác nhận.`, status: "sent", relatedBookingId: booking.id, relatedPetId: booking.petId, createdAt, sentAt: createdAt };
    return { ...state, hotelBookings: [booking, ...state.hotelBookings], notifications: [notification, ...state.notifications] };
  }

  if (action.type === "UPDATE_HOTEL_BOOKING_STATUS") {
    let changedBooking: HotelBooking | undefined;
    const hotelBookings = state.hotelBookings.map((booking) => {
      if (booking.id !== action.payload.bookingId) return booking;
      changedBooking = { ...booking, status: action.payload.status, internalNote: action.payload.internalNote, updatedAt: new Date().toISOString() };
      return changedBooking;
    });
    const notification = changedBooking ? createBookingNotification(changedBooking, action.payload.status) : null;
    return { ...state, hotelBookings, notifications: notification ? [notification, ...state.notifications] : state.notifications };
  }

  if (action.type === "MARK_NOTIFICATION_READ") return { ...state, notifications: state.notifications.map((item) => item.id === action.payload.notificationId ? { ...item, status: "read" } : item) };
  if (action.type === "MARK_ALL_NOTIFICATIONS_READ") return { ...state, notifications: state.notifications.map((item) => item.recipientOwnerId === state.currentOwnerId ? { ...item, status: "read" } : item) };
  return state;
}

function loadInitialState() {
  try {
    const persisted = localStorage.getItem(STORAGE_KEY);
    return persisted ? JSON.parse(persisted) as AppState : initialState;
  } catch {
    return initialState;
  }
}

export function AppStoreProvider({ children }: AppStoreProviderProps) {
  const [state, dispatch] = useReducer(appStoreReducer, undefined, loadInitialState);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const value = useMemo<AppStoreValue>(() => {
    const currentOwner = state.owners.find((owner) => owner.id === state.currentOwnerId) ?? state.owners[0];
    return {
      ...state,
      currentOwner,
      ownerPets: state.pets.filter((pet) => pet.ownerId === state.currentOwnerId),
      createHotelBooking: (input) => dispatch({ type: "CREATE_HOTEL_BOOKING", payload: input }),
      updateHotelBookingStatus: (bookingId, status, internalNote) => dispatch({ type: "UPDATE_HOTEL_BOOKING_STATUS", payload: { bookingId, status, internalNote } }),
      markNotificationRead: (notificationId) => dispatch({ type: "MARK_NOTIFICATION_READ", payload: { notificationId } }),
      markAllNotificationsRead: () => dispatch({ type: "MARK_ALL_NOTIFICATIONS_READ" }),
    };
  }, [state]);

  return <AppStoreContext.Provider value={value}>{children}</AppStoreContext.Provider>;
}

export function useAppStore() {
  const context = useContext(AppStoreContext);
  if (!context) throw new Error("useAppStore must be used within AppStoreProvider");
  return context;
}