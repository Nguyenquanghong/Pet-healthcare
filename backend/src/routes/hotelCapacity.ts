import { Router, type Response } from "express";
import type { HotelCapacityService } from "../application/services/hotelCapacity.js";
import { BusinessError } from "../domain/error.js";

const dto = (row: { roomType: string; capacity: number; updatedAt: Date }) => ({ roomType: row.roomType, capacity: row.capacity, updatedAt: row.updatedAt.toISOString() });

export function createHotelCapacityRouter(service: HotelCapacityService) {
  const router = Router();
  function failure(res: Response, error: unknown) {
    if (error instanceof BusinessError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }

  router.get("/", async (req, res) => {
    try { res.json({ items: (await service.list(req.auth!)).map(dto) }); }
    catch (error) { failure(res, error); }
  });

  router.put("/:roomType", async (req, res) => {
    try { res.json({ capacity: dto(await service.set(req.auth!, req.params.roomType, req.body ?? {})) }); }
    catch (error) { failure(res, error); }
  });

  return router;
}
