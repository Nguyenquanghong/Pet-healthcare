// AQ-10: a pending hotel stay holds rooms (hotel_room_nights). One that staff have
// not confirmed expires 48 hours after it was requested or at 12:00 Vietnam time
// on its check-in day, whichever comes first.
export const PENDING_HOLD_MS = 48 * 3_600_000;
// check_in is a calendar date (midnight UTC in the database); 12:00 at UTC+7 is 05:00Z.
const CHECK_IN_CUTOFF_AFTER_MIDNIGHT_UTC_MS = (12 - 7) * 3_600_000;

export function pendingExpiresAt(createdAt: Date, checkIn: Date): Date {
  return new Date(Math.min(createdAt.getTime() + PENDING_HOLD_MS, checkIn.getTime() + CHECK_IN_CUTOFF_AFTER_MIDNIGHT_UTC_MS));
}
// The same rule as two bounds a database query can use: expired when requested on or
// before `createdBefore`, or when checking in on or before `checkInOnOrBefore`.
export function expiryBounds(now: Date) {
  return { createdBefore: new Date(now.getTime() - PENDING_HOLD_MS), checkInOnOrBefore: new Date(now.getTime() - CHECK_IN_CUTOFF_AFTER_MIDNIGHT_UTC_MS) };
}
