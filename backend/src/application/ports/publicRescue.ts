import type { PetValue } from "./pets.js";
import type { UserAccount } from "./auth.js";

export interface PublicRescueRepository {
  findEnabledPetWithOwner(token: string): Promise<{ pet: PetValue; owner: UserAccount } | null>;
  findEnabledPetForReport(token: string): Promise<PetValue | null>;
  // AQ-01: serializes reports for one pet so a duplicate check and its insert are atomic.
  lockPet(petId: string): Promise<void>;
  hasRecentReport(petId: string, finderPhone: string, since: Date): Promise<boolean>;
  createReport(data: { petId: string; finderPhone: string; location: string; finderName: string | null; note: string | null }): Promise<void>;
  notifyOwner(data: { recipientOwnerId: string; recipientRole: string; type: string; title: string; message: string; actionUrl: string; relatedPetId: string }): Promise<void>;
}

export interface PublicRescueUnitOfWork {
  run<T>(work: (repo: PublicRescueRepository) => Promise<T>): Promise<T>;
}

export interface PublicRescueDependencies {
  reads: PublicRescueRepository;
  unitOfWork: PublicRescueUnitOfWork;
}
