import { Prisma, type PrismaClient } from "@prisma/client";
import type { ActivationOwner, ActivationTransaction, OwnerActivationRepository } from "../../application/ports/ownerActivation.js";
import type { UserAccount } from "../../application/ports/auth.js";
import { BusinessError } from "../../domain/error.js";
const ownerValue = (user: UserAccount): ActivationOwner => ({ id: user.id, fullName: user.fullName, email: user.email, role: user.role,
  loginEnabled: Boolean(user.passwordHash && user.passwordSalt) });

export class PrismaOwnerActivationRepository implements OwnerActivationRepository {
  constructor(private readonly client: PrismaClient) {}
  async findInvitation(tokenHash: string) {
    const value = await this.client.ownerActivation.findUnique({ where: { tokenHash }, include: { owner: true } });
    return value ? { ...value, owner: ownerValue(value.owner) } : null;
  }
  async run<T>(ownerId: string, work: (tx: ActivationTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.client.$transaction(async client => {
        // Issue/reissue/consume for one customer share a lock, including double submits.
        await client.$queryRaw`SELECT id FROM users WHERE id = ${ownerId} FOR UPDATE`;
        const owner = await client.user.findUnique({ where: { id: ownerId } });
        if (!owner) throw new BusinessError(404, "Không tìm thấy hồ sơ khách.");
        return work({
          owner: ownerValue(owner),
          emailTaken: async email => Boolean(await client.user.findFirst({ where: { id: { not: ownerId }, email: { equals: email, mode: "insensitive" } }, select: { id: true } })),
          findInvitation: async tokenHash => {
            const value = await client.ownerActivation.findUnique({ where: { tokenHash, ownerId } });
            return value ? { ...value, owner: ownerValue(owner) } : null;
          },
          revokePending: async now => { await client.ownerActivation.updateMany({ where: { ownerId, usedAt: null, revokedAt: null }, data: { revokedAt: now } }); },
          createInvitation: async data => {
            const issuer = await client.user.findUnique({ where: { id: data.issuedBy }, select: { fullName: true } });
            await client.ownerActivation.create({ data: { ...data, ownerId, issuedByName: issuer?.fullName ?? data.issuedBy } });
          },
          setCredentials: async (email, credentials) => { await client.user.update({ where: { id: ownerId }, data: { email, ...credentials } }); },
          markUsed: async (id, now) => { await client.ownerActivation.update({ where: { id }, data: { usedAt: now } }); },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new BusinessError(409, "Email đã thuộc hồ sơ khác. Liên hệ cửa hàng để kiểm tra lại.");
      throw error;
    }
  }
}
