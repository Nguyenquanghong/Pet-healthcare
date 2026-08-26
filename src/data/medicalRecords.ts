import type { MedicalRecord } from "../types/medicalRecord";

const now = new Date().toISOString();

/**
 * Mock medical record data — dữ liệu hồ sơ y tế mẫu.
 * Đồng bộ với initialState trong AppStoreProvider.
 */
export const mockMedicalRecords: MedicalRecord[] = [
  {
    id: "record_1",
    petId: "pet_mochi",
    ownerId: "owner_1",
    appointmentId: "appointment_1",
    doctorName: "Bs. Mai Nguyễn",
    visitDate: "2026-10-28",
    title: "Annual Checkup & Vaccination",
    symptoms: "Khám định kỳ, không có triệu chứng bất thường.",
    diagnosis: "Sức khỏe ổn định, cân nặng phù hợp giống Shiba Inu.",
    treatment: "Tiêm vaccine nhắc lại và tư vấn dinh dưỡng.",
    medications: "Vitamin tổng hợp 7 ngày",
    vaccineName: "DHPPi + Lepto",
    followUpDate: "2027-04-28",
    weightKg: 8.4,
    temperatureC: 38.2,
    heartRateBpm: 92,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "record_2",
    petId: "pet_yuki",
    ownerId: "owner_1",
    doctorName: "Dr. Kenji Sato",
    visitDate: "2026-10-14",
    title: "Dermatology Consult",
    symptoms: "Ngứa nhẹ sau khi đổi thức ăn.",
    diagnosis: "Nghi dị ứng protein bò.",
    treatment: "Ngưng thức ăn chứa bò, theo dõi da trong 14 ngày.",
    medications: "Sữa tắm dịu nhẹ 2 lần/tuần",
    followUpDate: "2026-11-14",
    weightKg: 7.2,
    temperatureC: 38.4,
    heartRateBpm: 96,
    createdAt: now,
    updatedAt: now,
  },
];
