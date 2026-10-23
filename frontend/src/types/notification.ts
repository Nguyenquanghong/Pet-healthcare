import type { ApiSchemas } from "./generated/api";

// AQ-07: generated from the OpenAPI contract (types/generated/api.ts). The API's
// `type` is an open set; NotificationType names the ones the UI styles specially.
export type Notification = ApiSchemas["Notification"];
export type NotificationStatus = Notification["status"];
export type NotificationRole = Notification["recipientRole"];
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
  | "pet_rescue_report"
  | "promotion"
  | "general";
