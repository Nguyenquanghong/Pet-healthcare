/**
 * Route path constants — tránh hardcode strings trong components.
 * Dùng cho navigation, guards, redirect.
 */

export const ADMIN_ROUTES = {
  LOGIN: "/admin/login",
  DASHBOARD: "/admin/dashboard",
  APPOINTMENTS: "/admin/appointments",
  PETS: "/admin/pets",
  MEDICAL_RECORDS: "/admin/medical-records",
  HOTEL_BOOKINGS: "/admin/hotel-bookings",
  NOTIFICATIONS: "/admin/notifications",
  ANALYTICS: "/admin/analytics",
  BILLING: "/admin/billing",
  SETTINGS: "/admin/settings",
} as const;

export const OWNER_ROUTES = {
  LOGIN: "/login",
  REGISTER: "/register",
  DASHBOARD: "/owner/dashboard",
  PETS: "/owner/pets",
  MEDICAL_RECORDS: "/owner/medical-records",
  APPOINTMENTS: "/owner/appointments",
  HOTEL_BOOKING: "/owner/hotel-booking",
  NOTIFICATIONS: "/owner/notifications",
} as const;

export const PUBLIC_ROUTES = {
  HOME: "/",
  PET_RESCUE: "/rescue/:petId",
} as const;
