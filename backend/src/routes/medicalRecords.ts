import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { medicalRecordDto } from "../lib/serialize.js";

export const medicalRecordsRouter = Router();
const optionalNumber = (value: unknown) => value === undefined || value === "" ? undefined : Number(value);

medicalRecordsRouter.get("/", async (req, res) => {
  const ownerId = req.auth!.role === "owner" ? req.auth!.sub : typeof req.query.ownerId === "string" ? req.query.ownerId : undefined;
  const petId = typeof req.query.petId === "string" ? req.query.petId : undefined;
  const records = await prisma.medicalRecord.findMany({ where: { ...(ownerId ? { ownerId } : {}), ...(petId ? { petId } : {}) }, orderBy: { visitDate: "desc" } });
  res.json(records.map(medicalRecordDto));
});

medicalRecordsRouter.post("/", async (req, res) => {
  if (req.auth!.role === "owner") return res.status(403).json({ error: "Staff access is required." });
  const pet = await prisma.pet.findUnique({ where: { id: String(req.body.petId || "") } });
  if (!pet) return res.status(404).json({ error: "Pet not found." });
  if (!req.body.title || !req.body.visitDate || !req.body.doctorName || !req.body.diagnosis || !req.body.treatment) return res.status(422).json({ error: "Pet, title, visit date, doctor, diagnosis, and treatment are required." });

  const record = await prisma.$transaction(async (tx) => {
    const created = await tx.medicalRecord.create({ data: {
      petId: pet.id,
      ownerId: pet.ownerId,
      appointmentId: req.body.appointmentId || null,
      doctorName: String(req.body.doctorName),
      visitDate: new Date(`${req.body.visitDate}T00:00:00.000Z`),
      title: String(req.body.title),
      symptoms: req.body.symptoms?.trim() || null,
      diagnosis: String(req.body.diagnosis),
      treatment: String(req.body.treatment),
      medications: req.body.medications?.trim() || null,
      vaccineName: req.body.vaccineName?.trim() || null,
      followUpDate: req.body.followUpDate ? new Date(`${req.body.followUpDate}T00:00:00.000Z`) : null,
      weightKg: optionalNumber(req.body.weightKg),
      temperatureC: optionalNumber(req.body.temperatureC),
      heartRateBpm: optionalNumber(req.body.heartRateBpm),
      internalNote: req.body.internalNote?.trim() || null,
    } });
    if (created.appointmentId) await tx.appointment.update({ where: { id: created.appointmentId }, data: { status: "completed" } });
    await tx.notification.create({ data: { recipientOwnerId: pet.ownerId, recipientRole: "owner", type: "medical_record_updated", title: "New medical record", message: `${pet.name} has a new medical record: ${created.title}.`, actionUrl: "/owner/medical-records", relatedPetId: pet.id, relatedAppointmentId: created.appointmentId } });
    return created;
  });
  res.status(201).json({ record: medicalRecordDto(record) });
});

medicalRecordsRouter.patch("/:id", async (req, res) => {
  if (req.auth!.role === "owner") return res.status(403).json({ error: "Staff access is required." });
  const existing = await prisma.medicalRecord.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Medical record not found." });
  const record = await prisma.medicalRecord.update({ where: { id: existing.id }, data: {
    ...(req.body.title !== undefined ? { title: String(req.body.title) } : {}),
    ...(req.body.doctorName !== undefined ? { doctorName: String(req.body.doctorName) } : {}),
    ...(req.body.visitDate ? { visitDate: new Date(`${req.body.visitDate}T00:00:00.000Z`) } : {}),
    ...(req.body.symptoms !== undefined ? { symptoms: req.body.symptoms || null } : {}),
    ...(req.body.diagnosis !== undefined ? { diagnosis: String(req.body.diagnosis) } : {}),
    ...(req.body.treatment !== undefined ? { treatment: String(req.body.treatment) } : {}),
    ...(req.body.medications !== undefined ? { medications: req.body.medications || null } : {}),
    ...(req.body.vaccineName !== undefined ? { vaccineName: req.body.vaccineName || null } : {}),
    ...(req.body.followUpDate !== undefined ? { followUpDate: req.body.followUpDate ? new Date(`${req.body.followUpDate}T00:00:00.000Z`) : null } : {}),
    ...(req.body.weightKg !== undefined ? { weightKg: optionalNumber(req.body.weightKg) } : {}),
    ...(req.body.temperatureC !== undefined ? { temperatureC: optionalNumber(req.body.temperatureC) } : {}),
    ...(req.body.heartRateBpm !== undefined ? { heartRateBpm: optionalNumber(req.body.heartRateBpm) } : {}),
    ...(req.body.internalNote !== undefined ? { internalNote: req.body.internalNote || null } : {}),
  } });
  res.json({ record: medicalRecordDto(record) });
});

medicalRecordsRouter.delete("/:id", async (req, res) => {
  if (req.auth!.role === "owner") return res.status(403).json({ error: "Staff access is required." });
  await prisma.medicalRecord.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

medicalRecordsRouter.post("/images", async (req, res) => {
  if (req.auth!.role === "owner") return res.status(403).json({ error: "Staff access is required." });
  if (!req.body.petId || !req.body.title || !req.body.imageUrl || !req.body.mimeType) return res.status(422).json({ error: "Pet, title, image, and MIME type are required." });
  const image = await prisma.medicalImage.create({ data: { petId: req.body.petId, title: req.body.title, imageUrl: req.body.imageUrl, mimeType: req.body.mimeType } });
  res.status(201).json({ image });
});

medicalRecordsRouter.delete("/images/:id", async (req, res) => {
  if (req.auth!.role === "owner") return res.status(403).json({ error: "Staff access is required." });
  await prisma.medicalImage.delete({ where: { id: req.params.id } });
  res.status(204).end();
});
