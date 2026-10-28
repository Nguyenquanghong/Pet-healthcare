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
import { appointmentDto, medicalRecordDto, medicalImageDto } from '../../lib/serialize.js';
import { UnconfiguredBlobStore, type BlobStore } from '../../blobStore.js';
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
  const q = query(resource, raw),
    ownerId = actor.role === 'owner' ? actor.sub : (q.ownerId as string | undefined);
  const text = (field: string) => ({ [field]: { contains: q.q as string, mode: 'insensitive' as const } });
  const identity = q.id ? { id: q.id as string } : {},
    scope = { ...(ownerId ? { ownerId } : {}), ...(q.petId ? { petId: q.petId as string } : {}) },
    bounds = { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
  const projectionQuery = {
    where: { kind_id: { kind: 'pet' as const, id: q.petId as string } },
    select: { sourceVersion: true, deletedAt: true },
  };
  const versionOf = (projection: { sourceVersion: number; deletedAt: Date | null } | null | undefined) =>
    projection && !projection.deletedAt ? projection.sourceVersion : 0;
  // The appointment predicates for both paths below; `joined` are the directory search matches (only with q).
  const appointmentPlan = (joined: Prisma.AppointmentWhereInput[]) => {
    const base: Prisma.AppointmentWhereInput = {
      ...scope,
      ...identity,
      ...(q.date ? { appointmentDate: new Date(`${q.date}T00:00:00Z`) } : {}),
      ...(q.category ? { type: q.category === 'spa' ? { in: [...spa] } : { notIn: [...spa] } } : {}),
      ...(q.mode === 'unbilled'
        ? { status: 'completed', reservations: { none: { state: { in: ['HELD', 'INVOICED'] } } } }
        : {}),
      ...(q.q ? { OR: [...joined, text('serviceName'), text('id')] } : {}),
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
  };
  // These groups already cover the exact base predicate in this snapshot.
  // Apply the remaining status filters to obtain total without another COUNT.
  const tally = (grouped: { status: AppointmentStatus; _count: number }[]) => {
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
  };
  type Page = {
    total: number;
    counts: Record<string, number>;
    appointments: Appointment[];
    records: MedicalRecord[];
    images: Prisma.MedicalImageGetPayload<{ select: typeof imageColumns }>[];
    projectionVersion: number;
  };
  // Search projections are predicates, never an authorization source. Scope is
  // applied to local rows before counts/pagination; page relations use Core.
  const result: Page =
    resource === 'appointments' && !q.q
      ? await (async () => {
          // D: without a search no read needs another read's result, so the page is one batch in one
          // snapshot: groupBy, billing-held count, rows and, with a pet, that pet's projection version.
          const plan = appointmentPlan([]);
          const [grouped, billingHeld, appointments, projection] = (await db.$transaction(
            [
              db.appointment.groupBy({ by: ['status'], where: plan.base, _count: true }),
              db.appointment.count({ where: plan.held }),
              db.appointment.findMany(plan.page),
              ...(q.petId ? [db.directoryProjection.findUnique(projectionQuery)] : []),
            ] as Prisma.PrismaPromise<unknown>[],
            { isolationLevel: 'RepeatableRead' },
          )) as unknown as [
            { status: AppointmentStatus; _count: number }[],
            number,
            Appointment[],
            Parameters<typeof versionOf>[0],
          ];
          const { counts, total } = tally(grouped);
          return {
            total,
            counts: { ...counts, billingHeld },
            appointments,
            records: [],
            images: [],
            projectionVersion: versionOf(projection),
          };
        })()
      : await db.$transaction(
          async tx => {
            let petMatches: string[] = [],
              ownerMatches: string[] = [];
            if (q.q) {
              const matches = await tx.directoryProjection.findMany({
                where: {
                  deletedAt: null,
                  OR: [
                    text('displayName'),
                    text('phone'),
                    text('breed'),
                    text('email'),
                    text('microchipId'),
                    text('id'),
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
            let total = 0,
              counts: Record<string, number> = {},
              appointments: Appointment[] = [],
              records: MedicalRecord[] = [],
              images: Page['images'] = [];
            const joined = [{ petId: { in: petMatches } }, { ownerId: { in: ownerMatches } }];
            if (resource === 'appointments') {
              const plan = appointmentPlan(joined);
              const grouped = await tx.appointment.groupBy({ by: ['status'], where: plan.base, _count: true });
              ({ counts, total } = tally(grouped));
              counts.billingHeld = await tx.appointment.count({ where: plan.held });
              appointments = await tx.appointment.findMany(plan.page);
            } else if (resource === 'medicalRecords') {
              const where: Prisma.MedicalRecordWhereInput = {
                ...scope,
                ...identity,
                ...(q.q ? { OR: [...joined, text('title'), text('doctorName'), text('diagnosis')] } : {}),
              };
              total = await tx.medicalRecord.count({ where });
              records = await tx.medicalRecord.findMany({
                where,
                ...bounds,
                orderBy: [{ visitDate: 'desc' }, { id: 'desc' }],
              });
              appointments = await tx.appointment.findMany({
                where: {
                  id: { in: records.flatMap(r => (r.appointmentId ? [r.appointmentId] : [])) },
                  ...(ownerId ? { ownerId } : {}),
                },
              });
            } else {
              const where: Prisma.MedicalImageWhereInput = {
                ...identity,
                deletedAt: null,
                ...(actor.role === 'owner' ? { ownerId: actor.sub } : {}),
                ...(q.petId ? { petId: q.petId as string } : {}),
                ...(q.q ? { OR: [text('title'), { petId: { in: petMatches } }] } : {}),
              };
              total = await tx.medicalImage.count({ where });
              images = await tx.medicalImage.findMany({
                where,
                ...bounds,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                select: imageColumns,
              });
            }
            return {
              total,
              counts,
              appointments,
              records,
              images,
              projectionVersion: versionOf(q.petId ? await tx.directoryProjection.findUnique(projectionQuery) : null),
            };
          },
          { isolationLevel: 'RepeatableRead' },
        );
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
