export type StaffRole = "admin" | "receptionist" | "veterinarian" | "hotel_staff";

export type Staff = {
  id: string;
  fullName: string;
  role: StaffRole;
  specialty?: string;
  phone?: string;
  email?: string;
  isActive: boolean;
};