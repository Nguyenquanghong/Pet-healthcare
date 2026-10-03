import type { Actor } from "../../domain/auth.js";
import type { BootstrapRepository } from "../ports/bootstrap.js";
import { BusinessError } from "../../domain/error.js";

export class BootstrapService {
  constructor(private readonly repository: BootstrapRepository) {}

  async load(actor: Actor, view: unknown = "session") {
    if (view !== "session" && view !== "dashboard") throw new BusinessError(422, "Invalid bootstrap view.");
    const isAdmin = actor.role !== "owner";
    const ownerId = isAdmin ? undefined : actor.sub;
    const data = await this.repository.load(isAdmin, ownerId, view);
    return { currentOwnerId: ownerId ?? data.owners[0]?.id ?? "", ...data };
  }
}
