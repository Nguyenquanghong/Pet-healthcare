// One icon per notification type the services send (the types grouped by
// notificationCategories in @nipopeto/contracts); any other type gets the fallback.
const ICONS: Record<string, string> = {
  appointment_created: "📅",
  appointment_reminder: "🔔",
  booking_status_updated: "🔄",
  hotel_booking_created: "🏨",
  hotel_daily_update: "🐾",
  medical_record_updated: "📋",
  invoice_requested: "🧾",
  invoice_paid: "💳",
  transfer_reported: "🏦",
  transfer_rejected: "⚠️",
  payment_review: "🔍",
  pet_rescue_report: "🆘",
  general: "📢",
};

export const notificationIcon = (type: string) => ICONS[type] ?? "📨";
