import { Router } from 'express';
import type { ListsService } from '../application/services/lists.js';
import { listResultDto } from './dto/listSerialize.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';

// Mounted before the write routers; only these GET handlers run authentication here. The clinical GETs (appointments,
// the calendar, medical records and images, notifications) are in legacy/routes/clinicalLists.ts.
export function createListsRouter(service: ListsService) {
  const router = Router();
  router.get('/owners', requireAuth, requirePermission('directory.read'), async (req, res) =>
    res.json(listResultDto('owners', await service.load('owners', req.auth!, req.query), req.auth!)),
  );
  router.get('/doctors', requireAuth, requirePermission('directory.read'), async (req, res) =>
    res.json({ items: await service.doctors(req.auth!) }),
  );
  router.get('/pets', requireAuth, async (req, res) =>
    res.json(listResultDto('pets', await service.load('pets', req.auth!, req.query), req.auth!)),
  );
  router.get('/hotel-bookings', requireAuth, async (req, res) =>
    res.json(listResultDto('hotelBookings', await service.load('hotelBookings', req.auth!, req.query), req.auth!)),
  );
  router.get('/hotel-care-notes', requireAuth, async (req, res) =>
    res.json(listResultDto('dailyCareNotes', await service.load('dailyCareNotes', req.auth!, req.query), req.auth!)),
  );
  router.get('/invoices/summary', requireAuth, async (req, res) =>
    res.json(await service.billingFigures(req.auth!, req.query.month)),
  );
  router.get('/invoices', requireAuth, async (req, res) =>
    res.json(listResultDto('invoices', await service.load('invoices', req.auth!, req.query), req.auth!)),
  );
  return router;
}
