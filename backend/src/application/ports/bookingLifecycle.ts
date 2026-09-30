import type { Actor } from "../../domain/auth.js";
import type { AppointmentRecord } from "./appointments.js";
import type { HotelBookingValue } from "./hotelBookings.js";

export type BookingKind = "appointment" | "hotel";
export type LifecycleBooking = (AppointmentRecord | HotelBookingValue) & { statusRevision: number };
export type StatusEvent = { id: string; kind: string; bookingId: string; revision: number; action: string;
  fromStatus: string; toStatus: string; actorId: string; actorName: string; actorRole: string;
  reason: string | null; reversesId: string | null; createdAt: Date };
export type BookingPatch = { internalNote?: string | null; ownerNote?: string | null; appointmentDate?: Date; appointmentTime?: string };
export interface LifecycleTransaction {
  booking: LifecycleBooking;
  dependencies(): Promise<{ medical: number; care: number; invoices: number }>;
  latestTransition(): Promise<StatusEvent | null>;
  save(status: string, patch?: BookingPatch): Promise<LifecycleBooking>;
  event(actor: Actor, action: string, from: string, to: string, revision: number, reason?: string, reversesId?: string): Promise<void>;
  notify(message: string, recipientRole?: "owner" | "admin"): Promise<void>;
}
export interface BookingLifecycleStore {
  run<T>(kind: BookingKind, id: string, work: (tx: LifecycleTransaction) => Promise<T>): Promise<T>;
  history(kind: BookingKind, id: string): Promise<StatusEvent[]>;
}
