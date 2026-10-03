import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { useSession } from "./store/SessionContext";
import { LoadingSpinner } from "./components/ui/LoadingSpinner";
const AdminAppointmentsPage = lazy(() => import("./routes/admin/AdminAppointmentsPage").then(module => ({ default: module.AdminAppointmentsPage })));
const AdminAnalyticsPage = lazy(() => import("./routes/admin/AdminAnalyticsPage").then(module => ({ default: module.AdminAnalyticsPage })));
const AdminBillingPage = lazy(() => import("./routes/admin/AdminBillingPage").then(module => ({ default: module.AdminBillingPage })));
const AdminDashboardPage = lazy(() => import("./routes/admin/AdminDashboardPage").then(module => ({ default: module.AdminDashboardPage })));
const AdminHotelBookingsPage = lazy(() => import("./routes/admin/AdminHotelBookingsPage").then(module => ({ default: module.AdminHotelBookingsPage })));
const AdminMedicalRecordsPage = lazy(() => import("./routes/admin/AdminMedicalRecordsPage").then(module => ({ default: module.AdminMedicalRecordsPage })));
const AdminNotificationsPage = lazy(() => import("./routes/admin/AdminNotificationsPage").then(module => ({ default: module.AdminNotificationsPage })));
const AdminPetsPage = lazy(() => import("./routes/admin/AdminPetsPage").then(module => ({ default: module.AdminPetsPage })));
const AdminOwnersPage = lazy(() => import("./routes/admin/AdminOwnersPage").then(module => ({ default: module.AdminOwnersPage })));
const AdminSettingsPage = lazy(() => import("./routes/admin/AdminSettingsPage").then(module => ({ default: module.AdminSettingsPage })));
const AdminLoginPage = lazy(() => import("./routes/auth/AdminLoginPage").then(module => ({ default: module.AdminLoginPage })));
const LandingPage = lazy(() => import("./routes/auth/LandingPage").then(module => ({ default: module.LandingPage })));
const OwnerLoginPage = lazy(() => import("./routes/auth/OwnerLoginPage").then(module => ({ default: module.OwnerLoginPage })));
const OwnerActivationPage = lazy(() => import("./routes/auth/OwnerActivationPage").then(module => ({ default: module.OwnerActivationPage })));
const AppointmentsPage = lazy(() => import("./routes/owner/AppointmentsPage").then(module => ({ default: module.AppointmentsPage })));
const DashboardPage = lazy(() => import("./routes/owner/DashboardPage").then(module => ({ default: module.DashboardPage })));
const HotelBookingPage = lazy(() => import("./routes/owner/HotelBookingPage").then(module => ({ default: module.HotelBookingPage })));
const HotelBookingDetailPage = lazy(() => import("./routes/owner/HotelBookingDetailPage").then(module => ({ default: module.HotelBookingDetailPage })));
const MedicalRecordsPage = lazy(() => import("./routes/owner/MedicalRecordsPage").then(module => ({ default: module.MedicalRecordsPage })));
const NotificationsPage = lazy(() => import("./routes/owner/NotificationsPage").then(module => ({ default: module.NotificationsPage })));
const OwnerBillingPage = lazy(() => import("./routes/owner/OwnerBillingPage").then(module => ({ default: module.OwnerBillingPage })));
const OwnerRegisterPage = lazy(() => import("./routes/owner/OwnerRegisterPage").then(module => ({ default: module.OwnerRegisterPage })));
const PetsPage = lazy(() => import("./routes/owner/PetsPage").then(module => ({ default: module.PetsPage })));
const OwnerProfilePage = lazy(() => import("./routes/owner/OwnerProfilePage").then(module => ({ default: module.OwnerProfilePage })));
const SpaBookingPage = lazy(() => import("./routes/owner/SpaBookingPage").then(module => ({ default: module.SpaBookingPage })));
const PetRescuePage = lazy(() => import("./routes/public/PetRescuePage").then(module => ({ default: module.PetRescuePage })));

function OwnerOnly({ children }: { children: ReactNode }) {
  const { authRole, isAuthReady } = useSession();
  if (!isAuthReady) return <div className="flex min-h-screen items-center justify-center"><LoadingSpinner label="Loading session..." /></div>;
  return authRole === "owner" ? children : <Navigate to="/login" replace />;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { authRole, isAuthReady } = useSession();
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
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center"><LoadingSpinner label="Đang tải trang..." /></div>}>
    <Routes>
      <Route path="/" element={<PublicEntryPage />} />
      <Route path="/login" element={<OwnerLoginPage />} />
      <Route path="/register" element={<OwnerRegisterPage />} />
      <Route path="/activate-account" element={<OwnerActivationPage />} />
      <Route path="/rescue/:qrToken" element={<PetRescuePage />} />
      <Route path="/pet/:qrToken" element={<PetRescuePage />} />
      <Route path="/owner" element={<Navigate to="/owner/dashboard" replace />} />
      <Route path="/owner/dashboard" element={<OwnerOnly><DashboardPage /></OwnerOnly>} />
      <Route path="/owner/profile" element={<OwnerOnly><OwnerProfilePage /></OwnerOnly>} />
      <Route path="/owner/pets" element={<OwnerOnly><PetsPage /></OwnerOnly>} />
      <Route path="/owner/medical-records" element={<OwnerOnly><MedicalRecordsPage /></OwnerOnly>} />
      <Route path="/owner/appointments" element={<OwnerOnly><AppointmentsPage /></OwnerOnly>} />
      <Route path="/owner/spa-booking" element={<OwnerOnly><SpaBookingPage /></OwnerOnly>} />
      <Route path="/owner/hotel-booking" element={<OwnerOnly><HotelBookingPage /></OwnerOnly>} />
      <Route path="/owner/hotel-bookings/:id" element={<OwnerOnly><HotelBookingDetailPage /></OwnerOnly>} />
      <Route path="/owner/notifications" element={<OwnerOnly><NotificationsPage /></OwnerOnly>} />
      <Route path="/owner/billing" element={<OwnerOnly><OwnerBillingPage /></OwnerOnly>} />
      <Route path="/admin/login" element={<AdminLoginPage />} />
      <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
      <Route path="/admin/dashboard" element={<AdminOnly><AdminDashboardPage /></AdminOnly>} />
      <Route path="/admin/appointments" element={<AdminOnly><AdminAppointmentsPage /></AdminOnly>} />
      <Route path="/admin/pets" element={<AdminOnly><AdminPetsPage /></AdminOnly>} />
      <Route path="/admin/owners" element={<AdminOnly><AdminOwnersPage /></AdminOnly>} />
      <Route path="/admin/medical-records" element={<AdminOnly><AdminMedicalRecordsPage /></AdminOnly>} />
      <Route path="/admin/hotel-bookings" element={<AdminOnly><AdminHotelBookingsPage /></AdminOnly>} />
      <Route path="/admin/notifications" element={<AdminOnly><AdminNotificationsPage /></AdminOnly>} />
      <Route path="/admin/analytics" element={<AdminOnly><AdminAnalyticsPage /></AdminOnly>} />
      <Route path="/admin/billing" element={<AdminOnly><AdminBillingPage /></AdminOnly>} />
      <Route path="/admin/settings" element={<AdminOnly><AdminSettingsPage /></AdminOnly>} />
      <Route path="/pets" element={<Navigate to="/owner/pets" replace />} />
      <Route path="/medical-records" element={<Navigate to="/owner/medical-records" replace />} />
      <Route path="/appointments" element={<Navigate to="/owner/appointments" replace />} />
      <Route path="/spa-booking" element={<Navigate to="/owner/spa-booking" replace />} />
      <Route path="/hotel-booking" element={<Navigate to="/owner/hotel-booking" replace />} />
      <Route path="/notifications" element={<Navigate to="/owner/notifications" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}
