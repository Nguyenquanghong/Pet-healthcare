import { Router } from "express";
import { prisma } from "../lib/prisma.js";

export const invoicesRouter = Router();
const invoiceDto = (item: Awaited<ReturnType<typeof prisma.invoice.findFirst>> & { items?: unknown[] }) => item && ({ ...item, subtotal: Number(item.subtotal), taxAmount: Number(item.taxAmount), discountAmount: Number(item.discountAmount), totalAmount: Number(item.totalAmount) });

invoicesRouter.get("/", async (req, res) => {
  const ownerId = req.auth!.role === "owner" ? req.auth!.sub : typeof req.query.ownerId === "string" ? req.query.ownerId : undefined;
  const invoices = await prisma.invoice.findMany({ where: ownerId ? { ownerId } : undefined, include: { items: true }, orderBy: { issuedAt: "desc" } });
  res.json(invoices.map(invoiceDto));
});

invoicesRouter.patch("/:id/pay", async (req, res) => {
  if (req.auth!.role === "owner") return res.status(403).json({ error: "Staff access is required." });
  const invoice = await prisma.invoice.update({ where: { id: req.params.id }, data: { paymentStatus: "paid", paymentMethod: req.body.paymentMethod || "cash", paidAt: new Date() }, include: { items: true } });
  res.json({ invoice: invoiceDto(invoice) });
});
