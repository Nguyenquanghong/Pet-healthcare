import { Router } from "express";
import { InvoicesService } from "../application/services/invoices.js";
import { invoiceDto } from "../lib/serialize.js";
import { failure } from "./failure.js";


export function createInvoicesRouter(service: InvoicesService) {
  const router = Router();

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
