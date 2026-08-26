import type { DailyCareNote, HotelBooking } from "../types/booking";

const now = new Date().toISOString();

/**
 * Mock hotel booking data — dữ liệu đặt phòng khách sạn thú cưng mẫu.
 * Đồng bộ với initialState trong AppStoreProvider.
 */
export const mockHotelBookings: HotelBooking[] = [
  {
    id: "booking_1",
    petId: "pet_yuki",
    ownerId: "owner_1",
    checkIn: "2026-11-10",
    checkOut: "2026-11-13",
    nights: 3,
    roomType: "deluxe",
    serviceKeys: ["special_diet"],
    totalAmount: 20100,
    status: "pending",
    ownerNote: "Yuki cần chế độ ăn ít muối.",
    dailyCareNoteIds: [],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "booking_2",
    petId: "pet_mochi",
    ownerId: "owner_1",
    checkIn: "2026-11-18",
    checkOut: "2026-11-20",
    nights: 2,
    roomType: "standard",
    serviceKeys: ["daily_walk"],
    totalAmount: 7600,
    status: "in_stay",
    dailyCareNoteIds: ["note_1"],
    createdAt: now,
    updatedAt: now,
  },
];

/**
 * Mock daily care note data — nhật ký chăm sóc mẫu.
 */
export const mockDailyCareNotes: DailyCareNote[] = [
  {
    id: "note_1",
    bookingId: "booking_2",
    date: "2026-11-19",
    eatingStatus: "good",
    mood: "happy",
    note: "Bé Mochi hôm nay ăn ngon miệng, đi dạo 30 phút trong sân vườn và rất hợp tác.",
    visibleToOwner: true,
    createdByStaffId: "staff_admin",
    createdAt: now,
  },
];
