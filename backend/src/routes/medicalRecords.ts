import { Router, type Response } from "express";
import { MedicalRecordsService } from "../application/services/medicalRecords.js";
import { BusinessError } from "../domain/error.js";
import { medicalRecordDto } from "../lib/serialize.js";

export function createMedicalRecordsRouter(service: MedicalRecordsService) {
  const router = Router();
  function failure(res: Response, error: unknown) {
    if (error instanceof BusinessError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }

  router.get("/", async (req, res) => {
    const ownerId = typeof req.query.ownerId === "string" ? req.query.ownerId : undefined;
    const petId = typeof req.query.petId === "string" ? req.query.petId : undefined;
    res.json((await service.list(req.auth!, ownerId, petId)).map(medicalRecordDto));
  });

  router.post("/", async (req, res) => {
    try {
      const record = await service.create(req.auth!, req.body);
      res.status(201).json({ record: medicalRecordDto(record) });
    } catch (error) { failure(res, error); }
  });

  router.patch("/:id", async (req, res) => {
    try {
      const record = await service.update(req.auth!, req.params.id, req.body);
      res.json({ record: medicalRecordDto(record) });
    } catch (error) { failure(res, error); }
  });

  router.delete("/:id", async (req, res) => {
    try {
      await service.delete(req.auth!, req.params.id);
      res.status(204).end();
    } catch (error) { failure(res, error); }
  });

  router.post("/images", async (req, res) => {
    try {
      const image = await service.createImage(req.auth!, req.body);
      res.status(201).json({ image });
    } catch (error) { failure(res, error); }
  });

  router.delete("/images/:id", async (req, res) => {
    try {
      await service.deleteImage(req.auth!, req.params.id);
      res.status(204).end();
    } catch (error) { failure(res, error); }
  });

  return router;
}
