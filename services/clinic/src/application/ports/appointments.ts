import type { Actor } from "../../domain/auth.js";

export const appointmentTypes = ["general_checkup", "vaccination", "dental", "dermatology", "surgery", "hotel_consultation", "spa_bath", "spa_grooming", "spa_combo", "other"] as const;
export const appointmentStatuses = ["pending", "confirmed", "checked_in", "in_progress", "completed", "cancelled", "no_show"] as const;
export type AppointmentType = (typeof appointmentTypes)[number];
export type AppointmentStatus = (typeof appointmentStatuses)[number];

export type PetForAppointment = { id: string; ownerId: string; name: string };
export type AppointmentRecord = {
  id: string;
  petId: string;
  ownerId: string;
  doctorId: string | null;
  type: AppointmentType;
  serviceName: string;
  clinicName: string;
  appointmentDate: Date;
  appointmentTime: string;
  status: AppointmentStatus;
  statusRevision: number;
  ownerNote: string | null;
  internalNote: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type NotificationDraft = {
  recipientOwnerId?: string;
  recipientRole: string;
  type: string;
  title: string;
  message: string;
  actionUrl: string;
  relatedPetId: string;
  relatedAppointmentId: string;
};

export interface AppointmentRepository {
  list(ownerId?: string): Promise<AppointmentRecord[]>;
  findPet(id: string): Promise<PetForAppointment | null>;
  find(id: string): Promise<AppointmentRecord | null>;
  findWithPet(id: string): Promise<{ appointment: AppointmentRecord; pet: PetForAppointment } | null>;
  hasSlot(petId: string, date: Date, time: string, exceptId?: string): Promise<boolean>;
  create(data: {
    petId: string; ownerId: string; doctorId: string | null; type: AppointmentType;
    serviceName: string; clinicName: string; appointmentDate: Date; appointmentTime: string;
    ownerNote: string | null; createdBy: string;
  }): Promise<AppointmentRecord>;
}

export interface NotificationWriter {
  create(draft: NotificationDraft): Promise<void>;
}

export interface AppointmentTransaction {
  appointments: AppointmentRepository;
  notifications: NotificationWriter;
}

export interface AppointmentUnitOfWork {
  run<T>(work: (repos: AppointmentTransaction) => Promise<T>): Promise<T>;
}

export interface AppointmentDependencies {
  appointments: AppointmentRepository;
  notifications: NotificationWriter;
  unitOfWork: AppointmentUnitOfWork;
}

export type AppointmentActor = Actor;
