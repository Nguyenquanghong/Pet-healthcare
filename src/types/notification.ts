export type NotificationType = "appointment_reminder" | "appointment_confirmed" | "appointment_cancelled" | "medical_record_updated" | "hotel_booking_created" | "hotel_booking_confirmed" | "hotel_daily_update" | "hotel_checked_out" | "vaccination_reminder" | "promotion" | "general";
export type NotificationStatus = "draft" | "sent" | "read";

export type Notification = {
  id: string;
  recipientOwnerId: string;
  type: NotificationType;
  title: string;
  message: string;
  status: NotificationStatus;
  relatedAppointmentId?: string;
  relatedBookingId?: string;
  relatedPetId?: string;
  sentByStaffId?: string;
  createdAt: string;
  sentAt?: string;
};