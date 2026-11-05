import {
  Prisma,
  type PrismaClient,
  type AppointmentStatus,
  type Appointment,
  type MedicalRecord,
} from '../../generated/client/index.js';
import type { Actor } from '../../domain/auth.js';
import { BusinessError } from '../../domain/error.js';
import { calendarDate } from '../../domain/validation.js';
import { appointmentDto, medicalRecordDto, medicalImageDto } from '../../application/serialize.js';
import { UnconfiguredBlobStore, type BlobStore } from '../blob/blobStore.js';
import type { AppointmentListResult, AppointmentQueryDirectory } from '../../application/ports/appointmentQueries.js';

export type Resource = 'appointments' | 'medicalRecords' | 'medicalImages';
const spa = ['spa_bath', 'spa_grooming', 'spa_combo'] as const;
const groups: Record<string, AppointmentStatus[]> = {
  pending: ['pending', 'confirmed', 'checked_in', 'in_progress'],
  completed: ['completed'],
  cancelled: ['cancelled', 'no_show'],
};
export function query(resource: Resource, raw: Record<string, unknown>) {
  const integer = (name: string, fallback: number, max: number) => {
    if (raw[name] === undefined) return fallback;
    const v = raw[name];
    if (typeof v !== 'string' || !/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) > max)
      throw new BusinessError(422, `Invalid ${name}.`);
    return Number(v);
  };
  const result: { page: number; pageSize: number; [key: string]: string | number } = {
    page: integer('page', 1, 1000000),
    pageSize: integer('pageSize', 20, 100),
  };
  const allowed =
    resource === 'appointments'
      ? ['ownerId', 'petId', 'status', 'statusGroup', 'category', 'date', 'mode']
      : resource === 'medicalRecords'
        ? ['ownerId', 'petId']
        : ['petId'];
  for (const k of ['q', 'id', ...allowed]) {
    const v = raw[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length > (k === 'q' ? 100 : 128)) throw new BusinessError(422, `Invalid ${k}.`);
    const value = v.trim();
    if (!value || (value === 'all' && k !== 'q' && k !== 'id')) continue;
    const options =
      k === 'status'
        ? Object.values(groups).flat()
        : k === 'statusGroup'
          ? Object.keys(groups)
          : k === 'category'
            ? ['medical', 'spa']
            : k === 'mode'
              ? ['unbilled']
              : undefined;
    if (options && !options.includes(value)) throw new BusinessError(422, `Invalid ${k}.`);
    if (k === 'date') calendarDate(value, 'date');
    result[k] = value;
  }
  return result;
}
type ListDatabase = Pick<PrismaClient, '$transaction' | 'appointment' | 'directoryProjection'>;
// Never select image_url: a legacy row carries up to 7 MB of base64 the list does not return.
const imageColumns = {
  id: true,
  ownerId: true,
  petId: true,
  title: true,
  mimeType: true,
  createdAt: true,
  storageKey: true,
  sizeBytes: true,
} as const;
type ClinicListResult = Omit<AppointmentListResult, 'items'> & { items: unknown[] };
type Query = ReturnType<typeof query>;
type Projection = { sourceVersion: number; deletedAt: Date | null } | null | undefined;
type Page = {
  total: number;
  counts: Record<string, number>;
  appointments: Appointment[];
  records: MedicalRecord[];
  images: Prisma.MedicalImageGetPayload<{ select: typeof imageColumns }>[];
  projectionVersion: number;
};
type ListPlan = {
  q: Query;
  ownerId: string | undefined;
  identity: { id?: string };
  scope: { ownerId?: string; petId?: string };
  bounds: { skip: number; take: number };
  projectionQuery: {
    where: { kind_id: { kind: 'pet'; id: string } };
    select: { sourceVersion: true; deletedAt: true };
  };
};
type Joined = ({ petId: { in: string[] } } | { ownerId: { in: string[] } })[];
const text = (q: Query, field: string) => ({ [field]: { contains: q.q as string, mode: 'insensitive' as const } });
const versionOf = (projection: Projection) => (projection && !projection.deletedAt ? projection.sourceVersion : 0);
function listPlan(resource: Resource, actor: Actor, raw: Record<string, unknown>): ListPlan {
  const q = query(resource, raw),
    ownerId = actor.role === 'owner' ? actor.sub : (q.ownerId as string | undefined);
  const identity = q.id ? { id: q.id as string } : {},
    scope = { ...(ownerId ? { ownerId } : {}), ...(q.petId ? { petId: q.petId as string } : {}) },
    bounds = { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
  const projectionQuery = {
    where: { kind_id: { kind: 'pet' as const, id: q.petId as string } },
    select: { sourceVersion: true as const, deletedAt: true as const },
  };
  return { q, ownerId, identity, scope, bounds, projectionQuery };
}
// The appointment predicates for both paths below; `joined` are the directory search matches (only with q).
function appointmentPlan({ q, scope, identity, bounds }: ListPlan, actor: Actor, joined: Joined) {
  const base: Prisma.AppointmentWhereInput = {
    ...scope,
    ...identity,
    ...(q.date ? { appointmentDate: new Date(`${q.date}T00:00:00Z`) } : {}),
    ...(q.category ? { type: q.category === 'spa' ? { in: [...spa] } : { notIn: [...spa] } } : {}),
    ...(q.mode === 'unbilled'
      ? { status: 'completed', reservations: { none: { state: { in: ['HELD', 'INVOICED'] } } } }
      : {}),
    ...(q.q ? { OR: [...joined, text(q, 'serviceName'), text(q, 'id')] } : {}),
  };
  const where: Prisma.AppointmentWhereInput = {
    AND: [
      base,
      ...(q.statusGroup ? [{ status: { in: groups[q.statusGroup as string] } }] : []),
      ...(q.status ? [{ status: q.status as AppointmentStatus }] : []),
    ],
  };
  const orderBy: Prisma.AppointmentOrderByWithRelationInput[] =
    actor.role === 'owner'
      ? [{ status: 'asc' }, { appointmentDate: 'desc' }, { appointmentTime: 'desc' }, { id: 'desc' }]
      : [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }];
  return {
    base,
    held: { ...base, reservations: { some: { state: 'HELD' as const } } },
    page: { where, ...bounds, orderBy },
  };
}
// These groups already cover the exact base predicate in this snapshot.
// Apply the remaining status filters to obtain total without another COUNT.
function tally(q: Query, grouped: { status: AppointmentStatus; _count: number }[]) {
  const counts: Record<string, number> = Object.fromEntries(grouped.map(g => [g.status, g._count]));
  return {
    counts,
    total: Object.entries(counts).reduce(
      (sum, [status, count]) =>
        sum +
        ((!q.status || q.status === status) &&
        (!q.statusGroup || groups[q.statusGroup as string]!.includes(status as AppointmentStatus))
          ? count
          : 0),
      0,
    ),
  };
}
async function readAppointmentBatch(db: ListDatabase, plan: ListPlan, actor: Actor): Promise<Page> {
  // D: without a search no read needs another read's result, so the page is one batch in one
  // snapshot: groupBy, billing-held count, rows and, with a pet, that pet's projection version.
  const appointments = appointmentPlan(plan, actor, []);
  const [grouped, billingHeld, rows, projection] = (await db.$transaction(
    [
      db.appointment.groupBy({ by: ['status'], where: appointments.base, _count: true }),
      db.appointment.count({ where: appointments.held }),
      db.appointment.findMany(appointments.page),
      ...(plan.q.petId ? [db.directoryProjection.findUnique(plan.projectionQuery)] : []),
    ] as Prisma.PrismaPromise<unknown>[],
    { isolationLevel: 'RepeatableRead' },
  )) as unknown as [{ status: AppointmentStatus; _count: number }[], number, Appointment[], Projection];
  const { counts, total } = tally(plan.q, grouped);
  return {
    total,
    counts: { ...counts, billingHeld },
    appointments: rows,
    records: [],
    images: [],
    projectionVersion: versionOf(projection),
  };
}
async function searchMatches(tx: Prisma.TransactionClient, { q }: ListPlan) {
  let petMatches: string[] = [],
    ownerMatches: string[] = [];
  if (q.q) {
    const matches = await tx.directoryProjection.findMany({
      where: {
        deletedAt: null,
        OR: [
          text(q, 'displayName'),
          text(q, 'phone'),
          text(q, 'breed'),
          text(q, 'email'),
          text(q, 'microchipId'),
          text(q, 'id'),
        ],
      },
      select: { kind: true, id: true },
    });
    ownerMatches = matches.filter(m => m.kind === 'owner').map(m => m.id);
    petMatches = matches.filter(m => m.kind === 'pet').map(m => m.id);
    const owned = await tx.directoryProjection.findMany({
      where: { kind: 'pet', deletedAt: null, ownerId: { in: ownerMatches } },
      select: { id: true },
    });
    petMatches.push(...owned.map(m => m.id));
  }
  return { petMatches, ownerMatches };
}
async function readAppointments(tx: Prisma.TransactionClient, plan: ListPlan, actor: Actor, joined: Joined) {
  const appointments = appointmentPlan(plan, actor, joined);
  const grouped = await tx.appointment.groupBy({ by: ['status'], where: appointments.base, _count: true });
  const { counts, total } = tally(plan.q, grouped);
  counts.billingHeld = await tx.appointment.count({ where: appointments.held });
  return { total, counts, appointments: await tx.appointment.findMany(appointments.page) };
}
async function readMedicalRecords(tx: Prisma.TransactionClient, plan: ListPlan, joined: Joined) {
  const { q, scope, identity, bounds, ownerId } = plan;
  const where: Prisma.MedicalRecordWhereInput = {
    ...scope,
    ...identity,
    ...(q.q ? { OR: [...joined, text(q, 'title'), text(q, 'doctorName'), text(q, 'diagnosis')] } : {}),
  };
  const total = await tx.medicalRecord.count({ where });
  const records = await tx.medicalRecord.findMany({
    where,
    ...bounds,
    orderBy: [{ visitDate: 'desc' }, { id: 'desc' }],
  });
  const appointments = await tx.appointment.findMany({
    where: {
      id: { in: records.flatMap(r => (r.appointmentId ? [r.appointmentId] : [])) },
      ...(ownerId ? { ownerId } : {}),
    },
  });
  return { total, records, appointments };
}
async function readMedicalImages(tx: Prisma.TransactionClient, plan: ListPlan, actor: Actor, petMatches: string[]) {
  const { q, identity, bounds } = plan;
  const where: Prisma.MedicalImageWhereInput = {
    ...identity,
    deletedAt: null,
    ...(actor.role === 'owner' ? { ownerId: actor.sub } : {}),
    ...(q.petId ? { petId: q.petId as string } : {}),
    ...(q.q ? { OR: [text(q, 'title'), { petId: { in: petMatches } }] } : {}),
  };
  const total = await tx.medicalImage.count({ where });
  const images = await tx.medicalImage.findMany({
    where,
    ...bounds,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: imageColumns,
  });
  return { total, images };
}
function readInTransaction(db: ListDatabase, resource: Resource, plan: ListPlan, actor: Actor): Promise<Page> {
  return db.$transaction(
    async (tx): Promise<Page> => {
      const { petMatches, ownerMatches } = await searchMatches(tx, plan);
      const joined = [{ petId: { in: petMatches } }, { ownerId: { in: ownerMatches } }];
      const read =
        resource === 'appointments'
          ? await readAppointments(tx, plan, actor, joined)
          : resource === 'medicalRecords'
            ? await readMedicalRecords(tx, plan, joined)
            : await readMedicalImages(tx, plan, actor, petMatches);
      const empty = { total: 0, counts: {}, appointments: [], records: [], images: [] };
      return {
        ...empty,
        ...read,
        projectionVersion: versionOf(
          plan.q.petId ? await tx.directoryProjection.findUnique(plan.projectionQuery) : null,
        ),
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
async function present(
  result: Page,
  { q }: ListPlan,
  resource: Resource,
  actor: Actor,
  directory: AppointmentQueryDirectory,
  blobs: BlobStore,
): Promise<ClinicListResult> {
  const rows = [...result.appointments, ...result.records, ...result.images];
  const source = rows.length
    ? await directory.lookup(
        rows.map(r => r.petId),
        rows.map(r => r.ownerId),
      )
    : { pets: [], owners: [] };
  const related = {
    owners: source.owners,
    pets: source.pets,
    appointments: result.appointments.map(r => appointmentDto(r, actor)),
    medicalRecords: result.records.map(r => medicalRecordDto(r, actor.role === 'owner')),
    medicalImages: result.images.map(image => medicalImageDto(image, blobs)),
    hotelBookings: [],
    dailyCareNotes: [],
    notifications: [],
    invoices: [],
  };
  const currentPet = q.petId
    ? (source.pets.find(p => p.id === q.petId) ?? (await directory.pet(q.petId as string)))
    : null;
  return {
    items: related[resource],
    pagination: {
      page: q.page,
      pageSize: q.pageSize,
      total: result.total,
      totalPages: Math.ceil(result.total / q.pageSize),
    },
    counts: result.counts,
    related: { ...related, [resource]: [] },
    ...(currentPet
      ? {
          directory: {
            petId: currentPet.id,
            sourceVersion: currentPet.directoryVersion,
            projectionVersion: result.projectionVersion,
            searchReady: result.projectionVersion >= currentPet.directoryVersion,
          },
        }
      : {}),
    ...(q.q ? { searchConsistency: 'eventual' as const } : {}),
  };
}
export function list(
  db: ListDatabase,
  resource: 'appointments',
  actor: Actor,
  directory: AppointmentQueryDirectory,
  raw: Record<string, unknown>,
): Promise<AppointmentListResult>;
export function list(
  db: ListDatabase,
  resource: Resource,
  actor: Actor,
  directory: AppointmentQueryDirectory,
  raw: Record<string, unknown>,
  blobs?: BlobStore,
): Promise<ClinicListResult>;
export async function list(
  db: ListDatabase,
  resource: Resource,
  actor: Actor,
  directory: AppointmentQueryDirectory,
  raw: Record<string, unknown>,
  blobs: BlobStore = new UnconfiguredBlobStore(),
): Promise<ClinicListResult> {
  const plan = listPlan(resource, actor, raw);
  // Search projections are predicates, never an authorization source. Scope is
  // applied to local rows before counts/pagination; page relations use Core.
  const result =
    resource === 'appointments' && !plan.q.q
      ? await readAppointmentBatch(db, plan, actor)
      : await readInTransaction(db, resource, plan, actor);
  return present(result, plan, resource, actor, directory, blobs);
}
