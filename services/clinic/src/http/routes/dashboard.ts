import { parseActivityFilter } from '../../application/queries/clinicActivity.js';
import { authorize } from '../../domain/authorization.js';
import { BusinessError } from '../../domain/error.js';
import type { UseCases } from '../../infrastructure/useCases.js';
import type { ClinicRoute } from '../scope.js';

export const dashboardRoutes = (useCases: UseCases): ClinicRoute[] => [
  {
    method: 'get',
    path: '/dashboard/clinic',
    resource: 'none',
    handler: async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ...(await useCases.bootstrap(res.locals.actor, res.locals.directory)),
        asOf: new Date().toISOString(),
      });
    },
  },
  {
    method: 'get',
    path: '/dashboard/clinic/activity',
    resource: 'none',
    permission: 'clinic-activity.read',
    ignoreQueryPetId: true,
    handler: async (req, res) => {
      // Express also matches trailing slashes/case variants; authorize the matched
      // operation itself, independently of the early exact-path rejection above.
      authorize(res.locals.actor, 'clinic-activity.read');
      const filter = parseActivityFilter(req.query);
      try {
        res.json(await useCases.activity.read(filter));
      } catch (error) {
        if (error instanceof BusinessError) throw error;
        throw new BusinessError(503, 'Clinic activity is unavailable. Retry later.');
      }
    },
  },
];
