import type { PrismaClient } from "@prisma/client";
import { BusinessError } from "../../domain/error.js";
import type { HotelCapacityRepository } from "../../application/ports/hotelCapacity.js";

type RoomType = "standard" | "deluxe" | "vip";

export class PrismaHotelCapacityRepository implements HotelCapacityRepository {
  constructor(private readonly client: PrismaClient) {}
  list() {
    return this.client.hotelRoomCapacity.findMany({ orderBy: { roomType: "asc" } });
  }
  async set(roomType: string, capacity: number, from: Date) {
    try {
      return await this.client.$transaction(async tx => {
        const saved = await tx.hotelRoomCapacity.update({ where: { roomType: roomType as RoomType }, data: { capacity } });
        await tx.hotelRoomNight.updateMany({ where: { roomType: roomType as RoomType, night: { gte: from } }, data: { capacity } });
        return saved;
      });
    } catch (error) {
      if (String((error as { message?: unknown })?.message ?? "").includes("hotel_room_nights_capacity_check"))
        throw new BusinessError(409, "Không thể giảm sức chứa xuống dưới số phòng đã đặt của các đêm tới.");
      throw error;
    }
  }
}
