import { Bell, CalendarDays, FileText, Hotel, LayoutDashboard, PawPrint, Settings, BarChart3, Receipt, Sparkles, UserRound } from "lucide-react";

export const ownerNav = [
  { to: "/owner/dashboard", label: "Dashboard", mobileLabel: "Home", icon: LayoutDashboard },
  { to: "/owner/pets", label: "Pet Profiles", mobileLabel: "Pets", icon: PawPrint },
  { to: "/owner/appointments", label: "Appointments", mobileLabel: "Schedule", icon: CalendarDays },
  { to: "/owner/spa-booking", label: "Spa Booking", mobileLabel: "Spa", icon: Sparkles },
  { to: "/owner/medical-records", label: "Medical Records", mobileLabel: "Records", icon: FileText },
  { to: "/owner/profile", label: "Profile", icon: UserRound },
  { to: "/owner/hotel-booking", label: "Hotel Booking", icon: Hotel },
  { to: "/owner/notifications", label: "Notifications", icon: Bell },
];

export const adminNav = [
  { to: "/admin/dashboard", label: "Dashboard", mobileLabel: "Home", icon: LayoutDashboard },
  { to: "/admin/appointments", label: "Appointments", mobileLabel: "Schedule", icon: CalendarDays },
  { to: "/admin/pets", label: "Pets", icon: PawPrint },
  { to: "/admin/medical-records", label: "Medical Records", mobileLabel: "Records", icon: FileText },
  { to: "/admin/hotel-bookings", label: "Hotel Bookings", icon: Hotel },
  { to: "/admin/notifications", label: "Notifications", icon: Bell },
  { to: "/admin/analytics", label: "Thống kê", icon: BarChart3 },
  { to: "/admin/billing", label: "Hóa đơn", icon: Receipt },
  { to: "/admin/settings", label: "Settings", icon: Settings },
];
