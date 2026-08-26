import type { Appointment } from "../types/appointment";

const now = new Date().toISOString();

/**
 * Mock appointment data — dữ liệu lịch khám mẫu.
 * Đồng bộ với initialState trong AppStoreProvider.
 */
export const mockAppointments: Appointment[] = [
  {
    id: "appointment_1",
    petId: "pet_mochi",
    ownerId: "owner_1",
    doctorId: "doctor_mai",
    type: "general_checkup",
    serviceName: "Khám tổng quát",
    clinicName: "Bệnh viện Thú y Mỹ Đình",
    date: "2026-11-02",
    time: "09:00",
    status: "confirmed",
    createdBy: "owner",
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "appointment_2",
    petId: "pet_yuki",
    ownerId: "owner_1",
    doctorId: "doctor_sato",
    type: "vaccination",
    serviceName: "Tiêm phòng",
    clinicName: "Bệnh viện Thú y Mỹ Đình",
    date: "2026-11-03",
    time: "10:30",
    status: "pending",
    ownerNote: "Ưu tiên buổi sáng.",
    createdBy: "owner",
    createdAt: now,
    updatedAt: now,
  },
];
