import { Router } from "express";
import { prisma } from "../lib/prisma.js";

export const notificationsRouter = Router();

function allowedNotification(req: Parameters<typeof prisma.notification.findFirst>[0], auth: Express.Request["auth"]) {
  return auth?.role === "owner" ? { ...(req || {}), where: { ...(req?.where || {}), recipientOwnerId: auth.sub } } : req;
}

notificationsRouter.get("/", async (req, res) => {
  const where = req.auth!.role === "owner" ? { recipientOwnerId: req.auth!.sub } : { recipientRole: "admin" };
  res.json(await prisma.notification.findMany({ where, orderBy: { createdAt: "desc" } }));
});

notificationsRouter.patch("/read-all", async (req, res) => {
  const where = req.auth!.role === "owner" ? { recipientOwnerId: req.auth!.sub } : { recipientRole: "admin" };
  await prisma.notification.updateMany({ where, data: { status: "read" } });
  res.json({ message: "Notifications marked as read." });
});

notificationsRouter.patch("/:id/read", async (req, res) => {
  const item = await prisma.notification.findFirst(allowedNotification({ where: { id: req.params.id } }, req.auth));
  if (!item) return res.status(404).json({ error: "Notification not found." });
  const notification = await prisma.notification.update({ where: { id: item.id }, data: { status: "read" } });
  res.json({ notification });
});

notificationsRouter.delete("/:id", async (req, res) => {
  const item = await prisma.notification.findFirst(allowedNotification({ where: { id: req.params.id } }, req.auth));
  if (!item) return res.status(404).json({ error: "Notification not found." });
  await prisma.notification.delete({ where: { id: item.id } });
  res.status(204).end();
});

notificationsRouter.post("/send", async (req, res) => {
  if (req.auth!.role === "owner") return res.status(403).json({ error: "Staff access is required." });
  if (!req.body.recipientOwnerId || !req.body.title?.trim() || !req.body.message?.trim()) return res.status(422).json({ error: "Recipient, title, and message are required." });
  const notification = await prisma.notification.create({ data: { recipientOwnerId: req.body.recipientOwnerId, recipientRole: "owner", type: "general", title: req.body.title.trim(), message: req.body.message.trim(), actionUrl: "/owner/notifications", sentByStaffId: req.auth!.sub } });
  res.status(201).json({ notification });
});
