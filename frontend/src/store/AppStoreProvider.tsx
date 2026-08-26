import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Appointment, AppointmentStatus, AppointmentType } from "../types/appointment";
import type { DailyCareNote, HotelBooking, HotelBookingStatus } from "../types/booking";
import type { MedicalImage } from "../types/medicalImage";
import type { MedicalRecord } from "../types/medicalRecord";
import type { Notification } from "../types/notification";
import type { Owner } from "../types/owner";
import type { Pet } from "../types/pet";
import { apiClient, authToken } from "../services/apiClient";

type AuthRole = "owner" | "admin" | null;
type CreateHotelBookingInput = { petId: string; checkIn: string; checkOut: string; roomType: HotelBooking["roomType"]; serviceKeys: HotelBooking["serviceKeys"]; ownerNote?: string };
type CreateAppointmentInput = { petId: string; type: AppointmentType; serviceName: string; date: string; time: string; doctorId?: string; ownerNote?: string };
type RescheduleAppointmentInput = { date: string; time: string; ownerNote?: string };
type CreateMedicalRecordInput = Omit<MedicalRecord, "id" | "ownerId" | "createdAt" | "updatedAt">;
type UpdateMedicalRecordInput = Partial<Omit<MedicalRecord, "id" | "ownerId" | "createdAt">>;
type RegisterOwnerInput = { fullName?: string; phone?: string; email: string; password: string; confirmPassword: string; address?: string };
type UpdateOwnerProfileInput = { fullName: string; email: string; phone?: string; address?: string };
type ChangePasswordInput = { currentPassword: string; newPassword: string; confirmPassword: string };
type CreatePetInput = Omit<Pet, "id" | "ownerId">;
type UpdatePetInput = Partial<Omit<Pet, "id" | "ownerId">>;
type RescueReportInput = { petId: string; finderName?: string; finderPhone: string; location: string; note?: string };
type UploadMedicalImageInput = { petId: string; title: string; imageUrl: string; mimeType: string };

type AppState = {
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

type AppStoreValue = AppState & {
  authRole: AuthRole;
  isLoading: boolean;
  isAuthReady: boolean;
  error: string;
  currentOwner: Owner;
  ownerPets: Pet[];
  loginOwner: (email: string, password: string) => Promise<string | null>;
  loginAdmin: (username: string, password: string) => Promise<string | null>;
  logout: () => void;
  registerOwner: (input: RegisterOwnerInput) => Promise<void>;
  updateOwnerProfile: (input: UpdateOwnerProfileInput) => Promise<void>;
  changePassword: (input: ChangePasswordInput) => Promise<void>;
  createPet: (input: CreatePetInput) => void;
  updatePet: (petId: string, input: UpdatePetInput) => void;
  submitRescueReport: (input: RescueReportInput) => void;
  createHotelBooking: (input: CreateHotelBookingInput) => void;
  updateHotelBookingStatus: (bookingId: string, status: HotelBookingStatus, internalNote?: string) => void;
  updateHotelBookingInternalNote: (bookingId: string, internalNote: string) => void;
  cancelHotelBooking: (bookingId: string, ownerNote?: string) => void;
  addDailyCareNote: (bookingId: string, note: string, eatingStatus?: "good" | "normal" | "poor", mood?: "happy" | "calm" | "anxious" | "tired") => void;
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

const emptyState: AppState = { currentOwnerId: "", owners: [], pets: [], appointments: [], medicalRecords: [], medicalImages: [], hotelBookings: [], dailyCareNotes: [], notifications: [] };
const fallbackOwner: Owner = { id: "", fullName: "", phone: "", petIds: [] };
const AppStoreContext = createContext<AppStoreValue | null>(null);

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(emptyState);
  const [authRole, setAuthRole] = useState<AuthRole>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [error, setError] = useState("");

  const loadData = async () => setState(await apiClient.get<AppState>("/bootstrap"));

  useEffect(() => {
    let active = true;
    const restore = async () => {
      if (!authToken.get()) return setIsAuthReady(true);
      try {
        const { user } = await apiClient.get<{ user: { role: string } }>("/auth/me");
        if (!active) return;
        setAuthRole(user.role === "owner" ? "owner" : "admin");
        await loadData();
      } catch {
        authToken.clear();
      } finally {
        if (active) setIsAuthReady(true);
      }
    };
    void restore();
    return () => { active = false; };
  }, []);

  const authenticate = async (endpoint: string, credentials: object, role: Exclude<AuthRole, null>) => {
    setIsLoading(true);
    setError("");
    try {
      const result = await apiClient.post<{ token: string }>(endpoint, credentials);
      authToken.set(result.token);
      setAuthRole(role);
      await loadData();
      return null;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Authentication failed.";
      setError(message);
      return message;
    } finally {
      setIsLoading(false);
    }
  };

  const mutate = (operation: () => Promise<unknown>) => {
    void (async () => {
      setIsLoading(true);
      setError("");
      try {
        await operation();
        await loadData();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "The request could not be completed.");
      } finally {
        setIsLoading(false);
      }
    })();
  };

  const value = useMemo<AppStoreValue>(() => {
    const currentOwner = state.owners.find((owner) => owner.id === state.currentOwnerId) ?? state.owners[0] ?? fallbackOwner;
    return {
      ...state,
      authRole,
      isLoading,
      isAuthReady,
      error,
      currentOwner,
      ownerPets: state.pets.filter((pet) => pet.ownerId === state.currentOwnerId),
      loginOwner: (email, password) => authenticate("/auth/owner/login", { email, password }, "owner"),
      loginAdmin: (username, password) => authenticate("/auth/admin/login", { username, password }, "admin"),
      logout: () => { authToken.clear(); setAuthRole(null); setState(emptyState); },
      registerOwner: async (input) => {
        setIsLoading(true);
        try {
          const result = await apiClient.post<{ token: string }>("/auth/owner/register", input);
          authToken.set(result.token);
          setAuthRole("owner");
          await loadData();
        } finally { setIsLoading(false); }
      },
      updateOwnerProfile: async (input) => {
        setIsLoading(true);
        setError("");
        try {
          await apiClient.patch("/auth/me", input);
          await loadData();
        } finally {
          setIsLoading(false);
        }
      },
      changePassword: async (input) => {
        setIsLoading(true);
        setError("");
        try {
          await apiClient.post("/auth/me/password", input);
        } finally {
          setIsLoading(false);
        }
      },
      createPet: (input) => mutate(() => apiClient.post("/pets", input)),
      updatePet: (id, input) => mutate(() => apiClient.patch(`/pets/${id}`, input)),
      submitRescueReport: (input) => { const pet = state.pets.find((item) => item.id === input.petId); mutate(() => apiClient.post(`/public/pets/${pet?.qrToken || input.petId}/rescue-reports`, input)); },
      createHotelBooking: (input) => mutate(() => apiClient.post("/hotel-bookings", input)),
      updateHotelBookingStatus: (id, status, internalNote) => mutate(() => apiClient.patch(`/hotel-bookings/${id}/status`, { status, internalNote })),
      updateHotelBookingInternalNote: (id, internalNote) => { const status = state.hotelBookings.find((item) => item.id === id)?.status; mutate(() => apiClient.patch(`/hotel-bookings/${id}/status`, { status, internalNote })); },
      cancelHotelBooking: (id, ownerNote) => mutate(() => apiClient.patch(`/hotel-bookings/${id}/cancel`, { ownerNote })),
      addDailyCareNote: (id, note, eatingStatus, mood) => mutate(() => apiClient.post(`/hotel-bookings/${id}/care-notes`, { note, eatingStatus, mood })),
      createAppointment: (input) => mutate(() => apiClient.post("/appointments", input)),
      cancelAppointment: (id, ownerNote) => mutate(() => apiClient.patch(`/appointments/${id}/cancel`, { ownerNote })),
      rescheduleAppointment: (id, input) => mutate(() => apiClient.patch(`/appointments/${id}/reschedule`, input)),
      updateAppointmentStatus: (id, status, internalNote) => mutate(() => apiClient.patch(`/appointments/${id}/status`, { status, internalNote })),
      updateAppointmentInternalNote: (id, internalNote) => { const status = state.appointments.find((item) => item.id === id)?.status; mutate(() => apiClient.patch(`/appointments/${id}/status`, { status, internalNote })); },
      sendReminder: (id) => mutate(() => apiClient.post(`/appointments/${id}/reminder`)),
      createMedicalRecord: (input) => mutate(() => apiClient.post("/medical-records", input)),
      updateMedicalRecord: (id, input) => mutate(() => apiClient.patch(`/medical-records/${id}`, input)),
      deleteMedicalRecord: (id) => mutate(() => apiClient.delete(`/medical-records/${id}`)),
      uploadMedicalImage: (input) => mutate(() => apiClient.post("/medical-records/images", input)),
      deleteMedicalImage: (id) => mutate(() => apiClient.delete(`/medical-records/images/${id}`)),
      markNotificationRead: (id) => mutate(() => apiClient.patch(`/notifications/${id}/read`)),
      markAllNotificationsRead: () => mutate(() => apiClient.patch("/notifications/read-all")),
      deleteNotification: (id) => mutate(() => apiClient.delete(`/notifications/${id}`)),
      sendCustomNotification: (recipientOwnerId, title, message) => mutate(() => apiClient.post("/notifications/send", { recipientOwnerId, title, message })),
      resetStoreData: () => mutate(() => Promise.resolve()),
    };
  }, [state, authRole, isLoading, isAuthReady, error]);

  return <AppStoreContext.Provider value={value}>{children}</AppStoreContext.Provider>;
}

export function useAppStore() {
  const context = useContext(AppStoreContext);
  if (!context) throw new Error("useAppStore must be used within AppStoreProvider");
  return context;
}
