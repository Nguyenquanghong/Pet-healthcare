import type { Prisma, PrismaClient } from '@prisma/client';
import type { UserAccount } from '../../application/ports/auth.js';
import type {
  DirectoryDoctor,
  DirectoryExportFilter,
  DirectoryKind,
  DirectoryReader,
  DirectoryRequest,
  DirectoryRow,
  DirectorySender,
  DirectorySnapshot,
} from '../../application/ports/directory.js';
import type { PetValue } from '../../application/ports/pets.js';

const personSelect = {
  id: true,
  username: true,
  phone: true,
  email: true,
  fullName: true,
  role: true,
  address: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true,
  passwordHash: true,
  passwordSalt: true,
  directoryRevision: true,
} as const;

export class PrismaDirectoryReader implements DirectoryReader {
  constructor(private readonly db: PrismaClient) {}
  async snapshot(actorId: string, request: DirectoryRequest): Promise<DirectorySnapshot> {
    const { petIds, ownerIds, doctorId } = request;
    // D: the reads that need no other read's result go out as one batch in one RepeatableRead snapshot
    // (empty `in` lists are not queried); a request that names no ids is a single plain read.
    const owned = [
      ...(ownerIds.length ? [{ id: { in: ownerIds } }] : []),
      ...(petIds.length ? [{ pets: { some: { id: { in: petIds } } } }] : []),
    ];
    const queries: Record<string, Prisma.PrismaPromise<unknown>> = {
      sender: this.db.user.findUnique({
        where: { id: actorId },
        select: { id: true, role: true, fullName: true, passwordChangedAt: true },
      }),
      ...(petIds.length ? { pets: this.db.pet.findMany({ where: { id: { in: petIds } } }) } : {}),
      // A named doctor comes back with the name Clinic signs medical records with.
      ...(doctorId
        ? {
            doctor: this.db.user.findFirst({
              where: { id: doctorId, role: 'doctor' },
              select: { id: true, fullName: true },
            }),
          }
        : {}),
      // Owners named directly plus the owners of the named pets, decided in the same snapshot.
      ...(owned.length
        ? { owners: this.db.user.findMany({ where: { role: 'owner', OR: owned }, select: personSelect }) }
        : {}),
    };
    const names = Object.keys(queries),
      values =
        names.length === 1
          ? [await queries.sender]
          : await this.db.$transaction(Object.values(queries), { isolationLevel: 'RepeatableRead' });
    const found = Object.fromEntries(names.map((name, index) => [name, values[index]]));
    return {
      sender: found.sender as DirectorySender | null,
      pets: (found.pets ?? []) as PetValue[],
      doctor: (found.doctor ?? null) as DirectoryDoctor | null,
      owners: (found.owners ?? []) as UserAccount[],
    };
  }
  async exportPage(kind: DirectoryKind, { id, after }: DirectoryExportFilter, limit: number): Promise<DirectoryRow[]> {
    const bounds = { take: limit, orderBy: { id: 'asc' as const } };
    const filter = id ? { id } : after ? { id: { gt: after } } : {};
    return kind === 'pet'
      ? await this.db.pet.findMany({ where: filter, ...bounds })
      : await this.db.user.findMany({
          where: { role: kind === 'owner' ? 'owner' : { not: 'owner' }, ...filter },
          select: personSelect,
          ...bounds,
        });
  }
  async tombstone(kind: DirectoryKind, id: string) {
    // An older queued upsert can arrive after delete/role change. Return
    // the durable Core tombstone instead of poisoning that valid event.
    const eventType = `directory.${kind}-upserted.v1`;
    const tombstones = await this.db.$queryRaw<
      { payload: Record<string, unknown> }[]
    >`SELECT envelope->'payload' AS payload FROM "OutboxEvent" WHERE envelope->>'aggregateId'=${id} AND envelope->>'eventType'=${eventType} AND envelope->'payload'->>'deletedAt' IS NOT NULL ORDER BY (envelope->>'aggregateVersion')::integer DESC LIMIT 1`;
    return tombstones[0] ? tombstones[0].payload : null;
  }
}
