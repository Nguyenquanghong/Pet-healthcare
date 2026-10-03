import { Router, type Response } from "express";
import { PetsService } from "../application/services/pets.js";
import { BusinessError } from "../domain/error.js";
import { petDto } from "../lib/serialize.js";

export function createPetsRouter(service: PetsService) {
  const router = Router();
  function failure(res: Response, error: unknown) {
    if (error instanceof BusinessError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }


  router.post("/", async (req, res) => {
    try {
      const pet = await service.create(req.auth!, req.body);
      res.status(201).json({ pet: petDto(pet) });
    } catch (error) { failure(res, error); }
  });

  router.post("/:id/qr-token", async (req, res) => {
    try {
      const pet = await service.rotateQrToken(req.auth!, req.params.id);
      res.json({ pet: petDto(pet) });
    } catch (error) { failure(res, error); }
  });

  router.patch("/:id", async (req, res) => {
    try {
      const pet = await service.update(req.auth!, req.params.id, req.body);
      res.json({ pet: petDto(pet) });
    } catch (error) { failure(res, error); }
  });

  return router;
}
