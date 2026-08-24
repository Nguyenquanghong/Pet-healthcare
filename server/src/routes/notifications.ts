import { Router, Request, Response } from "express";
import { db } from "../db";

export const notificationsRouter = Router();

// GET /api/notifications
notificationsRouter.get("/", (req: Request, res: Response) => {
  const { ownerId, role } = req.query;
  let list = db.get().notifications;
  if (role === "admin") {
    list = list.filter((n) => n.recipientRole === "admin");
  } else if (ownerId) {
    list = list.filter((n) => n.recipientOwnerId === String(ownerId));
  }
  return res.json(list);
});

// PATCH /api/notifications/:id/read
notificationsRouter.patch("/:id/read", (req: Request, res: Response) => {
  const { id } = req.params;
  const idx = db.get().notifications.findIndex((n) => n.id === id);
  if (idx !== -1) {
    db.update((draft) => {
      draft.notifications[idx].status = "read";
    });
  }
  return res.json({ message: "Đã đánh dấu đã đọc" });
});

// PATCH /api/notifications/read-all
notificationsRouter.patch("/read-all", (req: Request, res: Response) => {
  const { ownerId, role } = req.body;
  db.update((draft) => {
    draft.notifications.forEach((n) => {
      if (role === "admin" && n.recipientRole === "admin") n.status = "read";
      if (ownerId && n.recipientOwnerId === ownerId) n.status = "read";
    });
  });
  return res.json({ message: "Đã đánh dấu tất cả là đã đọc" });
});

// DELETE /api/notifications/:id
notificationsRouter.delete("/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  db.update((draft) => {
    draft.notifications = draft.notifications.filter((n) => n.id !== id);
  });
  return res.json({ message: "Đã xóa thông báo" });
});

// POST /api/notifications/send
notificationsRouter.post("/send", (req: Request, res: Response) => {
  const { recipientOwnerId, title, message } = req.body;
  if (!title || !message) {
    return res.status(422).json({ error: "Tiêu đề và nội dung là bắt buộc" });
  }

  const now = new Date().toISOString();
  const noti = {
    id: `noti_${Date.now()}`,
    recipientOwnerId,
    recipientRole: "owner" as const,
    type: "general",
    title: title.trim(),
    message: message.trim(),
    status: "sent" as const,
    actionUrl: "/owner/notifications",
    createdAt: now,
    sentAt: now,
  };

  db.update((draft) => {
    draft.notifications.unshift(noti);
  });

  return res.status(201).json({ message: "Gửi thông báo thành công", notification: noti });
});
