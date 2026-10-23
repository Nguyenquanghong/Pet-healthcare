import { Router, type Response } from "express";
import { AuthService } from "../application/services/auth.js";
import { BusinessError } from "../domain/error.js";
import { sessionUser } from "../lib/serialize.js";
import { requireAuth } from "../middleware/auth.js";
import { OwnerActivationService } from "../application/services/ownerActivation.js";

export function createAuthRouter(service: AuthService, activation: OwnerActivationService) {
  const router = Router();
  function failure(res: Response, error: unknown) {
    if(res.headersSent)return;
    if (error instanceof BusinessError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }

  router.post("/owner/login", async (req, res) => {
    try {
      const result = await service.ownerLogin(req.body);
      if(!res.headersSent)res.json({ token: result.token, user: sessionUser(result.user) });
    } catch (error) { failure(res, error); }
  });

  router.post("/admin/login", async (req, res) => {
    try {
      const result = await service.adminLogin(req.body);
      if(!res.headersSent)res.json({ token: result.token, user: sessionUser(result.user) });
    } catch (error) { failure(res, error); }
  });

  router.post("/owner/register", async (req, res) => {
    try {
      const result = await service.registerOwner(req.body);
      if(!res.headersSent)res.status(201).json({ token: result.token, user: sessionUser(result.user) });
    } catch (error) { failure(res, error); }
  });

  router.post("/owner/activation/inspect", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { const result=await activation.inspect(req.body ?? {});if(!res.headersSent)res.json(result); }
    catch (error) { failure(res, error); }
  });
  router.post("/owner/activation", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { const result=await activation.activate(req.body ?? {});if(!res.headersSent)res.json(result); }
    catch (error) { failure(res, error); }
  });

  router.get("/me", requireAuth, async (req, res) => {
    try {
      const user=await service.me(req.auth!);if(!res.headersSent)res.json({ user: sessionUser(user) });
    } catch (error) { failure(res, error); }
  });

  router.patch("/me", requireAuth, async (req, res) => {
    try {
      const user=await service.updateProfile(req.auth!,req.body);if(!res.headersSent)res.json({ user: sessionUser(user) });
    } catch (error) { failure(res, error); }
  });

  router.post("/me/password", requireAuth, async (req, res) => {
    try {
      await service.changePassword(req.auth!, req.body);
      if(!res.headersSent)res.status(204).send();
    } catch (error) { failure(res, error); }
  });

  return router;
}
