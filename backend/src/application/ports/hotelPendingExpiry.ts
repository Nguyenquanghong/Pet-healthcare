export type ExpiryBounds = { createdBefore: Date; checkInOnOrBefore: Date };

export interface HotelPendingExpiryStore {
  // IDs of pending stays past the bounds, oldest first.
  duePending(bounds: ExpiryBounds, limit: number): Promise<string[]>;
  // Under the booking's row lock: re-checks that it is still pending and expired at
  // `now`, cancels it (its nights are freed by the database), records the system
  // status event and notifies the owner, in one transaction. False when nothing changed.
  expire(id: string, now: Date): Promise<boolean>;
}
