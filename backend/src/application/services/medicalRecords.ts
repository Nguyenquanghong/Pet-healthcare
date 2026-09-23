import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import type { MedicalDependencies, MedicalRecordValue, MedicalUpdate, MedicalWrite } from "../ports/medicalRecords.js";

export type MedicalInput = {
  petId?: string; appointmentId?: string; doctorName?: string; visitDate?: string;
  title?: string; symptoms?: string | null; diagnosis?: string; treatment?: string;
  medications?: string | null; vaccineName?: string | null; followUpDate?: string | null;
  weightKg?: unknown; temperatureC?: unknown; heartRateBpm?: unknown;
  internalNote?: string | null;
};
export type ImageInput = { petId?: string; title?: string; imageUrl?: string; mimeType?: string };

const optionalNumber = (value: unknown) => value === undefined || value === "" ? undefined : Number(value);
const date = (value: string) => new Date(`${value}T00:00:00.000Z`);
const staffOnly = (actor: Actor) => {
  if (actor.role === "owner") throw new BusinessError(403, "Staff access is required.");
};

export class MedicalRecordsService {
  constructor(private readonly deps: MedicalDependencies) {}

  list(actor: Actor, requestedOwnerId?: string, petId?: string) {
    return this.deps.records.list(actor.role === "owner" ? actor.sub : requestedOwnerId, petId);
  }

  async create(actor: Actor, input: MedicalInput): Promise<MedicalRecordValue> {
    staffOnly(actor);
    const pet = await this.deps.records.findPet(String(input.petId || ""));
    if (!pet) throw new BusinessError(404, "Pet not found.");
    if (!input.title || !input.visitDate || !input.doctorName || !input.diagnosis || !input.treatment) {
      throw new BusinessError(422, "Pet, title, visit date, doctor, diagnosis, and treatment are required.");
    }
    const data: MedicalWrite = {
      petId: pet.id, ownerId: pet.ownerId, appointmentId: input.appointmentId || null,
      doctorName: String(input.doctorName), visitDate: date(input.visitDate), title: String(input.title),
      symptoms: input.symptoms?.trim() || null, diagnosis: String(input.diagnosis), treatment: String(input.treatment),
      medications: input.medications?.trim() || null, vaccineName: input.vaccineName?.trim() || null,
      followUpDate: input.followUpDate ? date(input.followUpDate) : null,
      weightKg: optionalNumber(input.weightKg), temperatureC: optionalNumber(input.temperatureC),
      heartRateBpm: optionalNumber(input.heartRateBpm), internalNote: input.internalNote?.trim() || null,
    };
    return this.deps.unitOfWork.run(async ({ records, notifications }) => {
      const created = await records.create(data);
      if (created.appointmentId) await records.completeAppointment(created.appointmentId);
      await notifications.create({
        recipientOwnerId: pet.ownerId, recipientRole: "owner", type: "medical_record_updated",
        title: "New medical record", message: `${pet.name} has a new medical record: ${created.title}.`,
        actionUrl: "/owner/medical-records", relatedPetId: pet.id, relatedAppointmentId: created.appointmentId,
      });
      return created;
    });
  }

  async update(actor: Actor, id: string, input: MedicalInput): Promise<MedicalRecordValue> {
    staffOnly(actor);
    const existing = await this.deps.records.find(id);
    if (!existing) throw new BusinessError(404, "Medical record not found.");
    const data: MedicalUpdate = {
      ...(input.title !== undefined ? { title: String(input.title) } : {}),
      ...(input.doctorName !== undefined ? { doctorName: String(input.doctorName) } : {}),
      ...(input.visitDate ? { visitDate: date(input.visitDate) } : {}),
      ...(input.symptoms !== undefined ? { symptoms: input.symptoms || null } : {}),
      ...(input.diagnosis !== undefined ? { diagnosis: String(input.diagnosis) } : {}),
      ...(input.treatment !== undefined ? { treatment: String(input.treatment) } : {}),
      ...(input.medications !== undefined ? { medications: input.medications || null } : {}),
      ...(input.vaccineName !== undefined ? { vaccineName: input.vaccineName || null } : {}),
      ...(input.followUpDate !== undefined ? { followUpDate: input.followUpDate ? date(input.followUpDate) : null } : {}),
      ...(input.weightKg !== undefined ? { weightKg: optionalNumber(input.weightKg) } : {}),
      ...(input.temperatureC !== undefined ? { temperatureC: optionalNumber(input.temperatureC) } : {}),
      ...(input.heartRateBpm !== undefined ? { heartRateBpm: optionalNumber(input.heartRateBpm) } : {}),
      ...(input.internalNote !== undefined ? { internalNote: input.internalNote || null } : {}),
    };
    return this.deps.records.update(existing.id, data);
  }

  async delete(actor: Actor, id: string) {
    staffOnly(actor);
    await this.deps.records.delete(id);
  }

  async createImage(actor: Actor, input: ImageInput) {
    staffOnly(actor);
    if (!input.petId || !input.title || !input.imageUrl || !input.mimeType) throw new BusinessError(422, "Pet, title, image, and MIME type are required.");
    return this.deps.records.createImage({ petId: input.petId, title: input.title, imageUrl: input.imageUrl, mimeType: input.mimeType });
  }

  async deleteImage(actor: Actor, id: string) {
    staffOnly(actor);
    await this.deps.records.deleteImage(id);
  }
}
