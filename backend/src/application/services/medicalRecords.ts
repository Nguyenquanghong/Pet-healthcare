import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import { calendarDate, objectInput, optionalText, positiveNumber, requiredText } from "../../domain/validation.js";
import type { MedicalDependencies, MedicalRecordValue, MedicalUpdate, MedicalWrite } from "../ports/medicalRecords.js";

export type MedicalInput = {
  petId?: string | null; ownerId?: string | null; appointmentId?: string | null; doctorName?: string; visitDate?: string;
  title?: string; symptoms?: string | null; diagnosis?: string; treatment?: string;
  medications?: string | null; vaccineName?: string | null; followUpDate?: string | null;
  weightKg?: unknown; temperatureC?: unknown; heartRateBpm?: unknown;
  internalNote?: string | null;
};
export type ImageInput = { petId?: string; title?: string; imageUrl?: string; mimeType?: string };

const date = (value: unknown) => calendarDate(value, "Medical date");
const optionalDate = (value: unknown) => value === undefined || value === null || value === "" ? null : date(value);
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
    objectInput(input);
    const pet = await this.deps.records.findPet(requiredText(input.petId, "Pet", 200));
    if (!pet) throw new BusinessError(404, "Pet not found.");
    if (!input.title || !input.visitDate || !input.doctorName || !input.diagnosis || !input.treatment) {
      throw new BusinessError(422, "Pet, title, visit date, doctor, diagnosis, and treatment are required.");
    }
    const data: MedicalWrite = {
      petId: pet.id, ownerId: pet.ownerId, appointmentId: optionalText(input.appointmentId, "Appointment", 200),
      doctorName: requiredText(input.doctorName, "Doctor"), visitDate: date(input.visitDate), title: requiredText(input.title, "Title"),
      symptoms: optionalText(input.symptoms, "Symptoms"), diagnosis: requiredText(input.diagnosis, "Diagnosis"), treatment: requiredText(input.treatment, "Treatment"),
      medications: optionalText(input.medications, "Medications"), vaccineName: optionalText(input.vaccineName, "Vaccine"),
      followUpDate: optionalDate(input.followUpDate),
      weightKg: positiveNumber(input.weightKg, "weightKg", 999.99, false, 2), temperatureC: positiveNumber(input.temperatureC, "temperatureC", 999.9, false, 1),
      heartRateBpm: positiveNumber(input.heartRateBpm, "heartRateBpm", 2_147_483_647, true), internalNote: optionalText(input.internalNote, "Internal note"),
    };
    return this.deps.unitOfWork.run(async ({ records, notifications }) => {
      if (data.appointmentId) {
        const appointment = await records.findAppointment(data.appointmentId);
        if (!appointment) throw new BusinessError(404, "Appointment not found.");
        if (appointment.petId !== pet.id || appointment.ownerId !== pet.ownerId) {
          throw new BusinessError(422, "Appointment does not belong to this pet and owner.");
        }
      }
      const created = await records.create(data);
      if (created.appointmentId) await records.completeAppointment(created.appointmentId, actor);
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
    objectInput(input);
    const existing = await this.deps.records.find(id);
    if (!existing) throw new BusinessError(404, "Medical record not found.");
    // Existing records keep their pet, owner and appointment association. Accept unchanged
    // values from older clients, but never silently ignore a requested reassignment.
    if ((input.petId !== undefined && input.petId !== existing.petId) ||
        (input.ownerId !== undefined && input.ownerId !== existing.ownerId) ||
        (input.appointmentId !== undefined && input.appointmentId !== existing.appointmentId)) {
      throw new BusinessError(422, "Không thể đổi thú cưng, chủ nuôi hoặc lịch liên kết của bệnh án đã tạo.");
    }
    const data: MedicalUpdate = {
      ...(input.title !== undefined ? { title: requiredText(input.title, "Title") } : {}),
      ...(input.doctorName !== undefined ? { doctorName: requiredText(input.doctorName, "Doctor") } : {}),
      ...(input.visitDate !== undefined ? { visitDate: date(input.visitDate) } : {}),
      ...(input.symptoms !== undefined ? { symptoms: optionalText(input.symptoms, "Symptoms") } : {}),
      ...(input.diagnosis !== undefined ? { diagnosis: requiredText(input.diagnosis, "Diagnosis") } : {}),
      ...(input.treatment !== undefined ? { treatment: requiredText(input.treatment, "Treatment") } : {}),
      ...(input.medications !== undefined ? { medications: optionalText(input.medications, "Medications") } : {}),
      ...(input.vaccineName !== undefined ? { vaccineName: optionalText(input.vaccineName, "Vaccine") } : {}),
      ...(input.followUpDate !== undefined ? { followUpDate: optionalDate(input.followUpDate) } : {}),
      ...(input.weightKg !== undefined ? { weightKg: positiveNumber(input.weightKg, "weightKg", 999.99, false, 2) } : {}),
      ...(input.temperatureC !== undefined ? { temperatureC: positiveNumber(input.temperatureC, "temperatureC", 999.9, false, 1) } : {}),
      ...(input.heartRateBpm !== undefined ? { heartRateBpm: positiveNumber(input.heartRateBpm, "heartRateBpm", 2_147_483_647, true) } : {}),
      ...(input.internalNote !== undefined ? { internalNote: optionalText(input.internalNote, "Internal note") } : {}),
    };
    return this.deps.records.update(existing.id, data);
  }

  async delete(actor: Actor, id: string) {
    staffOnly(actor);
    await this.deps.records.delete(id);
  }

  async createImage(actor: Actor, input: ImageInput) {
    staffOnly(actor);
    objectInput(input);
    const petId = requiredText(input.petId, "Pet", 200);
    const title = requiredText(input.title, "Title"), imageUrl = requiredText(input.imageUrl, "Image", 7_000_000);
    const mimeType = requiredText(input.mimeType, "MIME type", 200);
    if (!await this.deps.records.findPet(petId)) throw new BusinessError(404, "Pet not found.");
    return this.deps.records.createImage({ petId, title, imageUrl, mimeType });
  }

  async deleteImage(actor: Actor, id: string) {
    staffOnly(actor);
    await this.deps.records.deleteImage(id);
  }
}
