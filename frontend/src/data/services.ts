import type { AppointmentType, SpaAppointmentType } from "../types/appointment";
import type { HotelRoomType, HotelServiceKey } from "../types/booking";

/**
 * Danh sách dịch vụ khám chữa bệnh.
 * Dùng cho dropdown chọn dịch vụ khi tạo lịch khám.
 */
export const appointmentServiceOptions: {
  type: AppointmentType;
  label: string;
  description: string;
  estimatedPrice: number;
}[] = [
  { type: "general_checkup", label: "Khám tổng quát", description: "Khám sức khỏe tổng thể, tư vấn dinh dưỡng", estimatedPrice: 250000 },
  { type: "vaccination", label: "Tiêm phòng", description: "Tiêm vaccine định kỳ DHPPi, Lepto, Rabies", estimatedPrice: 350000 },
  { type: "dental", label: "Nha khoa", description: "Làm sạch răng, điều trị nha chu", estimatedPrice: 500000 },
  { type: "dermatology", label: "Da liễu", description: "Khám và điều trị bệnh da, dị ứng", estimatedPrice: 300000 },
  { type: "surgery", label: "Phẫu thuật", description: "Tiểu phẫu, triệt sản, và phẫu thuật chuyên khoa", estimatedPrice: 1500000 },
  { type: "hotel_consultation", label: "Tư vấn lưu trú", description: "Khám sức khỏe trước khi nhận phòng hotel", estimatedPrice: 150000 },
  { type: "other", label: "Khác", description: "Dịch vụ khác theo yêu cầu", estimatedPrice: 200000 },
];

export const spaServiceOptions: {
  type: SpaAppointmentType;
  label: string;
  description: string;
  durationMinutes: number;
  estimatedPrice: number;
}[] = [
  { type: "spa_bath", label: "Tắm & sấy", description: "Tắm làm sạch, sấy khô và vệ sinh tai cơ bản", durationMinutes: 60, estimatedPrice: 250000 },
  { type: "spa_grooming", label: "Cắt tỉa & chăm sóc", description: "Cắt tỉa lông, móng và tạo kiểu theo giống", durationMinutes: 90, estimatedPrice: 450000 },
  { type: "spa_combo", label: "Spa trọn gói", description: "Tắm sấy, cắt tỉa, vệ sinh tai và chăm sóc móng", durationMinutes: 120, estimatedPrice: 650000 },
];

/**
 * Loại phòng khách sạn thú cưng.
 */
export const hotelRoomTypes: {
  key: HotelRoomType;
  label: string;
  description: string;
  pricePerNight: number;
}[] = [
  { key: "standard", label: "Standard Cabin", description: "Phòng tiêu chuẩn, đầy đủ tiện nghi cơ bản", pricePerNight: 3000 },
  { key: "deluxe", label: "Deluxe Suite", description: "Phòng cao cấp, rộng rãi, khu vực vui chơi riêng", pricePerNight: 5500 },
];

/**
 * Dịch vụ bổ sung khi lưu trú khách sạn.
 */
export const hotelServiceOptions: {
  key: HotelServiceKey;
  label: string;
  description: string;
  pricePerNight: number;
}[] = [
  { key: "grooming_spa", label: "Grooming & Spa", description: "Tắm sấy, cắt tỉa lông, chăm sóc móng", pricePerNight: 1500 },
  { key: "special_diet", label: "Chế độ ăn đặc biệt", description: "Thức ăn riêng theo yêu cầu của chủ nuôi", pricePerNight: 800 },
  { key: "video_call", label: "Video Call", description: "Cuộc gọi video để chủ nuôi xem thú cưng", pricePerNight: 500 },
  { key: "daily_walk", label: "Đi dạo hàng ngày", description: "Nhân viên đưa thú cưng đi dạo 30 phút/ngày", pricePerNight: 500 },
  { key: "medicine_support", label: "Hỗ trợ thuốc", description: "Nhân viên cho thú cưng uống thuốc theo đơn", pricePerNight: 300 },
];

/**
 * Helper: lấy label dịch vụ khám từ type
 */
export function getServiceLabel(type: AppointmentType): string {
  return appointmentServiceOptions.find((s) => s.type === type)?.label ?? spaServiceOptions.find((s) => s.type === type)?.label ?? "Dịch vụ khác";
}

/**
 * Helper: lấy label loại phòng từ key
 */
export function getRoomTypeLabel(key: HotelRoomType): string {
  return hotelRoomTypes.find((r) => r.key === key)?.label ?? key;
}

/**
 * Helper: lấy label dịch vụ hotel từ key
 */
export function getHotelServiceLabel(key: HotelServiceKey): string {
  return hotelServiceOptions.find((s) => s.key === key)?.label ?? key;
}
