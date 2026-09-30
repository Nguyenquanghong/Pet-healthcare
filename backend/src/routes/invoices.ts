import { Router, type Response } from "express";
import { InvoicesService } from "../application/services/invoices.js";
import { BusinessError } from "../domain/error.js";
import type { InvoiceValue } from "../application/ports/invoices.js";

const invoiceDto = (item: InvoiceValue) => ({ ...item, transferContent: item.transferCode || item.invoiceCode.replaceAll("-", ""), subtotal: Number(item.subtotal), taxAmount: Number(item.taxAmount), discountAmount: Number(item.discountAmount), totalAmount: Number(item.totalAmount),
  items: item.items?.map((line) => ({ ...line, unitPrice: Number(line.unitPrice), amount: Number(line.amount) })) ?? [] });

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
  router.get("/:id/payment-history", async (req, res) => {
    try { res.json(await service.paymentHistory(req.auth!, req.params.id)); }
    catch (error) { failure(res, error); }
  });

  router.post("/", async (req, res) => {
    try {
      const invoice = await service.create(req.auth!, req.body ?? {});
      res.status(201).json({ invoice: invoiceDto(invoice) });
    } catch (error) { failure(res, error); }
  });

  router.patch("/:id/pay", async (req, res) => {
    try {
      const invoice = await service.pay(req.auth!, req.params.id, req.body?.paymentMethod);
      res.json({ invoice: invoiceDto(invoice) });
    } catch (error) { failure(res, error); }
  });

  router.post("/checkout", async (req, res) => {
    try { res.json({ invoice: invoiceDto(await service.checkout(req.auth!, req.body ?? {})) }); }
    catch (error) { failure(res, error); }
  });
  router.patch("/:id/onsite", async (req, res) => {
    try { res.json({ invoice: invoiceDto(await service.chooseOnsite(req.auth!, req.params.id)) }); }
    catch (error) { failure(res, error); }
  });
  router.patch("/:id/bank-transfer", async (req, res) => {
    try { res.json({ invoice: invoiceDto(await service.chooseTransfer(req.auth!, req.params.id)) }); }
    catch (error) { failure(res, error); }
  });
  router.get("/:id/transfer-qr", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.transferQr(req.auth!, req.params.id)); }
    catch (error) { failure(res, error); }
  });
  router.post("/:id/transfer-report", async (req, res) => {
    try { res.json({ invoice: invoiceDto(await service.reportTransfer(req.auth!, req.params.id, req.body?.reference)) }); }
    catch (error) { failure(res, error); }
  });
  router.post("/:id/transfer-reject", async (req, res) => {
    try { res.json({ invoice: invoiceDto(await service.rejectTransfer(req.auth!, req.params.id, req.body?.reason)) }); }
    catch (error) { failure(res, error); }
  });

  return router;
}
