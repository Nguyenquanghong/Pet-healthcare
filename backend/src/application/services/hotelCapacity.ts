import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import { authorize } from "../../domain/authorization.js";
import { todayInVietnam } from "../../domain/validation.js";
import pricing from "../../domain/pricing.json" with { type: "json" };
import type { HotelCapacityRepository } from "../ports/hotelCapacity.js";

// AQ-10: rooms per type. The database refuses any booking beyond it (trigger +
// CHECK on hotel_room_nights); an admin changes it for today and later nights.
export class HotelCapacityService {
  constructor(private readonly repository: HotelCapacityRepository) {}

  async list(actor: Actor) {
    authorize(actor, "booking.manage");
    return this.repository.list();
  }

  async set(actor: Actor, roomType: string, input: { capacity?: unknown }) {
    authorize(actor, "hotel.capacity.manage");
    if (!Object.hasOwn(pricing.roomRates, roomType)) throw new BusinessError(404, "Room type not found.");
    const capacity = input?.capacity;
    if (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity < 0 || capacity > 1000)
      throw new BusinessError(422, "Sức chứa phải là số nguyên từ 0 đến 1000.");
    return this.repository.set(roomType, capacity, new Date(`${todayInVietnam()}T00:00:00.000Z`));
  }
}
