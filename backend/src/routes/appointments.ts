import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { appointmentDto } from "../lib/serialize.js";

export const appointmentsRouter = Router();

appointmentsRouter.get("/", async (req, res) => {
  const ownerId = req.auth!.role === "owner" ? req.auth!.sub : typeof req.query.ownerId === "string" ? req.query.ownerId : undefined;
  const list = await prisma.appointment.findMany({ where: ownerId ? { ownerId } : undefined, orderBy: [{ appointmentDate: "desc" }, { appointmentTime: "desc" }] });
  res.json(list.map(appointmentDto));
});

appointmentsRouter.post("/", async (req, res) => {
  const pet = await prisma.pet.findUnique({ where: { id: String(req.body.petId || "") } });
  if (!pet) return res.status(404).json({ error: "Pet not found." });
  if (req.auth!.role === "owner" && pet.ownerId !== req.auth!.sub) return res.status(403).json({ error: "You cannot book for this pet." });
  if (!req.body.date || !req.body.time || !req.body.serviceName) return res.status(422).json({ error: "Pet, service, date, and time are required." });

  const appointment = await prisma.$transaction(async (tx) => {
    const created = await tx.appointment.create({ data: {
      petId: pet.id,
      ownerId: pet.ownerId,
      doctorId: req.body.doctorId || null,
      type: (req.body.type || "other") as never,
      serviceName: String(req.body.serviceName),
      clinicName: String(req.body.clinicName || "Nippon Pet Care"),
      appointmentDate: new Date(`${req.body.date}T00:00:00.000Z`),
      appointmentTime: String(req.body.time),
      ownerNote: req.body.ownerNote?.trim() || null,
      createdBy: req.auth!.role === "owner" ? "owner" : "staff",
    } });
    await tx.notification.create({ data: { recipientRole: "admin", type: "appointment_created", title: "New appointment", message: `${pet.name} has a new appointment on ${req.body.date} at ${req.body.time}.`, actionUrl: "/admin/appointments", relatedPetId: pet.id, relatedAppointmentId: created.id } });
    return created;
  });
  res.status(201).json({ appointment: appointmentDto(appointment) });
});

appointmentsRouter.patch("/:id/status", async (req, res) => {
  if (req.auth!.role === "owner") return res.status(403).json({ error: "Staff access is required." });
  const existing = await prisma.appointment.findUnique({ where: { id: req.params.id }, include: { pet: true } });
  if (!existing) return res.status(404).json({ error: "Appointment not found." });
  const appointment = await prisma.$transaction(async (tx) => {
    const updated = await tx.appointment.update({ where: { id: existing.id }, data: { status: req.body.status as never, internalNote: req.body.internalNote ?? existing.internalNote } });
    await tx.notification.create({ data: { recipientOwnerId: existing.ownerId, recipientRole: "owner", type: `appointment_${req.body.status}`, title: "Appointment updated", message: `${existing.pet.name}'s appointment is now ${req.body.status}.`, actionUrl: "/owner/appointments", relatedPetId: existing.petId, relatedAppointmentId: existing.id } });
    return updated;
  });
  res.json({ appointment: appointmentDto(appointment) });
});

appointmentsRouter.patch("/:id/reschedule", async (req, res) => {
  const existing = await prisma.appointment.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Appointment not found." });
  if (req.auth!.role === "owner" && existing.ownerId !== req.auth!.sub) return res.status(403).json({ error: "You cannot reschedule this appointment." });
  const appointment = await prisma.appointment.update({ where: { id: existing.id }, data: { appointmentDate: new Date(`${req.body.date}T00:00:00.000Z`), appointmentTime: String(req.body.time), ownerNote: req.body.ownerNote ?? existing.ownerNote, status: "pending" } });
  res.json({ appointment: appointmentDto(appointment) });
});

appointmentsRouter.patch("/:id/cancel", async (req, res) => {
  const existing = await prisma.appointment.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Appointment not found." });
  if (req.auth!.role === "owner" && existing.ownerId !== req.auth!.sub) return res.status(403).json({ error: "You cannot cancel this appointment." });
  const appointment = await prisma.appointment.update({ where: { id: existing.id }, data: { status: "cancelled", ownerNote: req.body.ownerNote ? `Cancellation reason: ${req.body.ownerNote}` : existing.ownerNote } });
  res.json({ appointment: appointmentDto(appointment) });
});

appointmentsRouter.post("/:id/reminder", async (req, res) => {
  if (req.auth!.role === "owner") return res.status(403).json({ error: "Staff access is required." });
  const item = await prisma.appointment.findUnique({ where: { id: req.params.id }, include: { pet: true } });
  if (!item) return res.status(404).json({ error: "Appointment not found." });
  await prisma.notification.create({ data: { recipientOwnerId: item.ownerId, recipientRole: "owner", type: "appointment_reminder", title: "Appointment reminder", message: `${item.pet.name} has an appointment at ${item.appointmentTime}.`, actionUrl: "/owner/appointments", relatedPetId: item.petId, relatedAppointmentId: item.id } });
  res.status(201).json({ message: "Reminder sent." });
});
