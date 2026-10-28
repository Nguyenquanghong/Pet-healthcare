import { createHash, randomUUID } from 'node:crypto';
import type { Actor } from '../../domain/auth.js';
import { BusinessError } from '../../domain/error.js';
import { allows, authorize } from '../../domain/authorization.js';
import {
  calendarDate,
  imageContent,
  objectInput,
  optionalText,
  positiveNumber,
  requiredText,
} from '../../domain/validation.js';
import type { BlobStore } from '../ports/blobs.js';
import type {
  MedicalDependencies,
  MedicalImageValue,
  MedicalRecordValue,
  MedicalUpdate,
  MedicalWrite,
} from '../ports/medicalRecords.js';

// doctorName is no longer read: the server decides who signs the record.
export type MedicalInput = {
  petId?: string | null;
  ownerId?: string | null;
  appointmentId?: string | null;
  doctorId?: string | null;
  visitDate?: string;
  title?: string;
  symptoms?: string | null;
  diagnosis?: string;
  treatment?: string;
  medications?: string | null;
  vaccineName?: string | null;
  followUpDate?: string | null;
  weightKg?: unknown;
  temperatureC?: unknown;
  heartRateBpm?: unknown;
  internalNote?: string | null;
  expectedRevision?: unknown;
};
export type ImageInput = { petId?: string; title?: string; imageUrl?: string; mimeType?: string };

const date = (value: unknown) => calendarDate(value, 'Medical date');
const optionalDate = (value: unknown) => (value === undefined || value === null || value === '' ? null : date(value));
const canWrite = (actor: Actor) => authorize(actor, 'medical-record.write');
// The revision the client edited: a JSON integer, or a query-string integer for DELETE.
function revisionOf(value: unknown) {
  const revision = typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0)
    throw new BusinessError(422, 'Thiếu phiên bản bệnh án. Hãy tải lại trang.');
  return revision as number;
}

export function medicalFields(input: MedicalInput) {
  objectInput(input);
  return {
    appointmentId: optionalText(input.appointmentId, 'Appointment', 200),
    doctorId: optionalText(input.doctorId, 'Doctor', 200),
    visitDate: date(input.visitDate),
    title: requiredText(input.title, 'Title'),
    symptoms: optionalText(input.symptoms, 'Symptoms'),
    diagnosis: requiredText(input.diagnosis, 'Diagnosis'),
    treatment: requiredText(input.treatment, 'Treatment'),
    medications: optionalText(input.medications, 'Medications'),
    vaccineName: optionalText(input.vaccineName, 'Vaccine'),
    followUpDate: optionalDate(input.followUpDate),
    weightKg: positiveNumber(input.weightKg, 'weightKg', 999.99, false, 2),
    temperatureC: positiveNumber(input.temperatureC, 'temperatureC', 999.9, false, 1),
    heartRateBpm: positiveNumber(input.heartRateBpm, 'heartRateBpm', 2147483647, true),
    internalNote: optionalText(input.internalNote, 'Internal note'),
  };
}

export class MedicalRecordsService {
  constructor(private readonly deps: MedicalDependencies) {}

  list(actor: Actor, requestedOwnerId?: string, petId?: string) {
    return this.deps.records.list(actor.role === 'owner' ? actor.sub : requestedOwnerId, petId);
  }

  async create(actor: Actor, input: MedicalInput): Promise<MedicalRecordValue> {
    canWrite(actor);
    objectInput(input);
    const pet = await this.deps.records.findPet(requiredText(input.petId, 'Pet', 200));
    if (!pet) throw new BusinessError(404, 'Pet not found.');
    if (!input.title || !input.visitDate || !input.diagnosis || !input.treatment) {
      throw new BusinessError(422, 'Pet, title, visit date, diagnosis, and treatment are required.');
    }
    const appointmentId = optionalText(input.appointmentId, 'Appointment', 200);
    const author = await this.author(actor, optionalText(input.doctorId, 'Doctor', 200), appointmentId);
    const data: MedicalWrite = {
      petId: pet.id,
      ownerId: pet.ownerId,
      appointmentId,
      doctorId: author.id,
      doctorName: author.fullName,
      visitDate: date(input.visitDate),
      title: requiredText(input.title, 'Title'),
      symptoms: optionalText(input.symptoms, 'Symptoms'),
      diagnosis: requiredText(input.diagnosis, 'Diagnosis'),
      treatment: requiredText(input.treatment, 'Treatment'),
      medications: optionalText(input.medications, 'Medications'),
      vaccineName: optionalText(input.vaccineName, 'Vaccine'),
      followUpDate: optionalDate(input.followUpDate),
      weightKg: positiveNumber(input.weightKg, 'weightKg', 999.99, false, 2),
      temperatureC: positiveNumber(input.temperatureC, 'temperatureC', 999.9, false, 1),
      heartRateBpm: positiveNumber(input.heartRateBpm, 'heartRateBpm', 2_147_483_647, true),
      internalNote: optionalText(input.internalNote, 'Internal note'),
    };
    return this.deps.unitOfWork.run(async ({ records, notifications }) => {
      if (data.appointmentId) {
        const appointment = await records.findAppointment(data.appointmentId);
        if (!appointment) throw new BusinessError(404, 'Appointment not found.');
        if (appointment.petId !== pet.id || appointment.ownerId !== pet.ownerId) {
          throw new BusinessError(422, 'Appointment does not belong to this pet and owner.');
        }
      }
      const created = await records.create(data, actor);
      if (created.appointmentId) await records.completeAppointment(created.appointmentId, actor);
      await notifications.create({
        recipientOwnerId: pet.ownerId,
        recipientRole: 'owner',
        type: 'medical_record_updated',
        title: 'New medical record',
        message: `${pet.name} has a new medical record: ${created.title}.`,
        actionUrl: '/owner/medical-records',
        relatedPetId: pet.id,
        relatedAppointmentId: created.appointmentId,
      });
      return created;
    });
  }

  // Information Expert: who signs comes from the session, never from the form. An
  // admin records for the doctor they choose, or else the appointment's doctor;
  // any other writer (a doctor) signs as themself. The name is a snapshot taken
  // now and kept as signed.
  private async author(actor: Actor, requested: string | null, appointmentId: string | null) {
    if (!allows(actor.role, 'medical-record.assign-doctor')) {
      if (requested && requested !== actor.sub) authorize(actor, 'medical-record.assign-doctor');
      return this.deps.records.signer();
    }
    const doctorId = requested ?? (appointmentId ? await this.deps.records.appointmentDoctor(appointmentId) : null);
    if (!doctorId)
      throw new BusinessError(422, 'Chọn bác sĩ chịu trách nhiệm cho bệnh án.', 'MEDICAL_RECORD_DOCTOR_REQUIRED');
    return this.deps.records.findDoctor(doctorId);
  }

  async update(actor: Actor, id: string, input: MedicalInput): Promise<MedicalRecordValue> {
    canWrite(actor);
    objectInput(input);
    const expectedRevision = revisionOf(input.expectedRevision);
    const existing = await this.deps.records.find(id);
    if (!existing) throw new BusinessError(404, 'Medical record not found.');
    // Existing records keep their pet, owner and appointment association. Accept unchanged
    // values from older clients, but never silently ignore a requested reassignment.
    if (
      (input.petId !== undefined && input.petId !== existing.petId) ||
      (input.ownerId !== undefined && input.ownerId !== existing.ownerId) ||
      (input.appointmentId !== undefined && input.appointmentId !== existing.appointmentId)
    ) {
      throw new BusinessError(422, 'Không thể đổi thú cưng, chủ nuôi hoặc lịch liên kết của bệnh án đã tạo.');
    }
    const data: MedicalUpdate = {
      ...(input.title !== undefined ? { title: requiredText(input.title, 'Title') } : {}),
      ...(input.visitDate !== undefined ? { visitDate: date(input.visitDate) } : {}),
      ...(input.symptoms !== undefined ? { symptoms: optionalText(input.symptoms, 'Symptoms') } : {}),
      ...(input.diagnosis !== undefined ? { diagnosis: requiredText(input.diagnosis, 'Diagnosis') } : {}),
      ...(input.treatment !== undefined ? { treatment: requiredText(input.treatment, 'Treatment') } : {}),
      ...(input.medications !== undefined ? { medications: optionalText(input.medications, 'Medications') } : {}),
      ...(input.vaccineName !== undefined ? { vaccineName: optionalText(input.vaccineName, 'Vaccine') } : {}),
      ...(input.followUpDate !== undefined ? { followUpDate: optionalDate(input.followUpDate) } : {}),
      ...(input.weightKg !== undefined
        ? { weightKg: positiveNumber(input.weightKg, 'weightKg', 999.99, false, 2) }
        : {}),
      ...(input.temperatureC !== undefined
        ? { temperatureC: positiveNumber(input.temperatureC, 'temperatureC', 999.9, false, 1) }
        : {}),
      ...(input.heartRateBpm !== undefined
        ? { heartRateBpm: positiveNumber(input.heartRateBpm, 'heartRateBpm', 2_147_483_647, true) }
        : {}),
      ...(input.internalNote !== undefined ? { internalNote: optionalText(input.internalNote, 'Internal note') } : {}),
    };
    return this.deps.records.update(existing.id, data, actor, expectedRevision);
  }

  async delete(actor: Actor, id: string, expectedRevision: unknown) {
    canWrite(actor);
    await this.deps.records.delete(id, actor, revisionOf(expectedRevision));
  }

  // AQ-15: staff-only audit history; still readable after the record is deleted.
  async history(actor: Actor, id: string) {
    authorize(actor, 'medical-record.history');
    const revisions = await this.deps.records.history(id);
    if (!revisions.length) throw new BusinessError(404, 'Medical record not found.');
    return revisions;
  }

  async createImage(actor: Actor, input: ImageInput) {
    canWrite(actor);
    objectInput(input);
    const petId = requiredText(input.petId, 'Pet', 200);
    const title = requiredText(input.title, 'Title'),
      imageUrl = requiredText(input.imageUrl, 'Image', 7_000_000);
    const mimeType = requiredText(input.mimeType, 'MIME type', 200);
    const bytes = imageContent(imageUrl, mimeType);
    if (!(await this.deps.records.findPet(petId))) throw new BusinessError(404, 'Pet not found.');
    // Claim Check: bytes go to the bucket first; the row only commits a claim on them.
    const id = randomUUID(),
      storageKey = `images/${id}`,
      sha256 = createHash('sha256').update(bytes).digest('hex');
    await this.deps.blobs.put(storageKey, bytes, mimeType);
    try {
      const created = await this.deps.records.createImage({
        id,
        petId,
        title,
        mimeType,
        storageKey,
        sizeBytes: bytes.length,
        sha256,
      });
      return medicalImageDto(created, this.deps.blobs);
    } catch (error) {
      // A crash between the two steps leaves an orphan object, found by tools/phase2/migrate-medical-images.mjs --orphans.
      await this.deps.blobs.remove(storageKey).catch(() => undefined);
      throw error;
    }
  }

  // AQ-09 retention: the image disappears from every list at once, but row and
  // object stay restorable until the window ends; drainBlobCleanup then purges both.
  async deleteImage(actor: Actor, id: string) {
    canWrite(actor);
    await this.deps.records.deleteImage(id, actor);
  }
  async restoreImage(actor: Actor, id: string) {
    authorize(actor, 'medical-record.restore');
    await this.deps.records.restoreImage(id, actor);
  }
}

// Valet Key: owner/staff access was already decided by the query that produced
// the row, so signing a URL here only ever covers rows the actor may read.
export function medicalImageDto(image: MedicalImageValue, blobs: BlobStore) {
  const signed = image.storageKey ? blobs.signedGetUrl(image.storageKey) : null;
  return {
    id: image.id,
    petId: image.petId,
    title: image.title,
    mimeType: image.mimeType,
    createdAt: image.createdAt,
    sizeBytes: image.sizeBytes,
    url: signed?.url ?? null,
    urlExpiresAt: signed ? signed.expiresAt.toISOString() : null,
  };
}
