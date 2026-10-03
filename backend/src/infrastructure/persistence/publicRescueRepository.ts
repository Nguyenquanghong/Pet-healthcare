import type { Prisma, PrismaClient } from "@prisma/client";
import type { PublicRescueDependencies, PublicRescueRepository, PublicRescueUnitOfWork } from "../../application/ports/publicRescue.js";

type Client = PrismaClient | Prisma.TransactionClient;

class PrismaPublicRescueRepository implements PublicRescueRepository {
  constructor(private readonly client: Client) {}
  async findEnabledPetWithOwner(token: string) {
    const row = await this.client.pet.findFirst({ where: { qrToken: token, qrEnabled: true }, include: { owner: true } });
    return row ? { pet: row, owner: row.owner } : null;
  }
  findEnabledPetForReport(token: string) {
    return this.client.pet.findFirst({ where: { qrToken: token, qrEnabled: true } });
  }
  async createReport(data: Parameters<PublicRescueRepository["createReport"]>[0]) {
    await this.client.rescueReport.create({ data });
  }
  async notifyOwner(data: Parameters<PublicRescueRepository["notifyOwner"]>[0]) {
    await this.client.notification.create({ data });
  }
}

class PrismaPublicRescueUnitOfWork implements PublicRescueUnitOfWork {
  constructor(private readonly client: PrismaClient) {}
  run<T>(work: (repo: PublicRescueRepository) => Promise<T>): Promise<T> {
    return this.client.$transaction(async (tx) => work(new PrismaPublicRescueRepository(tx)));
  }
}

export function createPublicRescueDependencies(client: PrismaClient): PublicRescueDependencies {
  return { reads: new PrismaPublicRescueRepository(client), unitOfWork: new PrismaPublicRescueUnitOfWork(client) };
}
