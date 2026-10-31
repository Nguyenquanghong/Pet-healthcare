import type { Prisma, PrismaClient } from '../generated/client/index.js';
import type { Actor } from '../domain/auth.js';
import type { AppointmentQueries } from '../application/ports/appointmentQueries.js';
import type { ReservationBilling } from '../application/ports/billing.js';
import type { ReadinessProbe } from '../application/ports/readiness.js';
import { AppointmentService } from '../application/services/appointments.js';
import { BookingLifecycleService } from '../application/services/bookingLifecycle.js';
import { MedicalRecordsService } from '../application/services/medicalRecords.js';
import type { BlobStore } from './blob/blobStore.js';
import type { RequestDirectory } from './core/directory.js';
import { appointmentDependencies } from './persistence/appointmentRepository.js';
import { Lifecycle } from './persistence/bookingLifecycleRepository.js';
import { bootstrap } from './persistence/bootstrap.js';
import { deduplicated } from './persistence/dedup.js';
import { medicalDependencies, medicalMutation } from './persistence/medicalRepository.js';
import { PrismaReadiness } from './persistence/readiness.js';
import { AppointmentBilling } from './persistence/runtimeBilling.js';
import { AuthoritativeAppointmentQueries } from './queries/authoritativeAppointments.js';
import { list } from './queries/authoritativeLists.js';
import { ClinicActivityQueries } from './queries/clinicActivity.js';

// The database handle createApp is given, and the transaction a use case may be bound to.
export type ClinicDatabase = PrismaClient;
export type Tx = Prisma.TransactionClient;

// Everything the HTTP layer asks of Clinic's use cases and stores, wired once per app, so http/ imports no generated client.
export function clinicUseCases(db: ClinicDatabase, blobs: BlobStore) {
  return {
    appointment: (directory: RequestDirectory, tx?: Tx) =>
      new AppointmentService(
        appointmentDependencies(db, directory, tx),
        new BookingLifecycleService(new Lifecycle(db, directory, tx)),
      ),
    medical: (directory: RequestDirectory, tx?: Tx) =>
      new MedicalRecordsService(medicalDependencies(db, directory, blobs, tx)),
    appointmentReads: new AuthoritativeAppointmentQueries(db) as AppointmentQueries,
    // Activity mode is server configuration (source or cached), never a client parameter.
    activity: new ClinicActivityQueries(db, (process.env.CLINIC_ACTIVITY_MODE ?? 'source') as 'source' | 'cached'),
    transaction: <T>(work: (tx: Tx) => Promise<T>) => db.$transaction(work),
    // Medical edit/delete also serialize with reservation and lifecycle mutations.
    medicalMutation: <T>(id: string, work: (tx: Tx) => Promise<T>) => medicalMutation(db, id, work),
    createOnce: (
      actorId: string,
      operationType: string,
      key: unknown,
      input: unknown,
      write: (tx: Tx) => Promise<{ resourceId: string; response: unknown }>,
    ) => deduplicated(db, actorId, operationType, key, input, write),
    list: (
      resource: 'medicalRecords' | 'medicalImages',
      actor: Actor,
      directory: RequestDirectory,
      raw: Record<string, unknown>,
    ) => list(db, resource, actor, directory, raw, blobs),
    bootstrap: (actor: Actor, directory: RequestDirectory) => bootstrap(db, actor, directory),
    billing: new AppointmentBilling(db) as ReservationBilling,
    readiness: new PrismaReadiness(db) as ReadinessProbe,
  };
}
export type UseCases = ReturnType<typeof clinicUseCases>;
