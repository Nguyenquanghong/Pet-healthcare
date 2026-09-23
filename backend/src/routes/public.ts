import { Router, type Response } from "express";
import { PublicRescueService } from "../application/services/publicRescue.js";
import { BusinessError } from "../domain/error.js";
import { petDto } from "../lib/serialize.js";

export function createPublicRouter(service: PublicRescueService) {
  const router = Router();
  function failure(res: Response, error: unknown) {
    if (error instanceof BusinessError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }

  router.get("/pets/:token", async (req, res) => {
    try {
      const result = await service.getPet(req.params.token);
      res.json({ pet: petDto(result.pet), owner: result.owner });
    } catch (error) { failure(res, error); }
  });

  router.post("/pets/:token/rescue-reports", async (req, res) => {
    try {
      await service.report(req.params.token, req.body);
      res.status(201).json({ message: "The owner has been notified." });
    } catch (error) { failure(res, error); }
  });

  return router;
}
