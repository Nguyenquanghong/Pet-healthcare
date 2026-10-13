// Local Compose supports new Notification storage only. Never silently hide
// historical inbox rows by switching an existing database to an empty service.
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
try {
  if (await db.notification.count()) throw new Error('LOCAL_NOTIFICATION_MIGRATION_REQUIRED');
  if (process.env.PHASE2_RUNTIME_REQUIRED === '1') {
    const counts = await Promise.all([db.appointment.count(), db.medicalRecord.count(),
      db.medicalImage.count(), db.bookingStatusEvent.count({ where: { kind: 'appointment' } })]);
    if (counts.some(Boolean)) throw new Error('LOCAL_CLINIC_MIGRATION_REQUIRED');
  }
} catch (error) {
  console.error(['LOCAL_NOTIFICATION_MIGRATION_REQUIRED','LOCAL_CLINIC_MIGRATION_REQUIRED'].includes(error?.message)
    ? error.message + ': reconcile legacy data with the P7 cutover runbook; this local empty-storage mode cannot open it. No data was changed by this preflight.'
    : 'LOCAL_NOTIFICATION_PREFLIGHT_FAILED: verify Core database and migrations.');
  process.exitCode = 1;
} finally { await db.$disconnect(); }
if (!process.exitCode) await import('../../backend/dist/src/index.js');
