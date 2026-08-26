import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { appointmentDto, careNoteDto, hotelBookingDto, medicalRecordDto, ownerDto, petDto } from "../lib/serialize.js";

export const bootstrapRouter = Router();

bootstrapRouter.get("/", async (req, res) => {
  const isAdmin = req.auth!.role !== "owner";
  const ownerId = isAdmin ? undefined : req.auth!.sub;
  const [owners, pets, appointments, medicalRecords, medicalImages, hotelBookings, dailyCareNotes, notifications] = await Promise.all([
    prisma.user.findMany({ where: isAdmin ? { role: "owner" } : { id: ownerId }, include: { pets: { select: { id: true } } }, orderBy: { fullName: "asc" } }),
    prisma.pet.findMany({ where: ownerId ? { ownerId } : undefined, orderBy: { createdAt: "desc" } }),
    prisma.appointment.findMany({ where: ownerId ? { ownerId } : undefined, orderBy: [{ appointmentDate: "desc" }, { appointmentTime: "desc" }] }),
    prisma.medicalRecord.findMany({ where: ownerId ? { ownerId } : undefined, orderBy: { visitDate: "desc" } }),
    prisma.medicalImage.findMany({ where: ownerId ? { pet: { ownerId } } : undefined, orderBy: { createdAt: "desc" } }),
    prisma.hotelBooking.findMany({ where: ownerId ? { ownerId } : undefined, include: { dailyCareNotes: { select: { id: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.dailyCareNote.findMany({ where: ownerId ? { booking: { ownerId }, visibleToOwner: true } : undefined, orderBy: { createdAt: "desc" } }),
    prisma.notification.findMany({ where: isAdmin ? { recipientRole: "admin" } : { recipientOwnerId: ownerId }, orderBy: { createdAt: "desc" } }),
  ]);

  res.json({
    currentOwnerId: ownerId ?? owners[0]?.id ?? "",
    owners: owners.map(ownerDto),
    pets: pets.map(petDto),
    appointments: appointments.map(appointmentDto),
    medicalRecords: medicalRecords.map(medicalRecordDto),
    medicalImages,
    hotelBookings: hotelBookings.map(hotelBookingDto),
    dailyCareNotes: dailyCareNotes.map(careNoteDto),
    notifications,
  });
});
