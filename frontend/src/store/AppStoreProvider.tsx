import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Appointment, AppointmentType } from "../types/appointment";
import type { DailyCareNote, HotelBooking } from "../types/booking";
import type { MedicalImage } from "../types/medicalImage";
import type { MedicalRecord } from "../types/medicalRecord";
import type { Notification } from "../types/notification";
import type { Owner } from "../types/owner";
import type { Pet } from "../types/pet";
import { apiClient, authToken } from "../services/apiClient";
import { ApiError } from "../utils/apiError";
import { useLocation } from "react-router-dom";
import { SessionProvider, type AuthRole } from "./SessionContext";
import { DataRefreshProvider } from "./DataRefreshContext";

export type AppSummary = { totals: Record<string, number>; species: Record<string, number>; appointmentStatus: Record<string, number>; hotelStatus: Record<string, number>; notificationCategory: Record<string, number>; unread: number; todayAppointments: number };
const emptySummary: AppSummary = { totals: {}, species: {}, appointmentStatus: {}, hotelStatus: {}, notificationCategory: {}, unread: 0, todayAppointments: 0 };

type CreateHotelBookingInput = { petId: string; checkIn: string; checkOut: string; roomType: HotelBooking["roomType"]; serviceKeys: HotelBooking["serviceKeys"]; ownerNote?: string };
type CreateAppointmentInput = { petId: string; type: AppointmentType; serviceName: string; date: string; time: string; doctorId?: string; ownerNote?: string };
type RescheduleAppointmentInput = { date: string; time: string; ownerNote?: string; expectedRevision?: number };
type CreateMedicalRecordInput = Omit<MedicalRecord, "id" | "ownerId" | "createdAt" | "updatedAt">;
type UpdateMedicalRecordInput = Partial<Omit<MedicalRecord, "id" | "petId" | "ownerId" | "appointmentId" | "createdAt">>;
type RegisterOwnerInput = { fullName?: string; phone?: string; email: string; password: string; confirmPassword: string; address?: string };
type UpdateOwnerProfileInput = { fullName: string; email: string; phone?: string; address?: string };
type ChangePasswordInput = { currentPassword: string; newPassword: string; confirmPassword: string };
type CreatePetInput = Omit<Pet, "id" | "ownerId" | "qrToken">;
type UpdatePetInput = Partial<Omit<Pet, "id" | "ownerId" | "qrToken" | "publicProfile">> & { publicProfile?: Partial<NonNullable<Pet["publicProfile"]>> };
type RescueReportInput = { petId: string; finderName?: string; finderPhone: string; location: string; note?: string };
type UploadMedicalImageInput = { petId: string; title: string; imageUrl: string; mimeType: string };
type SessionUser = Omit<Owner, "petIds"> & { role: string };

type AppState = {
  summary: AppSummary;
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
  dataVersion: number;
  rememberPet: (pet: Pet) => void;
  petUpdates: Record<string, Pet>;
  authRole: AuthRole;
  userRole: string | null;
  refreshData: (publishChange?: boolean) => Promise<void>;
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
  updateOwnerProfile: (input: UpdateOwnerProfileInput) => Promise<boolean>;
  changePassword: (input: ChangePasswordInput) => Promise<void>;
  createPet: (input: CreatePetInput) => Promise<boolean>;
  updatePet: (petId: string, input: UpdatePetInput) => Promise<boolean>;
  rotatePetQrToken: (petId: string) => Promise<boolean>;
  submitRescueReport: (input: RescueReportInput) => void;
  createHotelBooking: (input: CreateHotelBookingInput, requestKey: string) => Promise<{ booking: HotelBooking; refreshed: boolean }>;
  cancelHotelBooking: (bookingId: string, ownerNote?: string, expectedRevision?: number) => Promise<boolean>;
  createAppointment: (input: CreateAppointmentInput) => Promise<void>;
  cancelAppointment: (appointmentId: string, ownerNote?: string, expectedRevision?: number) => Promise<boolean>;
  rescheduleAppointment: (appointmentId: string, input: RescheduleAppointmentInput) => Promise<boolean>;
  sendReminder: (appointmentId: string) => void;
  createMedicalRecord: (input: CreateMedicalRecordInput) => Promise<boolean>;
  updateMedicalRecord: (recordId: string, input: UpdateMedicalRecordInput) => Promise<boolean>;
  deleteMedicalRecord: (recordId: string) => Promise<boolean>;
  uploadMedicalImage: (input: UploadMedicalImageInput) => Promise<boolean>;
  deleteMedicalImage: (imageId: string) => void;
  markNotificationRead: (notificationId: string) => void;
  markAllNotificationsRead: () => void;
  deleteNotification: (notificationId: string) => void;
  sendCustomNotification: (recipientOwnerId: string, title: string, message: string) => Promise<boolean>;
};

const emptyState: AppState = { summary: emptySummary, currentOwnerId: "", owners: [], pets: [], appointments: [], medicalRecords: [], medicalImages: [], hotelBookings: [], dailyCareNotes: [], notifications: [] };
const fallbackOwner: Owner = { id: "", fullName: "", phone: "", petIds: [] };
const AppStoreContext = createContext<AppStoreValue | null>(null);

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const view = /\/(dashboard|settings)$/.test(location.pathname) ? "dashboard" : "session";
  const viewRef = useRef(view); viewRef.current = view;
  const [refreshVersion, setRefreshVersion] = useState({ version: 0, changeVersion: 0 });
  const dataVersion = refreshVersion.version;
  const publishRefresh = useCallback((changed: boolean) => {
    setRefreshVersion(previous => ({ version: previous.version + 1, changeVersion: previous.changeVersion + (changed ? 1 : 0) }));
  }, []);
  const [petUpdates, setPetUpdates] = useState<Record<string, Pet>>({});
  const [state, setState] = useState<AppState>(emptyState);
  const [authRole, setAuthRole] = useState<AuthRole>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const loadSequence = useRef(0);
  const pendingLoads = useRef(0);

  const establishSession = useCallback((user: SessionUser) => {
    loadSequence.current += 1;
    setAuthRole(user.role === "owner" ? "owner" : "admin");
    setUserRole(user.role);
    setState(user.role === "owner" && user.id
      ? { ...emptyState, currentOwnerId: user.id, owners: [{ ...user, petIds: [] }] }
      : emptyState);
    setPetUpdates({});
    setSyncError("");
  }, []);

  const loadData = useCallback(async (changed = true) => {
    const token = authToken.get();
    if (!token) return;
    if (changed) publishRefresh(true);
    const sequence = ++loadSequence.current;
    pendingLoads.current += 1;
    try {
      const data = await apiClient.get<AppState>(`/bootstrap?view=${viewRef.current}`, { signal: AbortSignal.timeout(15_000) });
      // A response started before a mutation or logout must not replace newer data.
      if (sequence === loadSequence.current && token === authToken.get()) {
        setState(previous => ({ ...data, summary: data.summary ?? emptySummary, pets: viewRef.current === "session" ? [...new Map([...data.pets, ...previous.pets.filter(pet => pet.ownerId === data.currentOwnerId)].map(pet => [pet.id, pet])).values()].slice(0, 100) : data.pets }));
        setPetUpdates({});
        setSyncError("");
      }
    } catch (reason) {
      if (sequence === loadSequence.current && token === authToken.get())
        setSyncError("Chưa cập nhật được dữ liệu mới. Hệ thống sẽ tự thử lại khi có kết nối.");
      throw reason;
    } finally { pendingLoads.current -= 1; }
  }, [publishRefresh]);

  useEffect(() => {
    loadSequence.current += 1;
    if (authRole) void loadData().catch(() => undefined);
  }, [view, authRole, loadData]);

  useEffect(() => {
    if (!authRole || !isAuthReady) return;
    const refresh = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      publishRefresh(false);
      if (!pendingLoads.current) void loadData(false).catch(() => undefined);
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
  }, [authRole, isAuthReady, loadData, publishRefresh]);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      const token = authToken.get();
      if (!token) return setIsAuthReady(true);
      try {
        const { user } = await apiClient.get<{ user: SessionUser }>("/auth/me", { signal: AbortSignal.timeout(15_000) });
        if (!active || token !== authToken.get()) return;
        establishSession(user);
      } catch (reason) {
        if (active && token === authToken.get()) {
          if (reason instanceof ApiError && [401, 404].includes(reason.httpStatus)) {
            authToken.clear(); setAuthRole(null); setUserRole(null); setState(emptyState);
          } else setError("Chưa xác minh được phiên đăng nhập. Hãy thử tải lại trang.");
        }
      } finally {
        if (active) setIsAuthReady(true);
      }
    };
    void restore();
    return () => { active = false; loadSequence.current += 1; };
  }, [establishSession]);

  const authenticate = async (endpoint: string, credentials: object) => {
    setIsLoading(true);
    setError("");
    try {
      const result = await apiClient.post<{ token: string; user: SessionUser }>(endpoint, credentials);
      authToken.set(result.token);
      establishSession(result.user);
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
      dataVersion,
      petUpdates,
      rememberPet: pet => setState(previous => ({ ...previous, pets: [pet, ...previous.pets.filter(item => item.id !== pet.id)].slice(0, 100) })),
      authRole,
      userRole,
      refreshData: loadData,
      isLoading,
      isAuthReady,
      error,
      syncError,
      currentOwner,
      ownerPets: state.pets.filter((pet) => pet.ownerId === state.currentOwnerId),
      loginOwner: (email, password) => authenticate("/auth/owner/login", { email, password }),
      loginAdmin: (username, password) => authenticate("/auth/admin/login", { username, password }),
      logout: () => { loadSequence.current += 1; authToken.clear(); setAuthRole(null); setUserRole(null); setState(emptyState); setPetUpdates({}); setSyncError(""); },
      registerOwner: async (input) => {
        setIsLoading(true);
        try {
          const result = await apiClient.post<{ token: string; user: SessionUser }>("/auth/owner/register", input);
          authToken.set(result.token);
          establishSession(result.user);
        } finally { setIsLoading(false); }
      },
      updateOwnerProfile: (input) => writeAndReload(async () => {
        const token = authToken.get();
        const { user } = await apiClient.patch<{ user: SessionUser }>("/auth/me", input);
        if (token !== authToken.get()) return;
        loadSequence.current += 1;
        setState(previous => ({ ...previous, owners: previous.owners.map(owner => owner.id === user.id ? { ...owner, ...user } : owner) }));
      }),
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
      updatePet: (id, input) => writeAndReload(async () => {
        const token = authToken.get();
        const { pet } = await apiClient.patch<{ pet: Pet }>(`/pets/${id}`, input);
        if (token === authToken.get()) {
          loadSequence.current += 1;
          setState(previous => ({ ...previous, pets: previous.pets.map(item => item.id === id ? pet : item) }));
          setPetUpdates(previous => Object.fromEntries([[id, pet], ...Object.entries(previous).filter(([key]) => key !== id)].slice(0, 100)));
        }
      }),
      rotatePetQrToken: (id) => writeAndReload(async () => {
        const token = authToken.get();
        const { pet } = await apiClient.post<{ pet: Pet }>(`/pets/${id}/qr-token`, {});
        if (token === authToken.get()) {
          loadSequence.current += 1;
          setState(previous => ({ ...previous, pets: previous.pets.map(item => item.id === id ? pet : item) }));
          setPetUpdates(previous => Object.fromEntries([[id, pet], ...Object.entries(previous).filter(([key]) => key !== id)].slice(0, 100)));
        }
      }),
      submitRescueReport: (input) => {
        const pet = state.pets.find((item) => item.id === input.petId);
        if (!pet?.qrToken) { setError("Thú cưng chưa có mã QR cứu hộ."); return; }
        mutate(() => apiClient.post(`/public/pets/${encodeURIComponent(pet.qrToken!)}/rescue-reports`, input));
      },
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
      cancelHotelBooking: async (id, ownerNote, expectedRevision) => {
        setIsLoading(true); setError("");
        try {
          await apiClient.patch(`/hotel-bookings/${id}/cancel`, { ownerNote, expectedRevision: expectedRevision ?? state.hotelBookings.find(item => item.id === id)?.statusRevision });
          try { await loadData(); return true; }
          catch { setError("Đã hủy đặt phòng nhưng chưa tải lại được danh sách."); return false; }
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "Không thể hủy đặt phòng.");
          throw reason;
        } finally { setIsLoading(false); }
      },
      createAppointment: (input) => writeAndReload(() => apiClient.post("/appointments", input)).then(() => undefined),
      cancelAppointment: (id, ownerNote, expectedRevision) => writeAndReload(() => apiClient.patch(`/appointments/${id}/cancel`, { ownerNote, expectedRevision: expectedRevision ?? state.appointments.find(item => item.id === id)?.statusRevision })),
      rescheduleAppointment: (id, input) => writeAndReload(() => apiClient.patch(`/appointments/${id}/reschedule`, { ...input, expectedRevision: input.expectedRevision ?? state.appointments.find(item => item.id === id)?.statusRevision })),
      sendReminder: (id) => mutate(() => apiClient.post(`/appointments/${id}/reminder`)),
      createMedicalRecord: (input) => writeAndReload(() => apiClient.post("/medical-records", input)),
      updateMedicalRecord: (id, input) => writeAndReload(() => apiClient.patch(`/medical-records/${id}`, input)),
      deleteMedicalRecord: (id) => writeAndReload(() => apiClient.delete(`/medical-records/${id}`)),
      uploadMedicalImage: (input) => writeAndReload(() => apiClient.post("/medical-records/images", input)),
      deleteMedicalImage: (id) => mutate(() => apiClient.delete(`/medical-records/images/${id}`)),
      markNotificationRead: (id) => mutate(() => apiClient.patch(`/notifications/${id}/read`)),
      markAllNotificationsRead: () => mutate(() => apiClient.patch("/notifications/read-all")),
      deleteNotification: (id) => mutate(() => apiClient.delete(`/notifications/${id}`)),
      sendCustomNotification: (recipientOwnerId, title, message) => writeAndReload(() => apiClient.post("/notifications/send", { recipientOwnerId, title, message })),
    };
  }, [state, authRole, userRole, isLoading, isAuthReady, error, syncError, loadData, dataVersion, petUpdates]);

  return (
    <SessionProvider authRole={authRole} userRole={userRole} isAuthReady={isAuthReady}>
      <DataRefreshProvider version={dataVersion} changeVersion={refreshVersion.changeVersion}>
        <AppStoreContext.Provider value={value}>{children}</AppStoreContext.Provider>
      </DataRefreshProvider>
    </SessionProvider>
  );
}

export function useAppStore() {
  const context = useContext(AppStoreContext);
  if (!context) throw new Error("useAppStore must be used within AppStoreProvider");
  return context;
}
