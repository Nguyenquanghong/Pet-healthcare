import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import type { InvoiceRepository } from "../ports/invoices.js";

export class InvoicesService {
  constructor(private readonly invoices: InvoiceRepository) {}
  list(actor: Actor, requestedOwnerId?: string) {
    return this.invoices.list(actor.role === "owner" ? actor.sub : requestedOwnerId);
  }
  pay(actor: Actor, id: string, paymentMethod?: string) {
    if (actor.role === "owner") throw new BusinessError(403, "Staff access is required.");
    return this.invoices.pay(id, paymentMethod || "cash", new Date());
  }
}
