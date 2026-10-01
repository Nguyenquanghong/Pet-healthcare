import type { Prisma, PrismaClient } from "@prisma/client";
import type { PetChanges, PetRepository } from "../../application/ports/pets.js";

function mapChanges(changes: PetChanges): Prisma.PetUpdateInput {
  const { species, gender, healthStatus, ...rest } = changes;
  return {
    ...rest,
    ...(species !== undefined ? { species: species as "dog" | "cat" | "rabbit" | "other" } : {}),
    ...(gender !== undefined ? { gender: gender as "male" | "female" | "unknown" } : {}),
    ...(healthStatus !== undefined ? { healthStatus: healthStatus as "healthy" | "stable" | "vaccination_due" | "under_treatment" | "critical" } : {}),
  };
}

export class PrismaPetRepository implements PetRepository {
  constructor(private readonly client: PrismaClient) {}
  list(ownerId?: string) {
    return this.client.pet.findMany({ where: ownerId ? { ownerId } : undefined, orderBy: { createdAt: "desc" } });
  }
  find(id: string) {
    return this.client.pet.findUnique({ where: { id } });
  }
  async ownerExists(ownerId: string) {
    const user = await this.client.user.findUnique({ where: { id: ownerId }, select: { role: true } });
    return user?.role === "owner";
  }
  create(data: Parameters<PetRepository["create"]>[0]) {
    return this.client.pet.create({ data: {
      ...data,
      species: data.species as "dog" | "cat" | "rabbit" | "other",
      gender: data.gender as "male" | "female" | "unknown",
      healthStatus: data.healthStatus as "healthy" | "stable" | "vaccination_due" | "under_treatment" | "critical",
    } });
  }
  update(id: string, changes: PetChanges) {
    return this.client.pet.update({ where: { id }, data: mapChanges(changes) });
  }
}
