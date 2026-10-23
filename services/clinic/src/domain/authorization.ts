import { allows, deniedMessage, type Permission } from "@nipopeto/contracts";
import type { Actor } from "./auth.js";
import { BusinessError } from "./error.js";

export type { Permission } from "@nipopeto/contracts";

// AQ-05: role-restricted operations ask the shared matrix in @nipopeto/contracts;
// ownership scope (owner reaches only their own rows) is checked by each service.
export function authorize(actor: Pick<Actor, "role">, permission: Permission): void {
  if (!allows(actor.role, permission)) throw new BusinessError(403, deniedMessage(permission));
}
