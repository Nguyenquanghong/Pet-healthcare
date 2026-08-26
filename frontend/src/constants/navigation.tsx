import { Bell, CalendarDays, FileText, Hotel, LayoutDashboard, PawPrint, Settings, BarChart3, Receipt, UserRound } from "lucide-react";

export const ownerNav = [
  { to: "/owner/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/owner/profile", label: "Profile", icon: UserRound },
  { to: "/owner/pets", label: "Pet Profiles", icon: PawPrint },
  { to: "/owner/medical-records", label: "Medical Records", icon: FileText },
  { to: "/owner/appointments", label: "Appointments", icon: CalendarDays },
  { to: "/owner/hotel-booking", label: "Hotel Booking", icon: Hotel },
  { to: "/owner/notifications", label: "Notifications", icon: Bell },
];

export const adminNav = [
  { to: "/admin/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/admin/appointments", label: "Appointments", icon: CalendarDays },
  { to: "/admin/pets", label: "Pets", icon: PawPrint },
  { to: "/admin/medical-records", label: "Medical Records", icon: FileText },
  { to: "/admin/hotel-bookings", label: "Hotel Bookings", icon: Hotel },
  { to: "/admin/notifications", label: "Notifications", icon: Bell },
  { to: "/admin/analytics", label: "Thống kê", icon: BarChart3 },
  { to: "/admin/billing", label: "Hóa đơn", icon: Receipt },
  { to: "/admin/settings", label: "Settings", icon: Settings },
];
