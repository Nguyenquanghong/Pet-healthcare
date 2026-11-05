import type { Express } from 'express';
import { BusinessError } from '../../domain/error.js';
import { requireAuth } from '../../middleware/auth.js';
import type { BootstrapService } from '../../application/services/bootstrap.js';
import { currentActor, type DashboardSources } from '../../routes/dashboard.js';
import { ownerDto, petDto, appointmentDto, medicalRecordDto } from '../../routes/dto/serialize.js';

// GET /api/dashboard/clinic, moved out of routes/dashboard.ts unchanged. `clinic` reads the clinical tables (legacy mode
// only); `account` is the same lookup the Core dashboard uses. Composition mounts it, right after the Core dashboard,
// only where Core does not hand the path to a Clinic service.
export type ClinicDashboardSources = { clinic: BootstrapService; account: DashboardSources['account'] };

export function mountClinicDashboard(app: Express, sources: ClinicDashboardSources) {
  // Opt-in split mode never reads clinical tables at Core. Legacy mode remains
  // usable until the explicitly authorized P7 cutover.
  app.get('/api/dashboard/clinic', requireAuth, async (req, res) => {
    try {
      await currentActor(sources, req.auth!);
      const d = await sources.clinic.load(req.auth!, 'dashboard');
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        asOf: new Date().toISOString(),
        owners: d.owners.map(ownerDto),
        pets: d.pets.map(petDto),
        appointments: d.appointments.map(r => appointmentDto(r, req.auth!)),
        medicalRecords: d.medicalRecords.map(r => medicalRecordDto(r, req.auth!.role === 'owner')),
        medicalImages: [],
        summary: {
          totals: {
            appointments: d.summary.totals.appointments,
            medicalRecords: d.summary.totals.medicalRecords,
            medicalImages: d.summary.totals.medicalImages,
          },
          appointmentStatus: d.summary.appointmentStatus,
          todayAppointments: d.summary.todayAppointments,
        },
      });
    } catch (e) {
      res
        .status(e instanceof BusinessError ? e.status : 503)
        .json({ error: e instanceof BusinessError ? e.message : 'Clinic dashboard unavailable.' });
    }
  });
}
