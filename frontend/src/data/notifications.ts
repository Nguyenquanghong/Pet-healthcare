import type { Notification } from "../types/notification";

const now = new Date().toISOString();

/**
 * Mock notification data — dữ liệu thông báo mẫu.
 * Đồng bộ với initialState trong AppStoreProvider.
 */
export const mockNotifications: Notification[] = [
  {
    id: "noti_1",
    recipientOwnerId: "owner_1",
    recipientRole: "owner",
    type: "appointment_reminder",
    title: "Nhắc lịch khám",
    message: "Mochi có lịch khám vào 09:00 ngày mai tại Bệnh viện Thú y Mỹ Đình.",
    status: "sent",
    actionUrl: "/owner/appointments",
    relatedPetId: "pet_mochi",
    relatedAppointmentId: "appointment_1",
    createdAt: now,
    sentAt: now,
  },
  {
    id: "noti_2",
    recipientOwnerId: "owner_1",
    recipientRole: "owner",
    type: "vaccination_reminder",
    title: "Nhắc tiêm phòng",
    message: "Yuki cần tiêm phòng nhắc lại trong tuần này.",
    status: "sent",
    actionUrl: "/owner/appointments",
    relatedPetId: "pet_yuki",
    createdAt: now,
    sentAt: now,
  },
  {
    id: "noti_3",
    recipientRole: "admin",
    type: "appointment_created",
    title: "Lịch khám mới",
    message: "Yuki (Chủ nuôi: Nguyễn Văn A) vừa đặt lịch tiêm phòng lúc 10:30 ngày 2026-11-03.",
    status: "sent",
    actionUrl: "/admin/appointments",
    relatedPetId: "pet_yuki",
    relatedAppointmentId: "appointment_2",
    createdAt: now,
    sentAt: now,
  },
];
