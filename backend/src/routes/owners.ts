import { Router } from "express";
import { OwnersService } from "../application/services/owners.js";
import { BusinessError } from "../domain/error.js";
import { ownerDto } from "../lib/serialize.js";
import { OwnerActivationService } from "../application/services/ownerActivation.js";

export function createOwnersRouter(service: OwnersService, activation: OwnerActivationService) {
  const router = Router();
  router.post("/", async (req, res) => {
    try {
      const owner = await service.create(req.auth!, req.body ?? {});
      res.status(201).json({ owner: ownerDto(owner) });
    } catch (error) {
      if (error instanceof BusinessError) res.status(error.status).json({ error: error.message });
      else throw error;
    }
  });
  router.post("/:id/activation", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.status(201).json({ activation: await activation.issue(req.auth!, req.params.id, req.body ?? {}) }); }
    catch (error) {
      if (error instanceof BusinessError) res.status(error.status).json({ error: error.message });
      else throw error;
    }
  });
  return router;
}
