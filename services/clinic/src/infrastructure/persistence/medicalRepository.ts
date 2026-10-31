import type { Prisma, PrismaClient } from '../../generated/client/index.js';
import { bookingLifecycles } from '@nipopeto/contracts';
import type { Actor } from '../../domain/auth.js';
import { BusinessError, StaleRevision } from '../../domain/error.js';
import type {
  MedicalRecordRepository,
  MedicalDependencies,
  MedicalRevisionValue,
} from '../../application/ports/medicalRecords.js';
import { appointmentSlotWrite } from './appointmentSlotConflict.js';
import type { RequestDirectory } from '../core/directory.js';
import type { BlobStore } from '../blob/blobStore.js';
import { imageRetentionMs } from '../blob/blobCleanup.js';
import { appendStatusEvent, transaction, unlocked, writer, type Client } from './shared.js';

type ImageRow = {
  id: string;
  petId: string;
  ownerId: string;
  storageKey: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  deletedAt: Date | null;
};
const lockedImage = async (tx: Client, id: string) =>
  (
    await tx.$queryRaw<
      ImageRow[]
    >`SELECT id,pet_id AS "petId",owner_id AS "ownerId",storage_key AS "storageKey",sha256,size_bytes AS "sizeBytes",deleted_at AS "deletedAt" FROM medical_images WHERE id=${id} FOR UPDATE`
  )[0];
const imageLog = (image: ImageRow, action: 'delete' | 'restore', actor: Actor) => ({
  imageId: image.id,
  action,
  petId: image.petId,
  ownerId: image.ownerId,
  storageKey: image.storageKey,
  sha256: image.sha256,
  sizeBytes: image.sizeBytes,
  actorId: actor.sub,
  actorRole: actor.role,
});
class Records implements MedicalRecordRepository {
  constructor(
    private readonly db: Client,
    private readonly directory: RequestDirectory,
  ) {}
  list(ownerId?: string, petId?: string) {
    return this.db.medicalRecord.findMany({ where: { ownerId, petId }, orderBy: { visitDate: 'desc' } });
  }
  findPet(id: string) {
    return this.directory.pet(id);
  }
  async findAppointment(id: string) {
    await this.db.$queryRaw`SELECT id FROM appointments WHERE id=${id} FOR UPDATE`;
    await unlocked(this.db, id);
    return this.db.appointment.findUnique({ where: { id }, select: { id: true, petId: true, ownerId: true } });
  }
  async appointmentDoctor(id: string) {
    return (await this.db.appointment.findUnique({ where: { id }, select: { doctorId: true } }))?.doctorId ?? null;
  }
  findDoctor(id: string) {
    return this.directory.doctor(id);
  }
  signer() {
    return this.directory.signer();
  }
  find(id: string) {
    return this.db.medicalRecord.findUnique({ where: { id } });
  }
  // AQ-15: callers run these inside the record's transaction (unit of work or
  // medicalMutation), so the revision commits or rolls back with the change.
  private revise(
    recordId: string,
    action: 'create' | 'update' | 'delete',
    before: { revision: number } | null,
    after: { revision: number } | null,
    actor: Actor,
  ) {
    // An omitted nullable Json column is SQL NULL; the DbNull sentinel is not
    // portable across separately generated clients.
    const snapshot = (v: unknown) => (v == null ? undefined : JSON.parse(JSON.stringify(v)));
    return this.db.medicalRecordRevision.create({
      data: {
        recordId,
        action,
        before: snapshot(before),
        after: snapshot(after),
        actorId: actor.sub,
        actorRole: actor.role,
        recordRevision: (after ?? before)!.revision,
      },
    });
  }
  // Optimistic lock: the row lock serializes two saves of one record; the second
  // then sees the first one's revision and is refused instead of overwriting it.
  private async current(id: string, expectedRevision: number) {
    await this.db.$queryRaw`SELECT id FROM medical_records WHERE id=${id} FOR UPDATE`;
    const row = await this.db.medicalRecord.findUnique({ where: { id } });
    if (!row) throw new BusinessError(404, 'Medical record not found.');
    if (row.revision !== expectedRevision)
      throw new StaleRevision(
        'Bệnh án vừa được người khác cập nhật. Hãy xem bản mới trước khi lưu.',
        'MEDICAL_RECORD_STALE',
        row,
      );
    return row;
  }
  async create(data: Parameters<MedicalRecordRepository['create']>[0], actor: Actor) {
    const created = await this.db.medicalRecord.create({ data });
    await this.revise(created.id, 'create', null, created, actor);
    return created;
  }
  async update(
    id: string,
    data: Parameters<MedicalRecordRepository['update']>[1],
    actor: Actor,
    expectedRevision: number,
  ) {
    const before = await this.current(id, expectedRevision),
      after = await this.db.medicalRecord.update({ where: { id }, data: { ...data, revision: { increment: 1 } } });
    await this.revise(id, 'update', before, after, actor);
    return after;
  }
  async delete(id: string, actor: Actor, expectedRevision: number) {
    const before = await this.current(id, expectedRevision);
    await this.db.medicalRecord.delete({ where: { id } });
    await this.revise(id, 'delete', before, null, actor);
  }
  history(recordId: string) {
    return this.db.medicalRecordRevision.findMany({
      where: { recordId },
      orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
    }) as Promise<MedicalRevisionValue[]>;
  }
  async createImage(data: Parameters<MedicalRecordRepository['createImage']>[0]) {
    const pet = await this.directory.pet(data.petId);
    const { ownerId, sha256, imageUrl, ...image } = await this.db.medicalImage.create({
      data: { ...data, ownerId: pet.ownerId },
    });
    return image;
  }
  // AQ-09 retention: delete leaves a tombstone; the log row and the object's cleanup
  // claim (due when the retention window ends) commit with it, so a crash never
  // leaks the object and the worker purges row and object together later.
  async deleteImage(id: string, actor: Actor) {
    const run = async (tx: Client) => {
      const image = await lockedImage(tx, id);
      if (!image || image.deletedAt) throw new BusinessError(404, 'Medical image not found.');
      const deletedAt = new Date();
      await tx.medicalImage.update({ where: { id }, data: { deletedAt, deletedBy: actor.sub } });
      if (image.storageKey) {
        const claim = { nextAttemptAt: new Date(deletedAt.getTime() + imageRetentionMs()), attempts: 0 };
        await tx.blobCleanup.upsert({
          where: { storageKey: image.storageKey },
          create: { storageKey: image.storageKey, ...claim },
          update: claim,
        });
      }
      await tx.medicalImageDeletion.create({ data: imageLog(image, 'delete', actor) });
    };
    await ('$transaction' in this.db ? this.db.$transaction(run) : run(this.db));
  }
  // Within the window an admin restore cancels the cleanup claim under the same row
  // lock the purge takes, so either the restore or the purge wins, never both.
  async restoreImage(id: string, actor: Actor) {
    const run = async (tx: Client) => {
      const image = await lockedImage(tx, id);
      if (!image?.deletedAt) throw new BusinessError(404, 'Deleted medical image not found.');
      if (image.deletedAt.getTime() <= Date.now() - imageRetentionMs())
        throw new BusinessError(409, 'The retention window has ended; this image is being removed.');
      await tx.medicalImage.update({ where: { id }, data: { deletedAt: null, deletedBy: null } });
      if (image.storageKey) await tx.blobCleanup.deleteMany({ where: { storageKey: image.storageKey } });
      await tx.medicalImageDeletion.create({ data: imageLog(image, 'restore', actor) });
    };
    await ('$transaction' in this.db ? this.db.$transaction(run) : run(this.db));
  }
  async completeAppointment(id: string, actor: Actor) {
    await unlocked(this.db, id);
    // P01: saving a medical record is a system move of the lifecycle table.
    const medical = bookingLifecycles.appointment.system['medical-completed'];
    const before = await this.db.appointment.findUnique({ where: { id } });
    if (!before || (before.status !== medical.to && !(medical.from as readonly string[]).includes(before.status)))
      throw new BusinessError(409, 'Appointment must be checked in before medical completion.');
    if (before.status === medical.to) return;
    const saved = await appointmentSlotWrite(
      this.db.appointment.update({ where: { id }, data: { status: medical.to, statusRevision: { increment: 1 } } }),
    );
    await appendStatusEvent(
      this.db,
      this.directory,
      id,
      actor,
      'medical_completed',
      before.status,
      'completed',
      saved.statusRevision,
    );
  }
}
export function medicalDependencies(
  db: PrismaClient,
  directory: RequestDirectory,
  blobs: BlobStore,
  bound?: Prisma.TransactionClient,
): MedicalDependencies {
  return {
    records: new Records(bound ?? db, directory),
    blobs,
    unitOfWork: {
      run: work =>
        transaction(db, bound, tx => work({ records: new Records(tx, directory), notifications: writer(tx) })),
    },
  };
}
// Medical edit/delete also serialize with reservation and lifecycle mutations.
export async function medicalMutation<T>(
  db: PrismaClient,
  id: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return db.$transaction(async tx => {
    const row = await tx.medicalRecord.findUnique({ where: { id } });
    if (!row) throw new BusinessError(404, 'Medical record not found.');
    if (row.appointmentId) {
      await tx.$queryRaw`SELECT id FROM appointments WHERE id=${row.appointmentId} FOR UPDATE`;
      await unlocked(tx, row.appointmentId);
    }
    return work(tx);
  });
}
