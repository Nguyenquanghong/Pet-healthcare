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
  weightKg?: number; temperatureC?: number; heartRateBpm?: number;
  internalNote: string | null;
};

export type MedicalUpdate = Partial<Omit<MedicalWrite, "petId" | "ownerId" | "appointmentId">>;

export interface MedicalRecordRepository {
  list(ownerId?: string, petId?: string): Promise<MedicalRecordValue[]>;
  findPet(id: string): Promise<{ id: string; ownerId: string; name: string } | null>;
  findAppointment(id: string): Promise<{ id: string; petId: string; ownerId: string } | null>;
  find(id: string): Promise<MedicalRecordValue | null>;
  create(data: MedicalWrite): Promise<MedicalRecordValue>;
  update(id: string, data: MedicalUpdate): Promise<MedicalRecordValue>;
  delete(id: string): Promise<void>;
  createImage(data: { petId: string; title: string; imageUrl: string; mimeType: string }): Promise<MedicalImageValue>;
  deleteImage(id: string): Promise<void>;
  completeAppointment(id: string): Promise<void>;
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
