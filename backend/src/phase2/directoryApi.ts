import type { Express, Request, Response } from 'express';
import express from 'express';
import type { Pet, Prisma, PrismaClient } from '@prisma/client';
import type { Role } from '../domain/auth.js';
import { issuedBeforePasswordChange, verifyToken } from '../lib/token.js';
import { ownerDto, petDto } from '../lib/serialize.js';
import { acceptsCredential } from '@nipopeto/runtime';

export function mountDirectory(app: Express, db: PrismaClient, credential?: string) {
  app.use('/internal/directory', (req, res, next) => {
    if (!credential || credential.length < 32 || credential.length > 512) {
      res.status(503).json({ error: 'Directory authorization unavailable.' });
      return;
    }
    if (!acceptsCredential(req.headers['x-service-token'], credential)) {
      res.status(401).json({ error: 'Service authentication required.' });
      return;
    }
    next();
  });
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
  const handle = async (req: Request, res: Response) => {
    let actor;
    try {
      const bearer = req.headers.authorization;
      if (!bearer?.startsWith('Bearer ') || bearer.length > 8192) throw new Error();
      actor = verifyToken(bearer.slice(7));
    } catch {
      res.status(401).json({ error: 'Invalid actor context.' });
      return;
    }
    const data = req.body;
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      Object.keys(data).some(k => !['petIds', 'ownerIds', 'doctorId'].includes(k))
    ) {
      res.status(422).json({ error: 'Invalid directory request.' });
      return;
    }
    const ids = (key: string): string[] | null =>
      data[key] === undefined
        ? []
        : Array.isArray(data[key]) &&
            data[key].length <= 100 &&
            data[key].every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 200)
          ? [...new Set<string>(data[key])]
          : null;
    const petIds = ids('petIds'),
      ownerIds = ids('ownerIds');
    if (
      !petIds ||
      !ownerIds ||
      (data.doctorId !== undefined &&
        (typeof data.doctorId !== 'string' || !data.doctorId || data.doctorId.length > 200))
    ) {
      res.status(422).json({ error: 'Invalid directory IDs.' });
      return;
    }
    try {
      // D: the reads that need no other read's result go out as one batch in one RepeatableRead snapshot
      // (empty `in` lists are not queried); a request that names no ids is a single plain read.
      const owned = [
        ...(ownerIds.length ? [{ id: { in: ownerIds } }] : []),
        ...(petIds.length ? [{ pets: { some: { id: { in: petIds } } } }] : []),
      ];
      const queries: Record<string, Prisma.PrismaPromise<unknown>> = {
        sender: db.user.findUnique({
          where: { id: actor.sub },
          select: { id: true, role: true, fullName: true, passwordChangedAt: true },
        }),
        ...(petIds.length ? { pets: db.pet.findMany({ where: { id: { in: petIds } } }) } : {}),
        // A named doctor comes back with the name Clinic signs medical records with.
        ...(data.doctorId
          ? {
              doctor: db.user.findFirst({
                where: { id: data.doctorId, role: 'doctor' },
                select: { id: true, fullName: true },
              }),
            }
          : {}),
        // Owners named directly plus the owners of the named pets, decided in the same snapshot.
        ...(owned.length
          ? { owners: db.user.findMany({ where: { role: 'owner', OR: owned }, select: personSelect }) }
          : {}),
      };
      const names = Object.keys(queries),
        values =
          names.length === 1
            ? [await queries.sender]
            : await db.$transaction(Object.values(queries), { isolationLevel: 'RepeatableRead' });
      const found = Object.fromEntries(names.map((name, index) => [name, values[index]]));
      const sender = found.sender as {
          id: string;
          role: Role;
          fullName: string;
          passwordChangedAt: Date | null;
        } | null,
        pets = (found.pets ?? []) as Pet[],
        doctor = (found.doctor ?? null) as { id: string; fullName: string } | null,
        owners = (found.owners ?? []) as Prisma.UserGetPayload<{ select: typeof personSelect }>[];
      const result = ((): { status: number; [key: string]: unknown } => {
        if (!sender || sender.role !== actor.role) return { status: 403, error: 'Actor permission changed.' };
        // AQ-05: Clinic forwards the caller's bearer; a session issued before a password change is revoked.
        if (issuedBeforePasswordChange(req.headers.authorization!.slice(7), sender.passwordChangedAt))
          return { status: 401, error: 'Password changed. Sign in again.', code: 'SESSION_REVOKED' };
        if (pets.length !== petIds.length) return { status: 404, error: 'Pet not found.' };
        if (
          actor.role === 'owner' &&
          (pets.some(p => p.ownerId !== actor.sub) || ownerIds.some(id => id !== actor.sub))
        )
          return { status: 403, error: 'Owner scope required.' };
        if (data.doctorId && !doctor) return { status: 422, error: 'Doctor not found.' };
        const allOwnerIds = [...new Set([...ownerIds, ...pets.map(p => p.ownerId)])],
          byId = new Map(owners.map(u => [u.id, u]));
        if (owners.length !== allOwnerIds.length) return { status: 404, error: 'Owner not found.' };
        return {
          status: 200,
          actor: { sub: sender.id, role: sender.role, fullName: sender.fullName },
          pets: pets.map(p => ({ ...petDto(p), directoryVersion: p.directoryRevision })),
          owners: allOwnerIds
            .map(id => byId.get(id)!)
            .map(u => ({ ...ownerDto(u), directoryVersion: u.directoryRevision })),
          ...(doctor ? { doctor } : {}),
        };
      })();
      const { status, ...body } = result;
      res.status(status).json(body);
    } catch {
      res.status(503).json({ error: 'Core directory unavailable.' });
    }
  };
  app.post('/internal/directory/authorize', express.json({ limit: '64kb' }), handle);
  app.post('/internal/directory/lookup', express.json({ limit: '64kb' }), handle);
  app.get('/internal/directory/export', async (req, res) => {
    const { kind, cursor, id, limit = '50' } = req.query;
    if (
      typeof kind !== 'string' ||
      !['owner', 'pet', 'staff'].includes(kind) ||
      typeof limit !== 'string' ||
      !/^\d+$/.test(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 100 ||
      (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 200)) ||
      (id !== undefined && (typeof id !== 'string' || !id || id.length > 200))
    ) {
      res.status(422).json({ error: 'Invalid export cursor.' });
      return;
    }
    try {
      const bounds = { take: Number(limit), orderBy: { id: 'asc' as const } };
      const filter = id ? { id: id as string } : cursor ? { id: { gt: cursor as string } } : {};
      const rows =
        kind === 'pet'
          ? await db.pet.findMany({ where: filter, ...bounds })
          : await db.user.findMany({
              where: { role: kind === 'owner' ? 'owner' : { not: 'owner' }, ...filter },
              select: personSelect,
              ...bounds,
            });
      const items = rows.map(r => ({
        id: r.id,
        sourceVersion: r.directoryRevision,
        displayName: 'name' in r ? r.name : r.fullName,
        ...('ownerId' in r
          ? { ownerId: r.ownerId, species: r.species, breed: r.breed, microchipId: r.microchipId }
          : kind === 'owner'
            ? { phone: r.phone, email: r.email }
            : {}),
        deletedAt: null,
      }));
      if (id && !items.length) {
        // An older queued upsert can arrive after delete/role change. Return
        // the durable Core tombstone instead of poisoning that valid event.
        const eventType = `directory.${kind}-upserted.v1`;
        const tombstones = await db.$queryRaw<
          { payload: Record<string, unknown> }[]
        >`SELECT envelope->'payload' AS payload FROM "OutboxEvent" WHERE envelope->>'aggregateId'=${id as string} AND envelope->>'eventType'=${eventType} AND envelope->'payload'->>'deletedAt' IS NOT NULL ORDER BY (envelope->>'aggregateVersion')::integer DESC LIMIT 1`;
        if (tombstones[0]) {
          res.json({ kind, items: [tombstones[0].payload], nextCursor: null });
          return;
        }
      }
      res.json({ kind, items, nextCursor: items.length === Number(limit) ? items.at(-1)!.id : null });
    } catch {
      res.status(503).json({ error: 'Core directory export unavailable.' });
    }
  });
}
