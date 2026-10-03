import { Router, type Response } from "express";
import { NotificationsService } from "../application/services/notifications.js";
import { BusinessError } from "../domain/error.js";

export function createNotificationsRouter(service: NotificationsService) {
  const router = Router();
  function failure(res: Response, error: unknown) {
    if (error instanceof BusinessError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }


  router.patch("/read-all", async (req, res) => {
    await service.markAllRead(req.auth!);
    res.json({ message: "Notifications marked as read." });
  });

  router.patch("/:id/read", async (req, res) => {
    try {
      const notification = await service.markRead(req.auth!, req.params.id);
      res.json({ notification });
    } catch (error) { failure(res, error); }
  });

  router.delete("/:id", async (req, res) => {
    try {
      await service.delete(req.auth!, req.params.id);
      res.status(204).end();
    } catch (error) { failure(res, error); }
  });

  router.post("/send", async (req, res) => {
    try {
      const notification = await service.send(req.auth!, req.body);
      res.status(201).json({ notification });
    } catch (error) { failure(res, error); }
  });

  return router;
}
