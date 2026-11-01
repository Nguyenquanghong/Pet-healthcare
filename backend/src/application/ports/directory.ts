import type { Role } from '../../domain/auth.js';
import type { UserAccount } from './auth.js';
import type { PetValue } from './pets.js';

export type DirectoryRequest = { petIds: string[]; ownerIds: string[]; doctorId?: string };

export type DirectorySender = { id: string; role: Role; fullName: string; passwordChangedAt: Date | null };
export type DirectoryDoctor = { id: string; fullName: string };

// What one request reads. The reads that name nothing come back empty, a missing sender or doctor as null.
export type DirectorySnapshot = {
  sender: DirectorySender | null;
  pets: PetValue[];
  doctor: DirectoryDoctor | null;
  owners: UserAccount[];
};

export type DirectoryKind = 'owner' | 'pet' | 'staff';
// `id` asks for one row; otherwise `after` is the cursor, an empty one meaning the first page.
export type DirectoryExportFilter = { id?: string; after?: string };
export type DirectoryRow = PetValue | UserAccount;

export interface DirectoryReader {
  snapshot(actorId: string, request: DirectoryRequest): Promise<DirectorySnapshot>;
  exportPage(kind: DirectoryKind, filter: DirectoryExportFilter, limit: number): Promise<DirectoryRow[]>;
  tombstone(kind: DirectoryKind, id: string): Promise<Record<string, unknown> | null>;
}
