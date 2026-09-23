import type { Prisma, PrismaClient } from "@prisma/client";
import type { AppointmentDependencies, AppointmentRepository, AppointmentTransaction, AppointmentUnitOfWork, NotificationWriter } from "../../application/ports/appointments.js";

type Client = PrismaClient | Prisma.TransactionClient;

class PrismaAppointmentRepository implements AppointmentRepository {
  constructor(private readonly client: Client) {}

  list(ownerId?: string) {
    return this.client.appointment.findMany({ where: ownerId ? { ownerId } : undefined, orderBy: [{ appointmentDate: "desc" }, { appointmentTime: "desc" }] });
  }

  async findPet(id: string) {
    return this.client.pet.findUnique({ where: { id }, select: { id: true, ownerId: true, name: true } });
  }

  find(id: string) {
    return this.client.appointment.findUnique({ where: { id } });
  }

  async findWithPet(id: string) {
    const item = await this.client.appointment.findUnique({ where: { id }, include: { pet: { select: { id: true, ownerId: true, name: true } } } });
    return item ? { appointment: item, pet: item.pet } : null;
  }

  async hasSlot(petId: string, date: Date, time: string, exceptId?: string) {
    const item = await this.client.appointment.findFirst({
      where: { ...(exceptId ? { id: { not: exceptId } } : {}), petId, appointmentDate: date, appointmentTime: time, status: { notIn: ["cancelled", "no_show"] } },
      select: { id: true },
    });
    return item !== null;
  }

  create(data: Parameters<AppointmentRepository["create"]>[0]) {
    return this.client.appointment.create({ data });
  }

  update(id: string, data: Parameters<AppointmentRepository["update"]>[1]) {
    return this.client.appointment.update({ where: { id }, data });
  }
}

class PrismaNotificationWriter implements NotificationWriter {
  constructor(private readonly client: Client) {}
  async create(draft: Parameters<NotificationWriter["create"]>[0]) {
    await this.client.notification.create({ data: draft });
  }
}

class PrismaAppointmentUnitOfWork implements AppointmentUnitOfWork {
  constructor(private readonly client: PrismaClient) {}
  run<T>(work: (repos: AppointmentTransaction) => Promise<T>): Promise<T> {
    return this.client.$transaction(async (tx) => work({
      appointments: new PrismaAppointmentRepository(tx),
      notifications: new PrismaNotificationWriter(tx),
    }));
  }
}

export function createAppointmentDependencies(client: PrismaClient): AppointmentDependencies {
  return {
    appointments: new PrismaAppointmentRepository(client),
    notifications: new PrismaNotificationWriter(client),
    unitOfWork: new PrismaAppointmentUnitOfWork(client),
  };
}
