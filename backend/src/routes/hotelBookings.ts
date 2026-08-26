import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { careNoteDto, hotelBookingDto } from "../lib/serialize.js";

export const hotelBookingsRouter = Router();
const roomRates = { standard: 350_000, deluxe: 600_000, vip: 1_000_000 };
const serviceRates: Record<string, number> = { grooming_spa: 180_000, special_diet: 90_000, video_call: 50_000, daily_walk: 60_000, medicine_support: 80_000 };

hotelBookingsRouter.get("/", async (req, res) => {
  const ownerId = req.auth!.role === "owner" ? req.auth!.sub : typeof req.query.ownerId === "string" ? req.query.ownerId : undefined;
  const bookings = await prisma.hotelBooking.findMany({ where: ownerId ? { ownerId } : undefined, include: { dailyCareNotes: { select: { id: true } } }, orderBy: { createdAt: "desc" } });
  res.json(bookings.map(hotelBookingDto));
});

hotelBookingsRouter.post("/", async (req, res) => {
  const pet = await prisma.pet.findUnique({ where: { id: String(req.body.petId || "") } });
  if (!pet) return res.status(404).json({ error: "Pet not found." });
  if (req.auth!.role === "owner" && pet.ownerId !== req.auth!.sub) return res.status(403).json({ error: "You cannot book for this pet." });
  const checkIn = new Date(`${req.body.checkIn}T00:00:00.000Z`);
  const checkOut = new Date(`${req.body.checkOut}T00:00:00.000Z`);
  const nights = Math.ceil((checkOut.getTime() - checkIn.getTime()) / 86_400_000);
  if (!Number.isFinite(nights) || nights < 1) return res.status(422).json({ error: "Check-out must be after check-in." });
  const roomType = (req.body.roomType || "standard") as keyof typeof roomRates;
  const serviceKeys = Array.isArray(req.body.serviceKeys) ? req.body.serviceKeys.map(String) : [];
  const totalAmount = roomRates[roomType] * nights + serviceKeys.reduce((sum: number, key: string) => sum + (serviceRates[key] || 0) * nights, 0);

  const booking = await prisma.$transaction(async (tx) => {
    const created = await tx.hotelBooking.create({ data: { petId: pet.id, ownerId: pet.ownerId, checkIn, checkOut, nights, roomType, serviceKeys, totalAmount, ownerNote: req.body.ownerNote?.trim() || null } });
    await tx.notification.create({ data: { recipientRole: "admin", type: "hotel_booking_created", title: "New hotel booking", message: `${pet.name} has requested a ${nights}-night stay.`, actionUrl: "/admin/hotel-bookings", relatedPetId: pet.id, relatedBookingId: created.id } });
    return created;
  });
  res.status(201).json({ booking: hotelBookingDto({ ...booking, dailyCareNotes: [] }) });
});

hotelBookingsRouter.patch("/:id/status", async (req, res) => {
  if (req.auth!.role === "owner") return res.status(403).json({ error: "Staff access is required." });
  const existing = await prisma.hotelBooking.findUnique({ where: { id: req.params.id }, include: { pet: true } });
  if (!existing) return res.status(404).json({ error: "Hotel booking not found." });
  const booking = await prisma.$transaction(async (tx) => {
    const updated = await tx.hotelBooking.update({ where: { id: existing.id }, data: { status: req.body.status as never, internalNote: req.body.internalNote ?? existing.internalNote }, include: { dailyCareNotes: { select: { id: true } } } });
    await tx.notification.create({ data: { recipientOwnerId: existing.ownerId, recipientRole: "owner", type: `hotel_booking_${req.body.status}`, title: "Hotel booking updated", message: `${existing.pet.name}'s booking is now ${req.body.status}.`, actionUrl: "/owner/hotel-booking", relatedPetId: existing.petId, relatedBookingId: existing.id } });
    return updated;
  });
  res.json({ booking: hotelBookingDto(booking) });
});

hotelBookingsRouter.patch("/:id/cancel", async (req, res) => {
  const existing = await prisma.hotelBooking.findUnique({ where: { id: req.params.id }, include: { dailyCareNotes: { select: { id: true } } } });
  if (!existing) return res.status(404).json({ error: "Hotel booking not found." });
  if (req.auth!.role === "owner" && existing.ownerId !== req.auth!.sub) return res.status(403).json({ error: "You cannot cancel this booking." });
  const booking = await prisma.hotelBooking.update({ where: { id: existing.id }, data: { status: "cancelled", ownerNote: req.body.ownerNote ? `Cancellation reason: ${req.body.ownerNote}` : existing.ownerNote }, include: { dailyCareNotes: { select: { id: true } } } });
  res.json({ booking: hotelBookingDto(booking) });
});

hotelBookingsRouter.post("/:id/care-notes", async (req, res) => {
  if (req.auth!.role === "owner") return res.status(403).json({ error: "Staff access is required." });
  const booking = await prisma.hotelBooking.findUnique({ where: { id: req.params.id }, include: { pet: true } });
  if (!booking) return res.status(404).json({ error: "Hotel booking not found." });
  if (!req.body.note?.trim()) return res.status(422).json({ error: "Care note is required." });
  const note = await prisma.$transaction(async (tx) => {
    const created = await tx.dailyCareNote.create({ data: { bookingId: booking.id, noteDate: new Date(), eatingStatus: req.body.eatingStatus || "normal", mood: req.body.mood || "calm", note: req.body.note.trim(), visibleToOwner: req.body.visibleToOwner !== false, createdByStaffId: req.auth!.sub } });
    if (created.visibleToOwner) await tx.notification.create({ data: { recipientOwnerId: booking.ownerId, recipientRole: "owner", type: "hotel_daily_update", title: `Daily update for ${booking.pet.name}`, message: created.note, actionUrl: "/owner/hotel-booking", relatedPetId: booking.petId, relatedBookingId: booking.id } });
    return created;
  });
  res.status(201).json({ careNote: careNoteDto(note) });
});
