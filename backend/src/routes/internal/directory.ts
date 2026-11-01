import type { Express, Request, RequestHandler, Response } from 'express';
import express from 'express';
import type { DirectoryKind, DirectoryReader, DirectoryRow } from '../../application/ports/directory.js';
import type { DirectoryAuthorization, DirectoryDecision } from '../../application/services/directoryAuthorization.js';
import { verifyToken } from '../../lib/token.js';
import { ownerDto, petDto } from '../dto/serialize.js';
import { acceptsCredential } from '@nipopeto/runtime';

function decisionBody(decision: DirectoryDecision) {
  if (decision.status !== 200) return decision;
  return {
    status: decision.status,
    actor: decision.actor,
    pets: decision.pets.map(p => ({ ...petDto(p), directoryVersion: p.directoryRevision })),
    owners: decision.owners.map(u => ({ ...ownerDto(u), directoryVersion: u.directoryRevision })),
    ...(decision.doctor ? { doctor: decision.doctor } : {}),
  };
}

function exportItem(kind: DirectoryKind, r: DirectoryRow) {
  return {
    id: r.id,
    sourceVersion: r.directoryRevision,
    displayName: 'name' in r ? r.name : r.fullName,
    ...('ownerId' in r
      ? { ownerId: r.ownerId, species: r.species, breed: r.breed, microchipId: r.microchipId }
      : kind === 'owner'
        ? { phone: r.phone, email: r.email }
        : {}),
    deletedAt: null,
  };
}

const credentialGate =
  (credential?: string): RequestHandler =>
  (req, res, next) => {
    if (!credential || credential.length < 32 || credential.length > 512) {
      res.status(503).json({ error: 'Directory authorization unavailable.' });
      return;
    }
    if (!acceptsCredential(req.headers['x-service-token'], credential)) {
      res.status(401).json({ error: 'Service authentication required.' });
      return;
    }
    next();
  };

const authorizeHandler = (authorization: DirectoryAuthorization) => async (req: Request, res: Response) => {
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
    (data.doctorId !== undefined && (typeof data.doctorId !== 'string' || !data.doctorId || data.doctorId.length > 200))
  ) {
    res.status(422).json({ error: 'Invalid directory IDs.' });
    return;
  }
  try {
    const decision = await authorization.decide(actor, req.headers.authorization!.slice(7), {
      petIds,
      ownerIds,
      doctorId: data.doctorId,
    });
    const { status, ...body } = decisionBody(decision);
    res.status(status).json(body);
  } catch {
    res.status(503).json({ error: 'Core directory unavailable.' });
  }
};

const exportHandler = (reader: DirectoryReader) => async (req: Request, res: Response) => {
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
    const rows = await reader.exportPage(
      kind as DirectoryKind,
      { id: id as string | undefined, after: cursor as string | undefined },
      Number(limit),
    );
    const items = rows.map(r => exportItem(kind as DirectoryKind, r));
    if (id && !items.length) {
      const tombstone = await reader.tombstone(kind as DirectoryKind, id as string);
      if (tombstone) {
        res.json({ kind, items: [tombstone], nextCursor: null });
        return;
      }
    }
    res.json({ kind, items, nextCursor: items.length === Number(limit) ? items.at(-1)!.id : null });
  } catch {
    res.status(503).json({ error: 'Core directory export unavailable.' });
  }
};

export function mountDirectoryRoutes(
  app: Express,
  authorization: DirectoryAuthorization,
  reader: DirectoryReader,
  credential?: string,
) {
  app.use('/internal/directory', credentialGate(credential));
  const handle = authorizeHandler(authorization);
  app.post('/internal/directory/authorize', express.json({ limit: '64kb' }), handle);
  app.post('/internal/directory/lookup', express.json({ limit: '64kb' }), handle);
  app.get('/internal/directory/export', exportHandler(reader));
}
