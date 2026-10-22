import { createContext, useContext, useState, type ReactNode } from 'react';
import type { AppointmentType } from '../types/appointment';
import type { HotelBooking } from '../types/booking';
import type { MedicalRecord } from '../types/medicalRecord';
import type { Owner } from '../types/owner';
import type { Pet } from '../types/pet';
import { apiClient, authToken } from '../services/apiClient';
import { SessionProvider, useSession, type SessionUser } from './SessionContext';
import { DataRefreshProvider, useDataRefresh, type DataScope } from './DataRefreshContext';
import { NotificationCountProvider } from './NotificationCountContext';

export type AppSummary = { totals: Record<string, number>; species: Record<string, number>; appointmentStatus: Record<string, number>; hotelStatus: Record<string, number>; notificationCategory: Record<string, number>; unread: number; todayAppointments: number };
type CreateHotelBookingInput = { petId: string; checkIn: string; checkOut: string; roomType: HotelBooking['roomType']; serviceKeys: HotelBooking['serviceKeys']; ownerNote?: string };
type CreateAppointmentInput = { petId: string; type: AppointmentType; serviceName: string; date: string; time: string; doctorId?: string; ownerNote?: string };
type RescheduleAppointmentInput = { date: string; time: string; ownerNote?: string; expectedRevision?: number };
type CreateMedicalRecordInput = Omit<MedicalRecord, 'id' | 'ownerId' | 'createdAt' | 'updatedAt'>;
type UpdateMedicalRecordInput = Partial<Omit<MedicalRecord, 'id' | 'petId' | 'ownerId' | 'appointmentId' | 'createdAt'>>;
type UpdatePetInput = Partial<Omit<Pet, 'id' | 'ownerId' | 'qrToken' | 'publicProfile'>> & { publicProfile?: Partial<NonNullable<Pet['publicProfile']>> };
const fallbackOwner: Owner = { id: '', fullName: '', phone: '', petIds: [] };

// Compatibility action facade. Pages own all business reads; session owns auth.
function useAppActions() {
  const session = useSession(), refresh = useDataRefresh();
  const [petUpdates, setPetUpdates] = useState<Record<string, Pet>>({});
  const [isLoading, setIsLoading] = useState(false), [error, setError] = useState('');
  const current = () => session.isCurrent(session.sessionKey);
  const rememberPet = (pet: Pet) => {
    if (current()) setPetUpdates(previous => Object.fromEntries([[pet.id, pet], ...Object.entries(previous).filter(([id]) => id !== pet.id)].slice(0, 100)));
  };
  const writeAndReload = async (operation: () => Promise<unknown>, scopes: DataScope[]): Promise<boolean> => {
    if (!current()) throw new Error('Phiên đăng nhập đã thay đổi.');
    setIsLoading(true); setError('');
    try {
      try { await operation(); }
      catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : 'Không lưu được thao tác.'); throw reason; }
      if (!current()) throw new Error('Phiên đăng nhập đã thay đổi.');
      try { await refresh.invalidate(scopes); return current(); }
      catch { if (current()) setError('Đã lưu thao tác nhưng chưa tải lại được dữ liệu. Hãy tải lại để đối chiếu.'); return false; }
    } finally { if (current()) setIsLoading(false); }
  };
  const mutate = (operation: () => Promise<unknown>, scopes: DataScope[]) => { void writeAndReload(operation, scopes).catch(() => undefined); };
  const currentOwner = session.authRole === 'owner' && session.user ? { ...session.user, petIds: [] } : fallbackOwner;
  return {
    ...session, error: error || session.error, isLoading, currentOwner, currentOwnerId: currentOwner.id,
    petUpdates, rememberPet,
    refreshData: (scopes?: DataScope[]) => refresh.invalidate(scopes),
    updateOwnerProfile: (input: { fullName: string; email: string; phone?: string; address?: string }) => writeAndReload(async () => {
      const token = authToken.get();
      const { user } = await apiClient.patch<{ user: SessionUser }>('/auth/me', input);
      if (current()) session.updateUser(user, token);
    }, ['profile', 'owners', 'clinic']),
    // AQ-05: the server revokes every session issued before the change, this one included;
    // sign out on purpose instead of letting the next request fail with 401.
    changePassword: async (input: { currentPassword: string; newPassword: string; confirmPassword: string }) => {
      const saved = await writeAndReload(() => apiClient.post('/auth/me/password', input), []);
      session.logout();
      return saved;
    },
    createPet: (input: Omit<Pet, 'id' | 'ownerId' | 'qrToken'>) => writeAndReload(async () => { const { pet } = await apiClient.post<{ pet: Pet }>('/pets', input); rememberPet(pet); }, ['pets']),
    updatePet: (id: string, input: UpdatePetInput) => writeAndReload(async () => { const { pet } = await apiClient.patch<{ pet: Pet }>(`/pets/${id}`, input); rememberPet(pet); }, ['pets', 'clinic']),
    rotatePetQrToken: (id: string) => writeAndReload(async () => { const { pet } = await apiClient.post<{ pet: Pet }>(`/pets/${id}/qr-token`, {}); rememberPet(pet); }, ['pets']),
    createHotelBooking: async (input: CreateHotelBookingInput, requestKey: string) => {
      let booking: HotelBooking | undefined;
      const refreshed = await writeAndReload(async () => { booking = (await apiClient.post<{ booking: HotelBooking }>('/hotel-bookings', input, { 'Idempotency-Key': requestKey })).booking; }, ['hotel']);
      return { booking: booking!, refreshed };
    },
    cancelHotelBooking: (id: string, ownerNote?: string, expectedRevision?: number) => writeAndReload(() => apiClient.patch(`/hotel-bookings/${id}/cancel`, { ownerNote, expectedRevision }), ['hotel']),
    createAppointment: (input: CreateAppointmentInput, requestKey: string) => writeAndReload(() => apiClient.post('/appointments', input, { 'Idempotency-Key': requestKey }), ['clinic']),
    cancelAppointment: (id: string, ownerNote?: string, expectedRevision?: number) => writeAndReload(() => apiClient.patch(`/appointments/${id}/cancel`, { ownerNote, expectedRevision }), ['clinic']),
    rescheduleAppointment: (id: string, input: RescheduleAppointmentInput) => writeAndReload(() => apiClient.patch(`/appointments/${id}/reschedule`, input), ['clinic']),
    sendReminder: (id: string) => mutate(() => apiClient.post(`/appointments/${id}/reminder`), ['clinic']),
    createMedicalRecord: (input: CreateMedicalRecordInput, requestKey: string) => writeAndReload(() => apiClient.post('/medical-records', input, { 'Idempotency-Key': requestKey }), ['clinic']),
    updateMedicalRecord: (id: string, input: UpdateMedicalRecordInput) => writeAndReload(() => apiClient.patch(`/medical-records/${id}`, input), ['clinic']),
    deleteMedicalRecord: (id: string) => writeAndReload(() => apiClient.delete(`/medical-records/${id}`), ['clinic']),
    uploadMedicalImage: (input: { petId: string; title: string; imageUrl: string; mimeType: string }) => writeAndReload(() => apiClient.post('/medical-records/images', input), ['clinic']),
    deleteMedicalImage: (id: string) => mutate(() => apiClient.delete(`/medical-records/images/${id}`), ['clinic']),
    markNotificationRead: (id: string) => mutate(() => apiClient.patch(`/notifications/${id}/read`), ['notifications']),
    markAllNotificationsRead: () => mutate(() => apiClient.patch('/notifications/read-all'), ['notifications']),
    deleteNotification: (id: string) => mutate(() => apiClient.delete(`/notifications/${id}`), ['notifications']),
    sendCustomNotification: (recipientOwnerId: string, title: string, message: string, requestKey: string) => writeAndReload(() => apiClient.post('/notifications/send', { recipientOwnerId, title, message }, { 'Idempotency-Key': requestKey }), ['notifications']),
  };
}
const AppStoreContext = createContext<ReturnType<typeof useAppActions> | null>(null);
function ActionsProvider({ children }: { children: ReactNode }) {
  const value = useAppActions();
  return <AppStoreContext.Provider value={value}><NotificationCountProvider>{children}</NotificationCountProvider></AppStoreContext.Provider>;
}
function SessionData({ children }: { children: ReactNode }) {
  const { sessionKey } = useSession();
  // Replace every page state and request registry on a session boundary.
  return <DataRefreshProvider key={sessionKey}><ActionsProvider>{children}</ActionsProvider></DataRefreshProvider>;
}
export function AppStoreProvider({ children }: { children: ReactNode }) {
  return <SessionProvider><SessionData>{children}</SessionData></SessionProvider>;
}
export function useAppStore() {
  const context = useContext(AppStoreContext);
  if (!context) throw new Error('useAppStore must be used within AppStoreProvider');
  return context;
}
