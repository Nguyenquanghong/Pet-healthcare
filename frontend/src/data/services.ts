import pricing from "../../../backend/src/domain/pricing.json";
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
  { type: "general_checkup", label: "Khám tổng quát", description: "Khám sức khỏe tổng thể, tư vấn dinh dưỡng", estimatedPrice: pricing.appointmentEstimates.general_checkup },
  { type: "vaccination", label: "Tiêm phòng", description: "Tiêm vaccine định kỳ DHPPi, Lepto, Rabies", estimatedPrice: pricing.appointmentEstimates.vaccination },
  { type: "dental", label: "Nha khoa", description: "Làm sạch răng, điều trị nha chu", estimatedPrice: pricing.appointmentEstimates.dental },
  { type: "dermatology", label: "Da liễu", description: "Khám và điều trị bệnh da, dị ứng", estimatedPrice: pricing.appointmentEstimates.dermatology },
  { type: "surgery", label: "Phẫu thuật", description: "Tiểu phẫu, triệt sản, và phẫu thuật chuyên khoa", estimatedPrice: pricing.appointmentEstimates.surgery },
  { type: "hotel_consultation", label: "Tư vấn lưu trú", description: "Khám sức khỏe trước khi nhận phòng hotel", estimatedPrice: pricing.appointmentEstimates.hotel_consultation },
  { type: "other", label: "Khác", description: "Dịch vụ khác theo yêu cầu", estimatedPrice: pricing.appointmentEstimates.other },
];

export const spaServiceOptions: {
  type: SpaAppointmentType;
  label: string;
  description: string;
  durationMinutes: number;
  estimatedPrice: number;
}[] = [
  { type: "spa_bath", label: "Tắm & sấy", description: "Tắm làm sạch, sấy khô và vệ sinh tai cơ bản", durationMinutes: 60, estimatedPrice: pricing.fixedSpaRates.spa_bath },
  { type: "spa_grooming", label: "Cắt tỉa & chăm sóc", description: "Cắt tỉa lông, móng và tạo kiểu theo giống", durationMinutes: 90, estimatedPrice: pricing.fixedSpaRates.spa_grooming },
  { type: "spa_combo", label: "Spa trọn gói", description: "Tắm sấy, cắt tỉa, vệ sinh tai và chăm sóc móng", durationMinutes: 120, estimatedPrice: pricing.fixedSpaRates.spa_combo },
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
  { key: "standard", label: "Standard Cabin", description: "Phòng tiêu chuẩn, đầy đủ tiện nghi cơ bản", pricePerNight: pricing.roomRates.standard },
  { key: "deluxe", label: "Deluxe Suite", description: "Phòng cao cấp, rộng rãi, khu vực vui chơi riêng", pricePerNight: pricing.roomRates.deluxe },
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
  { key: "grooming_spa", label: "Grooming & Spa", description: "Tắm sấy, cắt tỉa lông, chăm sóc móng", pricePerNight: pricing.hotelServiceRates.grooming_spa },
  { key: "special_diet", label: "Chế độ ăn đặc biệt", description: "Thức ăn riêng theo yêu cầu của chủ nuôi", pricePerNight: pricing.hotelServiceRates.special_diet },
  { key: "video_call", label: "Video Call", description: "Cuộc gọi video để chủ nuôi xem thú cưng", pricePerNight: pricing.hotelServiceRates.video_call },
  { key: "daily_walk", label: "Đi dạo hàng ngày", description: "Nhân viên đưa thú cưng đi dạo 30 phút/ngày", pricePerNight: pricing.hotelServiceRates.daily_walk },
  { key: "medicine_support", label: "Hỗ trợ thuốc", description: "Nhân viên cho thú cưng uống thuốc theo đơn", pricePerNight: pricing.hotelServiceRates.medicine_support },
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
