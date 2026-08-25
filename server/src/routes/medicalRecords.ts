import { Router, Request, Response } from "express";
import { db } from "../db";

export const medicalRecordsRouter = Router();

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toOptionalNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function validateRequiredRecordFields(input: {
  petId: string;
  title: string;
  visitDate: string;
  doctorName: string;
  diagnosis: string;
  treatment: string;
}) {
  if (!input.petId || !input.title || !input.visitDate || !input.doctorName || !input.diagnosis || !input.treatment) {
    return "Please complete the pet, title, visit date, doctor, diagnosis, and treatment fields.";
  }
  return "";
}

// GET /api/medical-records
medicalRecordsRouter.get("/", (req: Request, res: Response) => {
  const { petId, ownerId } = req.query;
  let list = db.get().medicalRecords;
  if (petId) list = list.filter((record) => record.petId === String(petId));
  if (ownerId) list = list.filter((record) => record.ownerId === String(ownerId));
  return res.json(list);
});

// POST /api/medical-records
medicalRecordsRouter.post("/", (req: Request, res: Response) => {
  const petId = cleanString(req.body.petId);
  const appointmentId = cleanString(req.body.appointmentId) || undefined;
  const doctorName = cleanString(req.body.doctorName);
  const visitDate = cleanString(req.body.visitDate);
  const title = cleanString(req.body.title);
  const symptoms = cleanString(req.body.symptoms);
  const diagnosis = cleanString(req.body.diagnosis);
  const treatment = cleanString(req.body.treatment);
  const medications = cleanString(req.body.medications);
  const vaccineName = cleanString(req.body.vaccineName);
  const followUpDate = cleanString(req.body.followUpDate) || undefined;

  const validationError = validateRequiredRecordFields({ petId, title, visitDate, doctorName, diagnosis, treatment });
  if (validationError) return res.status(422).json({ error: validationError });

  const now = new Date().toISOString();
  const pet = db.get().pets.find((item) => item.id === petId);
  if (!pet) return res.status(404).json({ error: "Pet not found." });

  const newRecord = {
    id: `record_${Date.now()}`,
    petId,
    ownerId: pet.ownerId,
    appointmentId,
    doctorName,
    visitDate,
    title,
    symptoms,
    diagnosis,
    treatment,
    medications,
    vaccineName: vaccineName || undefined,
    followUpDate,
    weightKg: toOptionalNumber(req.body.weightKg),
    temperatureC: toOptionalNumber(req.body.temperatureC),
    heartRateBpm: toOptionalNumber(req.body.heartRateBpm),
    createdAt: now,
    updatedAt: now,
  };

  db.update((draft) => {
    draft.medicalRecords.unshift(newRecord);

    if (appointmentId) {
      const appointmentIndex = draft.appointments.findIndex((appointment) => appointment.id === appointmentId);
      if (appointmentIndex !== -1) {
        draft.appointments[appointmentIndex].status = "completed";
        draft.appointments[appointmentIndex].updatedAt = now;
      }
    }

    draft.notifications.unshift({
      id: `noti_${Date.now()}`,
      recipientOwnerId: newRecord.ownerId,
      recipientRole: "owner",
      type: "medical_record_updated",
      title: "New medical record added",
      message: `A new medical record for ${newRecord.title} on ${newRecord.visitDate} has been added.`,
      status: "sent",
      actionUrl: "/owner/medical-records",
      relatedAppointmentId: newRecord.appointmentId,
      relatedPetId: newRecord.petId,
      createdAt: now,
      sentAt: now,
    });
  });

  return res.status(201).json({ message: "Medical record created successfully.", record: newRecord });
});

// PATCH /api/medical-records/:id
medicalRecordsRouter.patch("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const idx = db.get().medicalRecords.findIndex((record) => record.id === id);
  if (idx === -1) return res.status(404).json({ error: "Medical record not found." });

  const petId = req.body.petId !== undefined ? cleanString(req.body.petId) : undefined;
  const nextPet = petId ? db.get().pets.find((pet) => pet.id === petId) : undefined;
  if (petId && !nextPet) return res.status(404).json({ error: "Pet not found." });

  const textUpdates = {
    appointmentId: req.body.appointmentId !== undefined ? cleanString(req.body.appointmentId) || undefined : undefined,
    doctorName: req.body.doctorName !== undefined ? cleanString(req.body.doctorName) : undefined,
    title: req.body.title !== undefined ? cleanString(req.body.title) : undefined,
    symptoms: req.body.symptoms !== undefined ? cleanString(req.body.symptoms) : undefined,
    diagnosis: req.body.diagnosis !== undefined ? cleanString(req.body.diagnosis) : undefined,
    treatment: req.body.treatment !== undefined ? cleanString(req.body.treatment) : undefined,
    medications: req.body.medications !== undefined ? cleanString(req.body.medications) : undefined,
    vaccineName: req.body.vaccineName !== undefined ? cleanString(req.body.vaccineName) || undefined : undefined,
    followUpDate: req.body.followUpDate !== undefined ? cleanString(req.body.followUpDate) || undefined : undefined,
  };

  if (textUpdates.title !== undefined && !textUpdates.title) return res.status(422).json({ error: "Title is required." });
  if (textUpdates.doctorName !== undefined && !textUpdates.doctorName) return res.status(422).json({ error: "Doctor name is required." });
  if (textUpdates.diagnosis !== undefined && !textUpdates.diagnosis) return res.status(422).json({ error: "Diagnosis is required." });
  if (textUpdates.treatment !== undefined && !textUpdates.treatment) return res.status(422).json({ error: "Treatment is required." });

  let updatedRecord: any;
  const now = new Date().toISOString();

  db.update((draft) => {
    draft.medicalRecords[idx] = {
      ...draft.medicalRecords[idx],
      ...(petId ? { petId, ownerId: nextPet?.ownerId } : {}),
      ...textUpdates,
      ...(req.body.weightKg !== undefined ? { weightKg: toOptionalNumber(req.body.weightKg) } : {}),
      ...(req.body.temperatureC !== undefined ? { temperatureC: toOptionalNumber(req.body.temperatureC) } : {}),
      ...(req.body.heartRateBpm !== undefined ? { heartRateBpm: toOptionalNumber(req.body.heartRateBpm) } : {}),
      updatedAt: now,
    };
    updatedRecord = draft.medicalRecords[idx];
  });

  return res.json({ message: "Medical record updated successfully.", record: updatedRecord });
});

// DELETE /api/medical-records/:id
medicalRecordsRouter.delete("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const existing = db.get().medicalRecords.find((record) => record.id === id);
  if (!existing) return res.status(404).json({ error: "Medical record not found." });

  db.update((draft) => {
    draft.medicalRecords = draft.medicalRecords.filter((record) => record.id !== id);
  });
  return res.json({ message: "Medical record deleted successfully." });
});
