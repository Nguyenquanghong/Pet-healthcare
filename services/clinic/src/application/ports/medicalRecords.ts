import type { Actor } from "../../domain/auth.js";
export type MedicalRecordValue = {
  id: string; petId: string; ownerId: string; appointmentId: string | null;
  doctorName: string; visitDate: Date; title: string; symptoms: string | null;
  diagnosis: string; treatment: string; medications: string | null;
  vaccineName: string | null; followUpDate: Date | null;
  weightKg: number | { toString(): string } | null;
  temperatureC: number | { toString(): string } | null;
  heartRateBpm: number | null; internalNote: string | null;
  createdAt: Date; updatedAt: Date;
};

export type MedicalImageValue = {
  id: string; petId: string; title: string; imageUrl: string; mimeType: string; createdAt: Date;
};

export type MedicalWrite = {
  petId: string; ownerId: string; appointmentId: string | null;
  doctorName: string; visitDate: Date; title: string; symptoms: string | null;
  diagnosis: string; treatment: string; medications: string | null;
  vaccineName: string | null; followUpDate: Date | null;
  weightKg?: number | null; temperatureC?: number | null; heartRateBpm?: number | null;
  internalNote: string | null;
};

export type MedicalUpdate = Partial<Omit<MedicalWrite, "petId" | "ownerId" | "appointmentId">>;

// AQ-15 audit entry; before/after are full record snapshots (staff-only).
export type MedicalRevisionValue = {
  id: string; recordId: string; action: "create" | "update" | "delete";
  before: unknown; after: unknown; actorId: string; actorRole: string; changedAt: Date;
};

export interface MedicalRecordRepository {
  list(ownerId?: string, petId?: string): Promise<MedicalRecordValue[]>;
  findPet(id: string): Promise<{ id: string; ownerId: string; name: string } | null>;
  findAppointment(id: string): Promise<{ id: string; petId: string; ownerId: string } | null>;
  find(id: string): Promise<MedicalRecordValue | null>;
  // Writes record a revision in the same transaction as the change.
  create(data: MedicalWrite, actor: Actor): Promise<MedicalRecordValue>;
  update(id: string, data: MedicalUpdate, actor: Actor): Promise<MedicalRecordValue>;
  delete(id: string, actor: Actor): Promise<void>;
  history(recordId: string): Promise<MedicalRevisionValue[]>;
  createImage(data: { petId: string; title: string; imageUrl: string; mimeType: string }): Promise<MedicalImageValue>;
  deleteImage(id: string): Promise<void>;
  completeAppointment(id: string, actor: Actor): Promise<void>;
}

export interface MedicalNotificationWriter {
  create(draft: { recipientOwnerId: string; recipientRole: string; type: string; title: string; message: string; actionUrl: string; relatedPetId: string; relatedAppointmentId: string | null }): Promise<void>;
}

export interface MedicalTransaction {
  records: MedicalRecordRepository;
  notifications: MedicalNotificationWriter;
}

export interface MedicalUnitOfWork {
  run<T>(work: (repos: MedicalTransaction) => Promise<T>): Promise<T>;
}

export interface MedicalDependencies {
  records: MedicalRecordRepository;
  unitOfWork: MedicalUnitOfWork;
}
