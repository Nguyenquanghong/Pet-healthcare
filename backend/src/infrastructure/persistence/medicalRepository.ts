import type { Prisma, PrismaClient } from "@prisma/client";
import type { MedicalDependencies, MedicalNotificationWriter, MedicalRecordRepository, MedicalTransaction, MedicalUnitOfWork } from "../../application/ports/medicalRecords.js";

type Client = PrismaClient | Prisma.TransactionClient;

class PrismaMedicalRecordRepository implements MedicalRecordRepository {
  constructor(private readonly client: Client) {}

  list(ownerId?: string, petId?: string) {
    return this.client.medicalRecord.findMany({ where: { ...(ownerId ? { ownerId } : {}), ...(petId ? { petId } : {}) }, orderBy: { visitDate: "desc" } });
  }
  findPet(id: string) {
    return this.client.pet.findUnique({ where: { id }, select: { id: true, ownerId: true, name: true } });
  }
  find(id: string) {
    return this.client.medicalRecord.findUnique({ where: { id } });
  }
  create(data: Parameters<MedicalRecordRepository["create"]>[0]) {
    return this.client.medicalRecord.create({ data });
  }
  update(id: string, data: Parameters<MedicalRecordRepository["update"]>[1]) {
    return this.client.medicalRecord.update({ where: { id }, data });
  }
  async delete(id: string) {
    await this.client.medicalRecord.delete({ where: { id } });
  }
  createImage(data: Parameters<MedicalRecordRepository["createImage"]>[0]) {
    return this.client.medicalImage.create({ data });
  }
  async deleteImage(id: string) {
    await this.client.medicalImage.delete({ where: { id } });
  }
  async completeAppointment(id: string) {
    await this.client.appointment.update({ where: { id }, data: { status: "completed" } });
  }
}

class PrismaMedicalNotificationWriter implements MedicalNotificationWriter {
  constructor(private readonly client: Client) {}
  async create(draft: Parameters<MedicalNotificationWriter["create"]>[0]) {
    await this.client.notification.create({ data: draft });
  }
}

class PrismaMedicalUnitOfWork implements MedicalUnitOfWork {
  constructor(private readonly client: PrismaClient) {}
  run<T>(work: (repos: MedicalTransaction) => Promise<T>): Promise<T> {
    return this.client.$transaction(async (tx) => work({
      records: new PrismaMedicalRecordRepository(tx),
      notifications: new PrismaMedicalNotificationWriter(tx),
    }));
  }
}

export function createMedicalDependencies(client: PrismaClient): MedicalDependencies {
  return { records: new PrismaMedicalRecordRepository(client), unitOfWork: new PrismaMedicalUnitOfWork(client) };
}
