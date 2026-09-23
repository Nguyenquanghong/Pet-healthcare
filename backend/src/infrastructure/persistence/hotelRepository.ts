import type { Prisma, PrismaClient } from "@prisma/client";
import type { HotelBookingRepository, HotelDependencies, HotelNotificationWriter, HotelTransaction, HotelUnitOfWork } from "../../application/ports/hotelBookings.js";

type Client = PrismaClient | Prisma.TransactionClient;
const noteIds = { dailyCareNotes: { select: { id: true } } } as const;

class PrismaHotelBookingRepository implements HotelBookingRepository {
  constructor(private readonly client: Client) {}
  list(ownerId?: string) {
    return this.client.hotelBooking.findMany({ where: ownerId ? { ownerId } : undefined, include: noteIds, orderBy: { createdAt: "desc" } });
  }
  findPet(id: string) {
    return this.client.pet.findUnique({ where: { id }, select: { id: true, ownerId: true, name: true } });
  }
  async findWithPet(id: string) {
    const booking = await this.client.hotelBooking.findUnique({ where: { id }, include: { pet: { select: { name: true } } } });
    return booking ? { booking, petName: booking.pet.name } : null;
  }
  findForCancel(id: string) {
    return this.client.hotelBooking.findUnique({ where: { id }, include: noteIds });
  }
  create(data: Parameters<HotelBookingRepository["create"]>[0]) {
    return this.client.hotelBooking.create({ data: { ...data, roomType: data.roomType as "standard" | "deluxe" | "vip" } });
  }
  updateStatus(id: string, status: string, internalNote: string | null) {
    return this.client.hotelBooking.update({ where: { id }, data: { status: status as "pending" | "confirmed" | "in_stay" | "checked_out" | "cancelled" | "rejected", internalNote }, include: noteIds });
  }
  cancel(id: string, ownerNote: string | null) {
    return this.client.hotelBooking.update({ where: { id }, data: { status: "cancelled", ownerNote }, include: noteIds });
  }
  createCareNote(data: Parameters<HotelBookingRepository["createCareNote"]>[0]) {
    return this.client.dailyCareNote.create({ data });
  }
}

class PrismaHotelNotificationWriter implements HotelNotificationWriter {
  constructor(private readonly client: Client) {}
  async create(draft: Parameters<HotelNotificationWriter["create"]>[0]) {
    await this.client.notification.create({ data: draft });
  }
}

class PrismaHotelUnitOfWork implements HotelUnitOfWork {
  constructor(private readonly client: PrismaClient) {}
  run<T>(work: (repos: HotelTransaction) => Promise<T>): Promise<T> {
    return this.client.$transaction(async (tx) => work({
      bookings: new PrismaHotelBookingRepository(tx),
      notifications: new PrismaHotelNotificationWriter(tx),
    }));
  }
}

export function createHotelDependencies(client: PrismaClient): HotelDependencies {
  return { bookings: new PrismaHotelBookingRepository(client), unitOfWork: new PrismaHotelUnitOfWork(client) };
}
