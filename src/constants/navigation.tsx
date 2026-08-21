import { Bell, CalendarDays, FileText, Hotel, LayoutDashboard, PawPrint, Settings } from "lucide-react";

export const ownerNav = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/pets", label: "Pet Profiles", icon: PawPrint },
  { to: "/medical-records", label: "Medical Records", icon: FileText },
  { to: "/appointments", label: "Appointments", icon: CalendarDays },
  { to: "/hotel-booking", label: "Hotel Booking", icon: Hotel },
  { to: "/notifications", label: "Notifications", icon: Bell },
];

export const adminNav = [
  { to: "/admin/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/admin/appointments", label: "Appointments", icon: CalendarDays },
  { to: "/admin/pets", label: "Pets", icon: PawPrint },
  { to: "/admin/medical-records", label: "Medical Records", icon: FileText },
  { to: "/admin/hotel-bookings", label: "Hotel Bookings", icon: Hotel },
  { to: "/admin/notifications", label: "Notifications", icon: Bell },
  { to: "/admin/settings", label: "Settings", icon: Settings },
];