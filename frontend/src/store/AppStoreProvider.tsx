import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Appointment, AppointmentType } from "../types/appointment";
import type { DailyCareNote, HotelBooking } from "../types/booking";
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
  userRole: string | null;
  refreshData: () => Promise<void>;
  isLoading: boolean;
  isAuthReady: boolean;
  error: string;
  syncError: string;
  currentOwner: Owner;
  ownerPets: Pet[];
  loginOwner: (email: string, password: string) => Promise<string | null>;
  loginAdmin: (username: string, password: string) => Promise<string | null>;
  logout: () => void;
  registerOwner: (input: RegisterOwnerInput) => Promise<void>;
  updateOwnerProfile: (input: UpdateOwnerProfileInput) => Promise<void>;
  changePassword: (input: ChangePasswordInput) => Promise<void>;
  createPet: (input: CreatePetInput) => Promise<boolean>;
  updatePet: (petId: string, input: UpdatePetInput) => Promise<boolean>;
  submitRescueReport: (input: RescueReportInput) => void;
  createHotelBooking: (input: CreateHotelBookingInput, requestKey: string) => Promise<{ booking: HotelBooking; refreshed: boolean }>;
  cancelHotelBooking: (bookingId: string, ownerNote?: string) => Promise<boolean>;
  createAppointment: (input: CreateAppointmentInput) => Promise<void>;
  cancelAppointment: (appointmentId: string, ownerNote?: string) => Promise<boolean>;
  rescheduleAppointment: (appointmentId: string, input: RescheduleAppointmentInput) => Promise<boolean>;
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
};

const emptyState: AppState = { currentOwnerId: "", owners: [], pets: [], appointments: [], medicalRecords: [], medicalImages: [], hotelBookings: [], dailyCareNotes: [], notifications: [] };
const fallbackOwner: Owner = { id: "", fullName: "", phone: "", petIds: [] };
const AppStoreContext = createContext<AppStoreValue | null>(null);

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(emptyState);
  const [authRole, setAuthRole] = useState<AuthRole>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const loadSequence = useRef(0);
  const pendingLoads = useRef(0);

  const loadData = useCallback(async () => {
    const token = authToken.get();
    if (!token) return;
    const sequence = ++loadSequence.current;
    pendingLoads.current += 1;
    try {
      const data = await apiClient.get<AppState>("/bootstrap", { signal: AbortSignal.timeout(15_000) });
      // A response started before a mutation or logout must not replace newer data.
      if (sequence === loadSequence.current && token === authToken.get()) {
        setState(data);
        setSyncError("");
      }
    } catch (reason) {
      if (sequence === loadSequence.current && token === authToken.get())
        setSyncError("Chưa cập nhật được dữ liệu mới. Hệ thống sẽ tự thử lại khi có kết nối.");
      throw reason;
    } finally { pendingLoads.current -= 1; }
  }, []);

  useEffect(() => {
    if (!authRole || !isAuthReady) return;
    const refresh = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine || pendingLoads.current) return;
      void loadData().catch(() => undefined);
    };
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [authRole, isAuthReady, loadData]);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      const token = authToken.get();
      if (!token) return setIsAuthReady(true);
      try {
        const { user } = await apiClient.get<{ user: { role: string } }>("/auth/me");
        if (!active) return;
        setAuthRole(user.role === "owner" ? "owner" : "admin");
        setUserRole(user.role);
        await loadData();
      } catch {
        if (active && token === authToken.get()) {
          authToken.clear(); setAuthRole(null); setUserRole(null); setState(emptyState);
        }
      } finally {
        if (active) setIsAuthReady(true);
      }
    };
    void restore();
    return () => { active = false; loadSequence.current += 1; };
  }, [loadData]);

  const authenticate = async (endpoint: string, credentials: object, role: Exclude<AuthRole, null>) => {
    setIsLoading(true);
    setError("");
    try {
      const result = await apiClient.post<{ token: string; user: { role: string } }>(endpoint, credentials);
      authToken.set(result.token);
      setAuthRole(role);
      setUserRole(result.user.role);
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

  const writeAndReload = async (operation: () => Promise<unknown>): Promise<boolean> => {
    setIsLoading(true);
    setError("");
    try {
      try { await operation(); }
      catch (reason) {
        setError(reason instanceof Error ? reason.message : "The request could not be completed.");
        throw reason;
      }
      try { await loadData(); return true; }
      catch { setError("Đã lưu thao tác nhưng chưa tải lại được dữ liệu. Hãy tải lại để đối chiếu."); return false; }
    }
    finally { setIsLoading(false); }
  };
  const runMutation = async (operation: () => Promise<unknown>) => { await writeAndReload(operation); };

  const mutate = (operation: () => Promise<unknown>) => {
    void runMutation(operation).catch(() => undefined);
  };

  const value = useMemo<AppStoreValue>(() => {
    const currentOwner = state.owners.find((owner) => owner.id === state.currentOwnerId) ?? state.owners[0] ?? fallbackOwner;
    return {
      ...state,
      authRole,
      userRole,
      refreshData: loadData,
      isLoading,
      isAuthReady,
      error,
      syncError,
      currentOwner,
      ownerPets: state.pets.filter((pet) => pet.ownerId === state.currentOwnerId),
      loginOwner: (email, password) => authenticate("/auth/owner/login", { email, password }, "owner"),
      loginAdmin: (username, password) => authenticate("/auth/admin/login", { username, password }, "admin"),
      logout: () => { loadSequence.current += 1; authToken.clear(); setAuthRole(null); setUserRole(null); setState(emptyState); setSyncError(""); },
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
      createPet: (input) => writeAndReload(() => apiClient.post("/pets", input)),
      updatePet: (id, input) => writeAndReload(() => apiClient.patch(`/pets/${id}`, input)),
      submitRescueReport: (input) => { const pet = state.pets.find((item) => item.id === input.petId); mutate(() => apiClient.post(`/public/pets/${pet?.qrToken || input.petId}/rescue-reports`, input)); },
      createHotelBooking: async (input, requestKey) => {
        setIsLoading(true); setError("");
        try {
          const { booking } = await apiClient.post<{ booking: HotelBooking }>("/hotel-bookings", input, { "Idempotency-Key": requestKey });
          try { await loadData(); return { booking, refreshed: true }; }
          catch { setError("Đã lưu đặt phòng nhưng chưa tải lại được danh sách."); return { booking, refreshed: false }; }
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "Không thể đặt phòng.");
          throw reason;
        } finally { setIsLoading(false); }
      },
      cancelHotelBooking: async (id, ownerNote) => {
        setIsLoading(true); setError("");
        try {
          await apiClient.patch(`/hotel-bookings/${id}/cancel`, { ownerNote, expectedRevision: state.hotelBookings.find(item => item.id === id)?.statusRevision });
          try { await loadData(); return true; }
          catch { setError("Đã hủy đặt phòng nhưng chưa tải lại được danh sách."); return false; }
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "Không thể hủy đặt phòng.");
          throw reason;
        } finally { setIsLoading(false); }
      },
      createAppointment: (input) => writeAndReload(() => apiClient.post("/appointments", input)).then(() => undefined),
      cancelAppointment: (id, ownerNote) => writeAndReload(() => apiClient.patch(`/appointments/${id}/cancel`, { ownerNote, expectedRevision: state.appointments.find(item => item.id === id)?.statusRevision })),
      rescheduleAppointment: (id, input) => writeAndReload(() => apiClient.patch(`/appointments/${id}/reschedule`, { ...input, expectedRevision: state.appointments.find(item => item.id === id)?.statusRevision })),
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
    };
  }, [state, authRole, userRole, isLoading, isAuthReady, error, syncError, loadData]);

  return <AppStoreContext.Provider value={value}>{children}</AppStoreContext.Provider>;
}

export function useAppStore() {
  const context = useContext(AppStoreContext);
  if (!context) throw new Error("useAppStore must be used within AppStoreProvider");
  return context;
}
