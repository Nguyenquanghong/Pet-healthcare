import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { appointmentDto } from "../lib/serialize.js";

export const appointmentsRouter = Router();

const appointmentTypes = new Set([
  "general_checkup",
  "vaccination",
  "dental",
  "dermatology",
  "surgery",
  "hotel_consultation",
  "spa_bath",
  "spa_grooming",
  "spa_combo",
  "other",
]);
const spaTypes = new Set(["spa_bath", "spa_grooming", "spa_combo"]);
const appointmentStatuses = new Set(["pending", "confirmed", "checked_in", "in_progress", "completed", "cancelled", "no_show"]);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

appointmentsRouter.get("/", async (req, res) => {
  const ownerId = req.auth!.role === "owner" ? req.auth!.sub : typeof req.query.ownerId === "string" ? req.query.ownerId : undefined;
  const list = await prisma.appointment.findMany({ where: ownerId ? { ownerId } : undefined, orderBy: [{ appointmentDate: "desc" }, { appointmentTime: "desc" }] });
  res.json(list.map(appointmentDto));
});

appointmentsRouter.post("/", async (req, res) => {
  const pet = await prisma.pet.findUnique({ where: { id: String(req.body.petId || "") } });
  if (!pet) return res.status(404).json({ error: "Pet not found." });
  if (req.auth!.role === "owner" && pet.ownerId !== req.auth!.sub) return res.status(403).json({ error: "You cannot book for this pet." });
  const type = String(req.body.type || "other");
  const date = String(req.body.date || "");
  const time = String(req.body.time || "");
  const serviceName = String(req.body.serviceName || "").trim();
  if (!date || !time || !serviceName) return res.status(422).json({ error: "Pet, service, date, and time are required." });
  if (!appointmentTypes.has(type)) return res.status(422).json({ error: "Select a valid appointment service." });
  if (!datePattern.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) return res.status(422).json({ error: "Enter a valid appointment date." });
  if (!timePattern.test(time)) return res.status(422).json({ error: "Enter a valid appointment time." });
  if (date < new Date().toISOString().slice(0, 10)) return res.status(422).json({ error: "The appointment date cannot be in the past." });

  const conflictingAppointment = await prisma.appointment.findFirst({
    where: { petId: pet.id, appointmentDate: new Date(`${date}T00:00:00.000Z`), appointmentTime: time, status: { notIn: ["cancelled", "no_show"] } },
    select: { id: true },
  });
  if (conflictingAppointment) return res.status(409).json({ error: "This pet already has an appointment at the selected time." });

  const appointment = await prisma.$transaction(async (tx) => {
    const created = await tx.appointment.create({ data: {
      petId: pet.id,
      ownerId: pet.ownerId,
      doctorId: req.body.doctorId || null,
      type: type as never,
      serviceName,
      clinicName: String(req.body.clinicName || "Nippon Pet Care"),
      appointmentDate: new Date(`${date}T00:00:00.000Z`),
      appointmentTime: time,
      ownerNote: req.body.ownerNote?.trim() || null,
      createdBy: req.auth!.role === "owner" ? "owner" : "staff",
    } });
    const serviceKind = spaTypes.has(type) ? "spa booking" : "appointment";
    await tx.notification.create({ data: { recipientRole: "admin", type: "appointment_created", title: spaTypes.has(type) ? "New spa booking" : "New appointment", message: `${pet.name} has a new ${serviceKind} on ${date} at ${time}.`, actionUrl: "/admin/appointments", relatedPetId: pet.id, relatedAppointmentId: created.id } });
    return created;
  });
  res.status(201).json({ appointment: appointmentDto(appointment) });
});

appointmentsRouter.patch("/:id/status", async (req, res) => {
  if (req.auth!.role === "owner") return res.status(403).json({ error: "Staff access is required." });
  if (!appointmentStatuses.has(String(req.body.status || ""))) return res.status(422).json({ error: "Select a valid appointment status." });
  const existing = await prisma.appointment.findUnique({ where: { id: req.params.id }, include: { pet: true } });
  if (!existing) return res.status(404).json({ error: "Appointment not found." });
  const appointment = await prisma.$transaction(async (tx) => {
    const updated = await tx.appointment.update({ where: { id: existing.id }, data: { status: req.body.status as never, internalNote: req.body.internalNote ?? existing.internalNote } });
    const isSpa = spaTypes.has(existing.type);
    await tx.notification.create({ data: { recipientOwnerId: existing.ownerId, recipientRole: "owner", type: `appointment_${req.body.status}`, title: isSpa ? "Spa booking updated" : "Appointment updated", message: `${existing.pet.name}'s ${isSpa ? "spa booking" : "appointment"} is now ${req.body.status}.`, actionUrl: isSpa ? "/owner/spa-booking" : "/owner/appointments", relatedPetId: existing.petId, relatedAppointmentId: existing.id } });
    return updated;
  });
  res.json({ appointment: appointmentDto(appointment) });
});

appointmentsRouter.patch("/:id/reschedule", async (req, res) => {
  const existing = await prisma.appointment.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Appointment not found." });
  if (req.auth!.role === "owner" && existing.ownerId !== req.auth!.sub) return res.status(403).json({ error: "You cannot reschedule this appointment." });
  const date = String(req.body.date || "");
  const time = String(req.body.time || "");
  if (!datePattern.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) return res.status(422).json({ error: "Enter a valid appointment date." });
  if (!timePattern.test(time)) return res.status(422).json({ error: "Enter a valid appointment time." });
  if (date < new Date().toISOString().slice(0, 10)) return res.status(422).json({ error: "The appointment date cannot be in the past." });
  const conflict = await prisma.appointment.findFirst({
    where: { id: { not: existing.id }, petId: existing.petId, appointmentDate: new Date(`${date}T00:00:00.000Z`), appointmentTime: time, status: { notIn: ["cancelled", "no_show"] } },
    select: { id: true },
  });
  if (conflict) return res.status(409).json({ error: "This pet already has an appointment at the selected time." });
  const appointment = await prisma.$transaction(async (tx) => {
    const updated = await tx.appointment.update({ where: { id: existing.id }, data: { appointmentDate: new Date(`${date}T00:00:00.000Z`), appointmentTime: time, ownerNote: req.body.ownerNote ?? existing.ownerNote, status: "pending" } });
    await tx.notification.create({ data: { recipientRole: "admin", type: "appointment_rescheduled", title: spaTypes.has(existing.type) ? "Spa booking rescheduled" : "Appointment rescheduled", message: `${existing.serviceName} was moved to ${date} at ${time}.`, actionUrl: "/admin/appointments", relatedPetId: existing.petId, relatedAppointmentId: existing.id } });
    return updated;
  });
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
  const isSpa = spaTypes.has(item.type);
  await prisma.notification.create({ data: { recipientOwnerId: item.ownerId, recipientRole: "owner", type: "appointment_reminder", title: isSpa ? "Spa booking reminder" : "Appointment reminder", message: `${item.pet.name} has a ${isSpa ? "spa booking" : "appointment"} at ${item.appointmentTime}.`, actionUrl: isSpa ? "/owner/spa-booking" : "/owner/appointments", relatedPetId: item.petId, relatedAppointmentId: item.id } });
  res.status(201).json({ message: "Reminder sent." });
});
