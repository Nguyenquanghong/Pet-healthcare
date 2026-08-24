/**
 * notificationService — Service Layer cho Thông báo
 *
 * Hiện tại: bọc các hàm từ useAppStore() trả về Promise.
 *
 * Khi swap sang backend thật:
 *   - getNotifications:        GET    /api/notifications?recipientId=...&role=...
 *   - markAsRead:              PATCH  /api/notifications/:id/read
 *   - markAllAsRead:           PATCH  /api/notifications/read-all
 *   - deleteNotification:      DELETE /api/notifications/:id
 *   - sendCustomNotification:  POST   /api/notifications/send
 *
 * Lưu ý về thông báo real-time:
 *   Khi có backend, nên kết nối WebSocket (Socket.IO / native WS) để push thông báo
 *   tức thì thay vì polling. Hook `useNotifications` sẽ subscribe vào channel.
 */

import type { Notification } from "../types/notification";
import type { SendCustomNotificationDTO } from "../types/dto";
import { ApiError, ApiErrorCode } from "../utils/apiError";

const SIMULATED_DELAY = 100;
const delay = <T>(v: T): Promise<T> =>
  new Promise((r) => setTimeout(() => r(v), SIMULATED_DELAY));

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Lấy danh sách thông báo của owner hiện tại. */
export async function getOwnerNotifications(
  notifications: Notification[],
  ownerId: string,
): Promise<Notification[]> {
  return delay(
    notifications.filter((n) => n.recipientOwnerId === ownerId),
  );
}

/** Lấy danh sách thông báo Admin. */
export async function getAdminNotifications(
  notifications: Notification[],
): Promise<Notification[]> {
  return delay(notifications.filter((n) => n.recipientRole === "admin"));
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Đánh dấu một thông báo là đã đọc.
 * TODO Backend: PATCH /api/notifications/:id/read
 */
export async function markNotificationRead(
  notificationId: string,
  storeFn: (id: string) => void,
): Promise<void> {
  storeFn(notificationId);
  return delay(undefined);
}

/**
 * Đánh dấu tất cả thông báo là đã đọc.
 * TODO Backend: PATCH /api/notifications/read-all
 */
export async function markAllNotificationsRead(
  storeFn: () => void,
): Promise<void> {
  storeFn();
  return delay(undefined);
}

/**
 * Xóa một thông báo.
 * TODO Backend: DELETE /api/notifications/:id
 */
export async function deleteNotification(
  notificationId: string,
  storeFn: (id: string) => void,
): Promise<void> {
  storeFn(notificationId);
  return delay(undefined);
}

/**
 * Admin gửi thông báo tùy chỉnh đến owner.
 * TODO Backend: POST /api/notifications/send
 */
export async function sendCustomNotification(
  dto: SendCustomNotificationDTO,
  storeFn: (recipientOwnerId: string, title: string, message: string) => void,
): Promise<void> {
  if (!dto.title.trim() || !dto.message.trim()) {
    throw new ApiError(
      ApiErrorCode.VALIDATION_ERROR,
      422,
      "Tiêu đề và nội dung thông báo không được để trống.",
    );
  }
  storeFn(dto.recipientOwnerId, dto.title, dto.message);
  return delay(undefined);
}
