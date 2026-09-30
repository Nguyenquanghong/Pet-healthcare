import { BookingLifecycleService, type LifecycleInput, type UndoInput } from "./bookingLifecycle.js";
import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import pricing from "../../domain/pricing.json" with { type: "json" };
import type { HotelDependencies, HotelBookingValue, CareNoteValue } from "../ports/hotelBookings.js";

export type HotelCreateInput = { petId?: string; checkIn?: string; checkOut?: string; roomType?: string; serviceKeys?: unknown; ownerNote?: string };
export type HotelStatusInput = LifecycleInput;
export type CareNoteInput = { note?: string; eatingStatus?: string; mood?: string; visibleToOwner?: boolean };

const roomRates: Record<string, number> = pricing.roomRates;
const serviceRates: Record<string, number> = pricing.hotelServiceRates;
const statuses = ["pending", "confirmed", "in_stay", "checked_out", "cancelled", "rejected"];
const staffOnly = (actor: Actor) => {
  if (actor.role === "owner") throw new BusinessError(403, "Staff access is required.");
};

export class HotelBookingsService {
  constructor(private readonly deps: HotelDependencies, private readonly lifecycle: BookingLifecycleService) {}

  list(actor: Actor, requestedOwnerId?: string) {
    return this.deps.bookings.list(actor.role === "owner" ? actor.sub : requestedOwnerId);
  }

  async create(actor: Actor, input: HotelCreateInput): Promise<HotelBookingValue> {
    const pet = await this.deps.bookings.findPet(String(input.petId || ""));
    if (!pet) throw new BusinessError(404, "Pet not found.");
    if (actor.role === "owner" && pet.ownerId !== actor.sub) throw new BusinessError(403, "You cannot book for this pet.");
    const checkIn = new Date(`${input.checkIn}T00:00:00.000Z`);
    const checkOut = new Date(`${input.checkOut}T00:00:00.000Z`);
    if (![checkIn, checkOut].every(value => Number.isFinite(value.getTime())) ||
        checkIn.toISOString().slice(0, 10) !== input.checkIn || checkOut.toISOString().slice(0, 10) !== input.checkOut) {
      throw new BusinessError(422, "Enter valid check-in and check-out dates.");
    }
    const nights = Math.ceil((checkOut.getTime() - checkIn.getTime()) / 86_400_000);
    if (!Number.isFinite(nights) || nights < 1) throw new BusinessError(422, "Check-out must be after check-in.");
    const roomType = input.roomType || "standard";
    if (!Object.hasOwn(roomRates, roomType)) throw new BusinessError(422, "Select a valid room type.");
    const serviceKeys = Array.isArray(input.serviceKeys) ? input.serviceKeys.map(String) : [];
    if (serviceKeys.some(key => !Object.hasOwn(serviceRates, key)) || new Set(serviceKeys).size !== serviceKeys.length) {
      throw new BusinessError(422, "Select valid, non-duplicate hotel services.");
    }
    const totalAmount = roomRates[roomType] * nights + serviceKeys.reduce((sum: number, key: string) => sum + (serviceRates[key] || 0) * nights, 0);
    const booking = await this.deps.unitOfWork.run(async ({ bookings, notifications }) => {
      const created = await bookings.create({
        petId: pet.id, ownerId: pet.ownerId, checkIn, checkOut, nights, roomType, serviceKeys,
        totalAmount, ownerNote: input.ownerNote?.trim() || null,
      });
      await notifications.create({
        recipientRole: "admin", type: "hotel_booking_created", title: "New hotel booking",
        message: `${pet.name} has requested a ${nights}-night stay.`, actionUrl: "/admin/hotel-bookings",
        relatedPetId: pet.id, relatedBookingId: created.id,
      });
      return created;
    });
    return { ...booking, dailyCareNotes: [] };
  }

  async changeStatus(actor: Actor, id: string, input: HotelStatusInput): Promise<HotelBookingValue> {
    staffOnly(actor);
    if (!statuses.includes(String(input.status))) throw new BusinessError(422, "Select a valid hotel booking status.");
    return await this.lifecycle.change(actor, "hotel", id, input) as HotelBookingValue;
  }
  async undoStatus(actor: Actor, id: string, input: UndoInput): Promise<HotelBookingValue> {
    return await this.lifecycle.undo(actor, "hotel", id, input) as HotelBookingValue;
  }
  history(actor: Actor, id: string) { return this.lifecycle.history(actor, "hotel", id); }
  async cancel(actor: Actor, id: string, ownerNote?: string, expectedRevision?: unknown): Promise<HotelBookingValue> {
    return await this.lifecycle.cancel(actor, "hotel", id, expectedRevision, ownerNote) as HotelBookingValue;
  }

  async addCareNote(actor: Actor, id: string, input: CareNoteInput): Promise<CareNoteValue> {
    staffOnly(actor);
    const existing = await this.deps.bookings.findWithPet(id);
    if (!existing) throw new BusinessError(404, "Hotel booking not found.");
    if (!input.note?.trim()) throw new BusinessError(422, "Care note is required.");
    return this.deps.unitOfWork.run(async ({ bookings, notifications }) => {
      const created = await bookings.createCareNote({
        bookingId: existing.booking.id, noteDate: new Date(), eatingStatus: input.eatingStatus || "normal",
        mood: input.mood || "calm", note: input.note!.trim(),
        visibleToOwner: input.visibleToOwner !== false, createdByStaffId: actor.sub,
      });
      if (created.visibleToOwner) await notifications.create({
        recipientOwnerId: existing.booking.ownerId, recipientRole: "owner", type: "hotel_daily_update",
        title: `Daily update for ${existing.petName}`, message: created.note,
        actionUrl: "/owner/hotel-booking", relatedPetId: existing.booking.petId, relatedBookingId: existing.booking.id,
      });
      return created;
    });
  }
}
