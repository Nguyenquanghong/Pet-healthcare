import { Router, Request, Response } from "express";
import { db } from "../db";

export const invoicesRouter = Router();

// GET /api/invoices
invoicesRouter.get("/", (req: Request, res: Response) => {
  const { ownerId, status } = req.query;
  let list = db.get().invoices;
  if (ownerId) list = list.filter((inv) => inv.ownerId === String(ownerId));
  if (status && status !== "all") list = list.filter((inv) => inv.paymentStatus === String(status));
  return res.json(list);
});

// PATCH /api/invoices/:id/pay
invoicesRouter.patch("/:id/pay", (req: Request, res: Response) => {
  const { id } = req.params;
  const { paymentMethod } = req.body;

  const idx = db.get().invoices.findIndex((inv) => inv.id === id);
  if (idx === -1) return res.status(404).json({ error: "Không tìm thấy hóa đơn" });

  let updatedInvoice: any;
  const now = new Date().toISOString();

  db.update((draft) => {
    draft.invoices[idx] = {
      ...draft.invoices[idx],
      paymentStatus: "paid",
      paymentMethod: paymentMethod || "cash",
      paidAt: now,
    };
    updatedInvoice = draft.invoices[idx];
  });

  return res.json({ message: "Xác nhận thanh toán hóa đơn thành công", invoice: updatedInvoice });
});
