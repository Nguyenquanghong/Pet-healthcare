import type { ReactNode } from "react";
import { Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { useAppStore } from "./store/AppStoreProvider";
import { LoadingSpinner } from "./components/ui/LoadingSpinner";
import { AdminAppointmentsPage } from "./routes/admin/AdminAppointmentsPage";
import { AdminAnalyticsPage } from "./routes/admin/AdminAnalyticsPage";
import { AdminBillingPage } from "./routes/admin/AdminBillingPage";
import { AdminDashboardPage } from "./routes/admin/AdminDashboardPage";
import { AdminHotelBookingsPage } from "./routes/admin/AdminHotelBookingsPage";
import { AdminMedicalRecordsPage } from "./routes/admin/AdminMedicalRecordsPage";
import { AdminNotificationsPage } from "./routes/admin/AdminNotificationsPage";
import { AdminPetsPage } from "./routes/admin/AdminPetsPage";
import { AdminSettingsPage } from "./routes/admin/AdminSettingsPage";
import { AdminLoginPage } from "./routes/auth/AdminLoginPage";
import { LandingPage } from "./routes/auth/LandingPage";
import { OwnerLoginPage } from "./routes/auth/OwnerLoginPage";
import { AppointmentsPage } from "./routes/owner/AppointmentsPage";
import { DashboardPage } from "./routes/owner/DashboardPage";
import { HotelBookingPage } from "./routes/owner/HotelBookingPage";
import { MedicalRecordsPage } from "./routes/owner/MedicalRecordsPage";
import { NotificationsPage } from "./routes/owner/NotificationsPage";
import { OwnerRegisterPage } from "./routes/owner/OwnerRegisterPage";
import { PetsPage } from "./routes/owner/PetsPage";
import { OwnerProfilePage } from "./routes/owner/OwnerProfilePage";
import { PetRescuePage } from "./routes/public/PetRescuePage";

function OwnerOnly({ children }: { children: ReactNode }) {
  const { authRole, isAuthReady } = useAppStore();
  if (!isAuthReady) return <div className="flex min-h-screen items-center justify-center"><LoadingSpinner label="Loading session..." /></div>;
  return authRole === "owner" ? children : <Navigate to="/login" replace />;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { authRole, isAuthReady } = useAppStore();
  if (!isAuthReady) return <div className="flex min-h-screen items-center justify-center"><LoadingSpinner label="Loading session..." /></div>;
  return authRole === "admin" ? children : <Navigate to="/admin/login" replace />;
}

function PublicEntryPage() {
  const [searchParams] = useSearchParams();
  const rescueToken = searchParams.get("rescue")?.trim();

  return rescueToken ? <PetRescuePage qrToken={rescueToken} /> : <LandingPage />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<PublicEntryPage />} />
      <Route path="/login" element={<OwnerLoginPage />} />
      <Route path="/register" element={<OwnerRegisterPage />} />
      <Route path="/rescue/:qrToken" element={<PetRescuePage />} />
      <Route path="/pet/:qrToken" element={<PetRescuePage />} />
      <Route path="/owner" element={<Navigate to="/owner/dashboard" replace />} />
      <Route path="/owner/dashboard" element={<OwnerOnly><DashboardPage /></OwnerOnly>} />
      <Route path="/owner/profile" element={<OwnerOnly><OwnerProfilePage /></OwnerOnly>} />
      <Route path="/owner/pets" element={<OwnerOnly><PetsPage /></OwnerOnly>} />
      <Route path="/owner/medical-records" element={<OwnerOnly><MedicalRecordsPage /></OwnerOnly>} />
      <Route path="/owner/appointments" element={<OwnerOnly><AppointmentsPage /></OwnerOnly>} />
      <Route path="/owner/hotel-booking" element={<OwnerOnly><HotelBookingPage /></OwnerOnly>} />
      <Route path="/owner/notifications" element={<OwnerOnly><NotificationsPage /></OwnerOnly>} />
      <Route path="/admin/login" element={<AdminLoginPage />} />
      <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
      <Route path="/admin/dashboard" element={<AdminOnly><AdminDashboardPage /></AdminOnly>} />
      <Route path="/admin/appointments" element={<AdminOnly><AdminAppointmentsPage /></AdminOnly>} />
      <Route path="/admin/pets" element={<AdminOnly><AdminPetsPage /></AdminOnly>} />
      <Route path="/admin/medical-records" element={<AdminOnly><AdminMedicalRecordsPage /></AdminOnly>} />
      <Route path="/admin/hotel-bookings" element={<AdminOnly><AdminHotelBookingsPage /></AdminOnly>} />
      <Route path="/admin/notifications" element={<AdminOnly><AdminNotificationsPage /></AdminOnly>} />
      <Route path="/admin/analytics" element={<AdminOnly><AdminAnalyticsPage /></AdminOnly>} />
      <Route path="/admin/billing" element={<AdminOnly><AdminBillingPage /></AdminOnly>} />
      <Route path="/admin/settings" element={<AdminOnly><AdminSettingsPage /></AdminOnly>} />
      <Route path="/pets" element={<Navigate to="/owner/pets" replace />} />
      <Route path="/medical-records" element={<Navigate to="/owner/medical-records" replace />} />
      <Route path="/appointments" element={<Navigate to="/owner/appointments" replace />} />
      <Route path="/hotel-booking" element={<Navigate to="/owner/hotel-booking" replace />} />
      <Route path="/notifications" element={<Navigate to="/owner/notifications" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
