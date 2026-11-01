import type { Actor, Role } from '../../domain/auth.js';
import type { UserAccount } from '../ports/auth.js';
import type { DirectoryDoctor, DirectoryReader, DirectoryRequest } from '../ports/directory.js';
import type { PetValue } from '../ports/pets.js';

export type DirectoryRefusal = { status: 401 | 403 | 404 | 422; error: string; code?: string };
export type DirectoryGrant = {
  status: 200;
  actor: { sub: string; role: Role; fullName: string };
  pets: PetValue[];
  owners: UserAccount[];
  doctor?: DirectoryDoctor;
};
export type DirectoryDecision = DirectoryRefusal | DirectoryGrant;

export class DirectoryAuthorization {
  // `sessionRevoked` is handed the signed token (without "Bearer ") and the account's last password change.
  constructor(
    private readonly reader: DirectoryReader,
    private readonly sessionRevoked: (bearer: string, changedAt: Date | null) => boolean,
  ) {}
  async decide(actor: Actor, bearer: string, request: DirectoryRequest): Promise<DirectoryDecision> {
    const { sender, pets, doctor, owners } = await this.reader.snapshot(actor.sub, request);
    if (!sender || sender.role !== actor.role) return { status: 403, error: 'Actor permission changed.' };
    // AQ-05: Clinic forwards the caller's bearer; a session issued before a password change is revoked.
    if (this.sessionRevoked(bearer, sender.passwordChangedAt))
      return { status: 401, error: 'Password changed. Sign in again.', code: 'SESSION_REVOKED' };
    if (pets.length !== request.petIds.length) return { status: 404, error: 'Pet not found.' };
    if (
      actor.role === 'owner' &&
      (pets.some(p => p.ownerId !== actor.sub) || request.ownerIds.some(id => id !== actor.sub))
    )
      return { status: 403, error: 'Owner scope required.' };
    if (request.doctorId && !doctor) return { status: 422, error: 'Doctor not found.' };
    const allOwnerIds = [...new Set([...request.ownerIds, ...pets.map(p => p.ownerId)])],
      byId = new Map(owners.map(u => [u.id, u]));
    if (owners.length !== allOwnerIds.length) return { status: 404, error: 'Owner not found.' };
    return {
      status: 200,
      actor: { sub: sender.id, role: sender.role, fullName: sender.fullName },
      pets,
      owners: allOwnerIds.map(id => byId.get(id)!),
      ...(doctor ? { doctor } : {}),
    };
  }
}
