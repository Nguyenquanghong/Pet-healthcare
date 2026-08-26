import type { Staff } from "../types/staff";

/**
 * Danh sách bác sĩ & nhân viên bệnh viện thú y Mỹ Đình.
 * Dùng cho dropdown chọn bác sĩ, phân công lịch khám, và báo cáo.
 */
export const mockStaff: Staff[] = [
  {
    id: "doctor_mai",
    fullName: "Bs. Mai Nguyễn",
    role: "veterinarian",
    specialty: "Đa khoa & Nội nhi Thú y",
    isActive: true,
  },
  {
    id: "doctor_sato",
    fullName: "Dr. Kenji Sato",
    role: "veterinarian",
    specialty: "Da liễu & Phẫu thuật Chỉnh hình",
    isActive: true,
  },
  {
    id: "doctor_anh",
    fullName: "Bs. Trần Anh",
    role: "veterinarian",
    specialty: "Nha khoa & Phẫu thuật Thú y",
    isActive: false,
  },
  {
    id: "staff_admin",
    fullName: "Lễ tân",
    role: "receptionist",
    specialty: "Tiếp nhận & Hỗ trợ khách hàng",
    isActive: true,
  },
];

/** Helper: lấy tên bác sĩ từ doctorId */
export function getDoctorName(doctorId?: string): string {
  if (!doctorId) return "Chưa phân công";
  const doctor = mockStaff.find((s) => s.id === doctorId);
  return doctor?.fullName ?? "Chưa phân công";
}

/** Helper: danh sách bác sĩ (chỉ role veterinarian) cho dropdown */
export const doctorOptions = mockStaff
  .filter((s) => s.role === "veterinarian")
  .map((s) => ({ value: s.id, label: `${s.fullName} — ${s.specialty}` }));
