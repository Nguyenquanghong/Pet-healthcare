import { Router, Request, Response } from "express";
import { db } from "../db";

export const medicalRecordsRouter = Router();

// GET /api/medical-records
medicalRecordsRouter.get("/", (req: Request, res: Response) => {
  const { petId, ownerId } = req.query;
  let list = db.get().medicalRecords;
  if (petId) list = list.filter((r) => r.petId === String(petId));
  if (ownerId) list = list.filter((r) => r.ownerId === String(ownerId));
  return res.json(list);
});

// POST /api/medical-records
medicalRecordsRouter.post("/", (req: Request, res: Response) => {
  const { petId, ownerId, appointmentId, doctorName, visitDate, title, symptoms, diagnosis, treatment, medications, vaccineName, followUpDate, weightKg, temperatureC, heartRateBpm } = req.body;
  if (!petId || !title || !visitDate) {
    return res.status(422).json({ error: "Thông tin thú cưng, tiêu đề và ngày khám là bắt buộc" });
  }

  const now = new Date().toISOString();
  const pet = db.get().pets.find((p) => p.id === petId);

  const newRecord = {
    id: `record_${Date.now()}`,
    petId,
    ownerId: ownerId || pet?.ownerId || "owner_1",
    appointmentId,
    doctorName: doctorName || "Bs. Mai Nguyễn",
    visitDate,
    title: title.trim(),
    symptoms: symptoms?.trim(),
    diagnosis: diagnosis?.trim(),
    treatment: treatment?.trim(),
    medications: medications?.trim(),
    vaccineName: vaccineName?.trim(),
    followUpDate,
    weightKg: Number(weightKg) || undefined,
    temperatureC: Number(temperatureC) || undefined,
    heartRateBpm: Number(heartRateBpm) || undefined,
    createdAt: now,
    updatedAt: now,
  };

  db.update((draft) => {
    draft.medicalRecords.unshift(newRecord);

    // Auto complete appointment if linked
    if (appointmentId) {
      const aIdx = draft.appointments.findIndex((a) => a.id === appointmentId);
      if (aIdx !== -1) {
        draft.appointments[aIdx].status = "completed";
        draft.appointments[aIdx].updatedAt = now;
      }
    }

    // Auto send notification to owner
    draft.notifications.unshift({
      id: `noti_${Date.now()}`,
      recipientOwnerId: newRecord.ownerId,
      recipientRole: "owner",
      type: "medical_record_updated",
      title: "Hồ sơ y tế mới đã được cập nhật",
      message: `Bác sĩ đã cập nhật hồ sơ ${newRecord.title} ngày ${newRecord.visitDate}.`,
      status: "sent",
      actionUrl: "/owner/medical-records",
      relatedAppointmentId: newRecord.appointmentId,
      relatedPetId: newRecord.petId,
      createdAt: now,
      sentAt: now,
    });
  });

  return res.status(201).json({ message: "Lập hồ sơ bệnh án thành công", record: newRecord });
});

// PATCH /api/medical-records/:id
medicalRecordsRouter.patch("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const idx = db.get().medicalRecords.findIndex((r) => r.id === id);
  if (idx === -1) return res.status(404).json({ error: "Không tìm thấy hồ sơ bệnh án" });

  let updatedRecord: any;
  const now = new Date().toISOString();

  db.update((draft) => {
    draft.medicalRecords[idx] = {
      ...draft.medicalRecords[idx],
      ...req.body,
      updatedAt: now,
    };
    updatedRecord = draft.medicalRecords[idx];
  });

  return res.json({ message: "Cập nhật hồ sơ bệnh án thành công", record: updatedRecord });
});

// DELETE /api/medical-records/:id
medicalRecordsRouter.delete("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  db.update((draft) => {
    draft.medicalRecords = draft.medicalRecords.filter((r) => r.id !== id);
  });
  return res.json({ message: "Đã xóa hồ sơ bệnh án" });
});
