import type { Role } from "../../domain/auth.js";

export type ActivationOwner = { id: string; fullName: string; email: string | null; role: Role; loginEnabled: boolean };
export type OwnerInvitation = {
  id: string; ownerId: string; email: string; expiresAt: Date; usedAt: Date | null; revokedAt: Date | null;
  owner: ActivationOwner;
};
export interface ActivationTransaction {
  owner: ActivationOwner;
  emailTaken(email: string): Promise<boolean>;
  findInvitation(tokenHash: string): Promise<OwnerInvitation | null>;
  revokePending(now: Date): Promise<void>;
  createInvitation(data: { tokenHash: string; email: string; expiresAt: Date; issuedBy: string; createdAt: Date }): Promise<void>;
  setCredentials(email: string, credentials: { passwordHash: string; passwordSalt: string }): Promise<void>;
  markUsed(id: string, now: Date): Promise<void>;
}
export interface OwnerActivationRepository {
  findInvitation(tokenHash: string): Promise<OwnerInvitation | null>;
  run<T>(ownerId: string, work: (tx: ActivationTransaction) => Promise<T>): Promise<T>;
}
export interface ActivationTokenPort {
  create(): { token: string; tokenHash: string };
  hash(token: string): string;
}
