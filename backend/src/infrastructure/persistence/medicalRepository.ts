import type { Prisma, PrismaClient } from "@prisma/client";
import type { MedicalDependencies, MedicalNotificationWriter, MedicalRecordRepository, MedicalTransaction, MedicalUnitOfWork } from "../../application/ports/medicalRecords.js";
import { appointmentSlotWrite } from "./appointmentSlotConflict.js";
import { appendStatusEvent } from "./bookingLifecycleRepository.js";
import { BusinessError } from "../../domain/error.js";
import type { Actor } from "../../domain/auth.js";

type Client = PrismaClient | Prisma.TransactionClient;

class PrismaMedicalRecordRepository implements MedicalRecordRepository {
  constructor(private readonly client: Client) {}

  list(ownerId?: string, petId?: string) {
    return this.client.medicalRecord.findMany({ where: { ...(ownerId ? { ownerId } : {}), ...(petId ? { petId } : {}) }, orderBy: { visitDate: "desc" } });
  }
  findPet(id: string) {
    return this.client.pet.findUnique({ where: { id }, select: { id: true, ownerId: true, name: true } });
  }
  async findAppointment(id: string) {
    await this.client.$queryRaw`SELECT id FROM appointments WHERE id = ${id} FOR UPDATE`;
    return this.client.appointment.findUnique({ where: { id }, select: { id: true, petId: true, ownerId: true } });
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
  async completeAppointment(id: string, actor: Actor) {
    const before = await this.client.appointment.findUnique({ where: { id } });
    if (!before || !["checked_in", "in_progress", "completed"].includes(before.status))
      throw new BusinessError(409, "Lịch khám chưa nhận thú cưng hoặc đã bị điều chỉnh. Hãy kiểm tra lại trước khi lưu bệnh án.");
    if (before.status === "completed") return;
    const saved = await appointmentSlotWrite(this.client.appointment.update({ where: { id }, data: { status: "completed", statusRevision: { increment: 1 } } }));
    await appendStatusEvent(this.client, "appointment", id, actor, "medical_completed", before.status, "completed", saved.statusRevision);
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
