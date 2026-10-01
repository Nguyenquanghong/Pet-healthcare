import { Prisma, type PrismaClient } from "@prisma/client";
import type { CounterOwnerData, OwnerRepository } from "../../application/ports/owners.js";
import { BusinessError } from "../../domain/error.js";

export class PrismaOwnerRepository implements OwnerRepository {
  constructor(private readonly client: PrismaClient) {}
  async findByContact(phone: string, email: string | null) {
    // Match existing profiles too, including formatted numbers and the +84 spelling.
    const international = `84${phone.slice(1)}`;
    const matches = await this.client.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users
      WHERE regexp_replace(phone, '[^0-9]', '', 'g') IN (${phone}, ${international})
         OR lower(email) = ${email}
      LIMIT 1
    `;
    return matches[0] ?? null;
  }
  async createCounterOwner(data: CounterOwnerData) {
    try {
      // A counter profile has no login credential; an empty hash can never verify.
      return await this.client.user.create({ data: { ...data, role: "owner", passwordHash: "", passwordSalt: "" } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new BusinessError(409, "Đã có hồ sơ dùng số điện thoại hoặc email này. Hãy tìm và chọn khách đã có.");
      throw error;
    }
  }
}
