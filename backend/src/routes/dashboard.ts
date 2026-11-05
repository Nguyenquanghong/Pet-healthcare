import type { Express } from 'express';
import type { Actor } from '../domain/auth.js';
import { BusinessError } from '../domain/error.js';
import { requireAuth } from '../middleware/auth.js';
import type { BootstrapService } from '../application/services/bootstrap.js';
import { ownerDto, petDto, hotelBookingDto } from './dto/serialize.js';

// `core` reads no clinical or notification table; `account` is the stored role of an account, or null when it is gone.
// The legacy clinic dashboard is mounted by legacy/routes/clinicDashboard.ts with its own source and the same `account`.
export type DashboardSources = {
  core: BootstrapService;
  account: (id: string) => Promise<{ role: string } | null>;
};

export async function currentActor(sources: Pick<DashboardSources, 'account'>, actor: Actor) {
  const user = await sources.account(actor.sub);
  if (!user || user.role !== actor.role) throw new BusinessError(403, 'Current account permission is required.');
}
export function mountDashboards(app: Express, sources: DashboardSources) {
  app.get('/api/dashboard/core', requireAuth, async (req, res) => {
    try {
      await currentActor(sources, req.auth!);
      const d = await sources.core.load(req.auth!, 'dashboard');
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        asOf: new Date().toISOString(),
        owners: d.owners.map(ownerDto),
        pets: d.pets.map(petDto),
        hotelBookings: d.hotelBookings.map(r => hotelBookingDto(r, req.auth!)),
        summary: {
          totals: {
            owners: d.summary.totals.owners,
            pets: d.summary.totals.pets,
            hotelBookings: d.summary.totals.hotelBookings,
            dailyCareNotes: d.summary.totals.dailyCareNotes,
          },
          species: d.summary.species,
          hotelStatus: d.summary.hotelStatus,
        },
      });
    } catch (e) {
      res
        .status(e instanceof BusinessError ? e.status : 503)
        .json({ error: e instanceof BusinessError ? e.message : 'Core dashboard unavailable.' });
    }
  });
}
