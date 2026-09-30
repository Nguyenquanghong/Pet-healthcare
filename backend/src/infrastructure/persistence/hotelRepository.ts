import type { Prisma, PrismaClient } from "@prisma/client";
import { BusinessError } from "../../domain/error.js";
import type { HotelBookingRepository, HotelDependencies, HotelNotificationWriter, HotelTransaction, HotelUnitOfWork } from "../../application/ports/hotelBookings.js";

type Client = PrismaClient | Prisma.TransactionClient;
const noteIds = { dailyCareNotes: { select: { id: true } } } as const;

class PrismaHotelBookingRepository implements HotelBookingRepository {
  constructor(private readonly client: Client) {}
  list(ownerId?: string) {
    return this.client.hotelBooking.findMany({ where: ownerId ? { ownerId } : undefined, include: noteIds, orderBy: { createdAt: "desc" } });
  }
  find(id: string) {
    return this.client.hotelBooking.findUnique({ where: { id }, include: noteIds });
  }
  findPet(id: string) {
    return this.client.pet.findUnique({ where: { id }, select: { id: true, ownerId: true, name: true } });
  }
  async findWithPet(id: string) {
    const booking = await this.client.hotelBooking.findUnique({ where: { id }, include: { pet: { select: { name: true } } } });
    return booking ? { booking, petName: booking.pet.name } : null;
  }
  async lockPet(id: string) {
    await this.client.$queryRaw`SELECT id FROM pets WHERE id = ${id} FOR UPDATE`;
  }
  async lockActor(id: string) {
    await this.client.$queryRaw`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;
  }
  findRequest(actorId: string, key: string) {
    return this.client.hotelBookingRequest.findUnique({ where: { actorId_requestKey: { actorId, requestKey: key } },
      select: { fingerprint: true, bookingId: true } });
  }
  async saveRequest(actorId: string, key: string, fingerprint: string, bookingId: string) {
    await this.client.hotelBookingRequest.create({ data: { actorId, requestKey: key, fingerprint, bookingId } });
  }
  async hasOverlappingStay(petId: string, checkIn: Date, checkOut: Date) {
    return await this.client.hotelBooking.count({ where: { petId, status: { in: ["pending", "confirmed", "in_stay"] },
      checkIn: { lt: checkOut }, checkOut: { gt: checkIn } } }) > 0;
  }
  create(data: Parameters<HotelBookingRepository["create"]>[0]) {
    return this.client.hotelBooking.create({ data: { ...data, roomType: data.roomType as "standard" | "deluxe" | "vip" } });
  }
  async createCareNote(data: Parameters<HotelBookingRepository["createCareNote"]>[0]) {
    await this.client.$queryRaw`SELECT id FROM hotel_bookings WHERE id = ${data.bookingId} FOR UPDATE`;
    const booking = await this.client.hotelBooking.findUnique({ where: { id: data.bookingId } });
    if (!booking || booking.status !== "in_stay") throw new BusinessError(409, "Chỉ ghi nhật ký khi thú cưng đang lưu trú. Hãy tải lại trạng thái.");
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
