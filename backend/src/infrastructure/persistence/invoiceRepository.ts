import type { PrismaClient } from "@prisma/client";
import type { InvoiceRepository } from "../../application/ports/invoices.js";

export class PrismaInvoiceRepository implements InvoiceRepository {
  constructor(private readonly client: PrismaClient) {}
  list(ownerId?: string) {
    return this.client.invoice.findMany({ where: ownerId ? { ownerId } : undefined, include: { items: true }, orderBy: { issuedAt: "desc" } });
  }
  pay(id: string, paymentMethod: string, paidAt: Date) {
    return this.client.invoice.update({
      where: { id },
      data: { paymentStatus: "paid", paymentMethod: paymentMethod as "cash" | "bank_transfer" | "credit_card" | "qr_code", paidAt },
      include: { items: true },
    });
  }
}
