import { Router, type Response } from "express";
import { InvoicesService } from "../application/services/invoices.js";
import { BusinessError } from "../domain/error.js";
import type { InvoiceValue } from "../application/ports/invoices.js";

const invoiceDto = (item: InvoiceValue) => ({ ...item, subtotal: Number(item.subtotal), taxAmount: Number(item.taxAmount), discountAmount: Number(item.discountAmount), totalAmount: Number(item.totalAmount) });

export function createInvoicesRouter(service: InvoicesService) {
  const router = Router();
  function failure(res: Response, error: unknown) {
    if (error instanceof BusinessError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }

  router.get("/", async (req, res) => {
    const ownerId = typeof req.query.ownerId === "string" ? req.query.ownerId : undefined;
    res.json((await service.list(req.auth!, ownerId)).map(invoiceDto));
  });

  router.patch("/:id/pay", async (req, res) => {
    try {
      const invoice = await service.pay(req.auth!, req.params.id, req.body.paymentMethod);
      res.json({ invoice: invoiceDto(invoice) });
    } catch (error) { failure(res, error); }
  });

  return router;
}
