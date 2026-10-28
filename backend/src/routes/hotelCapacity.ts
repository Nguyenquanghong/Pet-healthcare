import { Router } from "express";
import type { HotelCapacityService } from "../application/services/hotelCapacity.js";
import { failure } from "./failure.js";

const dto = (row: { roomType: string; capacity: number; updatedAt: Date }) => ({ roomType: row.roomType, capacity: row.capacity, updatedAt: row.updatedAt.toISOString() });

export function createHotelCapacityRouter(service: HotelCapacityService) {
  const router = Router();

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
