import { Router } from "express";
import { PublicRescueService } from "../application/services/publicRescue.js";
import { publicPetDto } from "../lib/serialize.js";
import { failure } from "./failure.js";

export function createPublicRouter(service: PublicRescueService) {
  const router = Router();

  router.get("/pets/:token", async (req, res) => {
    try {
      const result = await service.getPet(req.params.token);
      res.json({ pet: publicPetDto(result.pet), owner: result.owner });
    } catch (error) { failure(res, error); }
  });

  router.post("/pets/:token/rescue-reports", async (req, res) => {
    try {
      const { merged } = await service.report(req.params.token, req.body);
      res.status(201).json({ message: merged ? "Report already received; the owner was notified." : "Report received; notification request accepted." });
    } catch (error) { failure(res, error); }
  });

  return router;
}
