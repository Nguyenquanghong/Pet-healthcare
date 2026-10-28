// The one grouping of notifications into inbox tabs, for the Notification service
// and Core's Phase 1 list and dashboard summary. A status update belongs to the
// booking it names: hotel when it carries relatedBookingId, otherwise appointments.
// tools/phase2/check-architecture-rules.mjs fails when a type the services send is
// missing here, or when a type listed here is never sent.
export const notificationCategories = {
  appointments: ['appointment_created', 'appointment_reminder'],
  hotel: ['hotel_booking_created', 'hotel_daily_update'],
  medical: ['medical_record_updated'],
  billing: ['invoice_requested', 'invoice_paid', 'transfer_reported', 'transfer_rejected', 'payment_review'],
  rescue: ['pet_rescue_report'],
  promo: ['general'],
} as const satisfies Record<string, readonly string[]>;
export type NotificationCategory = keyof typeof notificationCategories;
export const notificationCategoryNames = Object.keys(notificationCategories) as NotificationCategory[];
export const bookingStatusUpdated = 'booking_status_updated';
export const notificationTypes: string[] = [...Object.values(notificationCategories).flat(), bookingStatusUpdated];

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === 'string' && Object.hasOwn(notificationCategories, value);
}
export function notificationCategory(row: {
  type: string;
  relatedBookingId?: string | null;
}): NotificationCategory | undefined {
  if (row.type === bookingStatusUpdated) return row.relatedBookingId ? 'hotel' : 'appointments';
  return notificationCategoryNames.find(category =>
    (notificationCategories[category] as readonly string[]).includes(row.type),
  );
}

// Prisma filters, structurally valid for every service's Notification model.
type TypeFilter = { type: { in: string[] } };
type StatusUpdateFilter = { type: typeof bookingStatusUpdated; relatedBookingId: null | { not: null } };
export const hotelStatusUpdates: StatusUpdateFilter = { type: bookingStatusUpdated, relatedBookingId: { not: null } };
export function notificationCategoryWhere(
  category: NotificationCategory,
): TypeFilter | { OR: (TypeFilter | StatusUpdateFilter)[] } {
  const listed: TypeFilter = { type: { in: [...notificationCategories[category]] } };
  if (category === 'appointments') return { OR: [listed, { type: bookingStatusUpdated, relatedBookingId: null }] };
  if (category === 'hotel') return { OR: [listed, hotelStatusUpdates] };
  return listed;
}
// Tab counts from a group-by on type plus the count matching `hotelStatusUpdates`
// (the only type whose tab depends on another column). Empty tabs are omitted.
export function notificationCategoryCounts(
  byType: readonly { type: string; count: number }[],
  hotelStatusUpdateCount: number,
) {
  const counts: Partial<Record<NotificationCategory, number>> = {};
  const add = (category: NotificationCategory | undefined, n: number) => {
    if (category && n > 0) counts[category] = (counts[category] ?? 0) + n;
  };
  for (const row of byType) {
    if (row.type !== bookingStatusUpdated) add(notificationCategory(row), row.count);
    else {
      add('hotel', hotelStatusUpdateCount);
      add('appointments', row.count - hotelStatusUpdateCount);
    }
  }
  return counts;
}
