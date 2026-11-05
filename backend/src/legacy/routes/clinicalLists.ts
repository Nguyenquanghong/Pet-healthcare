import { Router } from 'express';
import type { ListsService } from '../../application/services/lists.js';
import { listResultDto } from '../../routes/dto/listSerialize.js';
import { requireAuth } from '../../middleware/auth.js';

// The clinical GET handlers of the list router, moved out of routes/lists.ts unchanged. Composition mounts this router
// right after the Core one, only where the process serves clinical routes itself.
export function createClinicalListsRouter(service: ListsService) {
  const router = Router();
  router.get('/appointments', requireAuth, async (req, res) =>
    res.json(listResultDto('appointments', await service.load('appointments', req.auth!, req.query), req.auth!)),
  );
  router.get('/appointments/calendar', requireAuth, async (req, res) =>
    res.json(await service.calendar(req.auth!, req.query.month, req.query.category)),
  );
  router.get('/medical-records', requireAuth, async (req, res) =>
    res.json(listResultDto('medicalRecords', await service.load('medicalRecords', req.auth!, req.query), req.auth!)),
  );
  router.get('/medical-records/images', requireAuth, async (req, res) =>
    res.json(listResultDto('medicalImages', await service.load('medicalImages', req.auth!, req.query), req.auth!)),
  );
  router.get('/notifications', requireAuth, async (req, res) =>
    res.json(listResultDto('notifications', await service.load('notifications', req.auth!, req.query), req.auth!)),
  );
  return router;
}
