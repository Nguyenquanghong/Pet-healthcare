export type NotificationType =
  | "appointment_created"
  | "appointment_reminder"
  | "appointment_confirmed"
  | "appointment_cancelled"
  | "appointment_rescheduled"
  | "medical_record_updated"
  | "hotel_booking_created"
  | "hotel_booking_confirmed"
  | "hotel_booking_cancelled"
  | "hotel_daily_update"
  | "hotel_checked_out"
  | "vaccination_reminder"
  | "promotion"
  | "general";

export type NotificationStatus = "draft" | "sent" | "read";

export type NotificationRole = "owner" | "admin";

export type Notification = {
  id: string;
  recipientOwnerId?: string;
  recipientRole?: NotificationRole;
  type: NotificationType;
  title: string;
  message: string;
  status: NotificationStatus;
  actionUrl?: string;
  relatedAppointmentId?: string;
  relatedBookingId?: string;
  relatedPetId?: string;
  sentByStaffId?: string;
  createdAt: string;
  sentAt?: string;
};