import type { Actor } from "../../domain/auth.js";
import type { BootstrapRepository } from "../ports/bootstrap.js";

export class BootstrapService {
  constructor(private readonly repository: BootstrapRepository) {}

  async load(actor: Actor) {
    const isAdmin = actor.role !== "owner";
    const ownerId = isAdmin ? undefined : actor.sub;
    const data = await this.repository.load(isAdmin, ownerId);
    return { currentOwnerId: ownerId ?? data.owners[0]?.id ?? "", ...data };
  }
}
