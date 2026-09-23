import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import type { HotelDependencies, HotelBookingValue, CareNoteValue } from "../ports/hotelBookings.js";

export type HotelCreateInput = { petId?: string; checkIn?: string; checkOut?: string; roomType?: string; serviceKeys?: unknown; ownerNote?: string };
export type HotelStatusInput = { status?: string; internalNote?: string | null };
export type CareNoteInput = { note?: string; eatingStatus?: string; mood?: string; visibleToOwner?: boolean };

const roomRates: Record<string, number> = { standard: 350_000, deluxe: 600_000, vip: 1_000_000 };
const serviceRates: Record<string, number> = { grooming_spa: 180_000, special_diet: 90_000, video_call: 50_000, daily_walk: 60_000, medicine_support: 80_000 };
const staffOnly = (actor: Actor) => {
  if (actor.role === "owner") throw new BusinessError(403, "Staff access is required.");
};

export class HotelBookingsService {
  constructor(private readonly deps: HotelDependencies) {}

  list(actor: Actor, requestedOwnerId?: string) {
    return this.deps.bookings.list(actor.role === "owner" ? actor.sub : requestedOwnerId);
  }

  async create(actor: Actor, input: HotelCreateInput): Promise<HotelBookingValue> {
    const pet = await this.deps.bookings.findPet(String(input.petId || ""));
    if (!pet) throw new BusinessError(404, "Pet not found.");
    if (actor.role === "owner" && pet.ownerId !== actor.sub) throw new BusinessError(403, "You cannot book for this pet.");
    const checkIn = new Date(`${input.checkIn}T00:00:00.000Z`);
    const checkOut = new Date(`${input.checkOut}T00:00:00.000Z`);
    const nights = Math.ceil((checkOut.getTime() - checkIn.getTime()) / 86_400_000);
    if (!Number.isFinite(nights) || nights < 1) throw new BusinessError(422, "Check-out must be after check-in.");
    const roomType = input.roomType || "standard";
    const serviceKeys = Array.isArray(input.serviceKeys) ? input.serviceKeys.map(String) : [];
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
    const existing = await this.deps.bookings.findWithPet(id);
    if (!existing) throw new BusinessError(404, "Hotel booking not found.");
    return this.deps.unitOfWork.run(async ({ bookings, notifications }) => {
      const updated = await bookings.updateStatus(existing.booking.id, input.status as string, input.internalNote ?? existing.booking.internalNote);
      await notifications.create({
        recipientOwnerId: existing.booking.ownerId, recipientRole: "owner", type: `hotel_booking_${input.status}`,
        title: "Hotel booking updated", message: `${existing.petName}'s booking is now ${input.status}.`,
        actionUrl: "/owner/hotel-booking", relatedPetId: existing.booking.petId, relatedBookingId: existing.booking.id,
      });
      return updated;
    });
  }

  async cancel(actor: Actor, id: string, ownerNote?: string): Promise<HotelBookingValue> {
    const existing = await this.deps.bookings.findForCancel(id);
    if (!existing) throw new BusinessError(404, "Hotel booking not found.");
    if (actor.role === "owner" && existing.ownerId !== actor.sub) throw new BusinessError(403, "You cannot cancel this booking.");
    return this.deps.bookings.cancel(existing.id, ownerNote ? `Cancellation reason: ${ownerNote}` : existing.ownerNote);
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
