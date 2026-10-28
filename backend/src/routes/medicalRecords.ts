/** @deprecated Legacy monolith route (createApp only); split mode proxies this prefix to Clinic. */
import { Router } from "express";
import { MedicalRecordsService } from "../application/services/medicalRecords.js";
import { medicalRecordDto } from "../lib/serialize.js";
import { failure } from "./failure.js";

export function createMedicalRecordsRouter(service: MedicalRecordsService) {
  const router = Router();

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
