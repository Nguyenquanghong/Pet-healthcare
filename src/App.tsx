import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { Card } from "./components/ui/Card";
import { AdminAppointmentsPage } from "./routes/admin/AdminAppointmentsPage";
import { AdminDashboardPage } from "./routes/admin/AdminDashboardPage";
import { AdminHotelBookingsPage } from "./routes/admin/AdminHotelBookingsPage";
import { AdminMedicalRecordsPage } from "./routes/admin/AdminMedicalRecordsPage";
import { AdminNotificationsPage } from "./routes/admin/AdminNotificationsPage";
import { AdminPetsPage } from "./routes/admin/AdminPetsPage";
import { AppointmentsPage } from "./routes/owner/AppointmentsPage";
import { DashboardPage } from "./routes/owner/DashboardPage";
import { HotelBookingPage } from "./routes/owner/HotelBookingPage";
import { MedicalRecordsPage } from "./routes/owner/MedicalRecordsPage";
import { NotificationsPage } from "./routes/owner/NotificationsPage";
import { PetsPage } from "./routes/owner/PetsPage";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<DashboardPage />} />
      <Route path="/pets" element={<PetsPage />} />
      <Route path="/medical-records" element={<MedicalRecordsPage />} />
      <Route path="/appointments" element={<AppointmentsPage />} />
      <Route path="/hotel-booking" element={<HotelBookingPage />} />
      <Route path="/notifications" element={<NotificationsPage />} />
      <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
      <Route path="/admin/dashboard" element={<AdminDashboardPage />} />
      <Route path="/admin/appointments" element={<AdminAppointmentsPage />} />
      <Route path="/admin/pets" element={<AdminPetsPage />} />
      <Route path="/admin/medical-records" element={<AdminMedicalRecordsPage />} />
      <Route path="/admin/hotel-bookings" element={<AdminHotelBookingsPage />} />
      <Route path="/admin/notifications" element={<AdminNotificationsPage />} />
      <Route path="/admin/settings" element={<AppLayout type="admin" title="Settings"><Card>Settings placeholder</Card></AppLayout>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
