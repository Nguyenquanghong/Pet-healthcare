import type { Actor } from '../../domain/auth.js';

export type PetSnapshot = {
  id: string;
  ownerId: string;
  name: string;
  directoryVersion: number;
  [key: string]: unknown;
};
export type OwnerSnapshot = { id: string; fullName: string; directoryVersion: number; [key: string]: unknown };
export type DoctorSnapshot = { id: string; fullName: string };
export type DirectorySnapshot = {
  actor: Actor & { fullName: string };
  pets: PetSnapshot[];
  owners: OwnerSnapshot[];
  doctor?: DoctorSnapshot;
};

// Per-request directory view authorized by Core for the verified actor.
// Adapter: RequestDirectory (directory.ts); the port lives here so application
// code never depends on the HTTP adapter.
export interface DirectoryLookup {
  pet(id: string): Promise<PetSnapshot>;
  lookup(petIds: string[], ownerIds: string[]): Promise<DirectorySnapshot>;
  // A user Core currently holds in the doctor role (422 otherwise).
  doctor(id: string): Promise<DoctorSnapshot>;
  // The acting user as Core verified them for this request.
  signer(): DoctorSnapshot;
}
