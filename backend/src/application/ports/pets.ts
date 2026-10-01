export type PetValue = {
  id: string; ownerId: string; name: string; species: string; breed: string | null;
  gender: string; ageLabel: string | null; weightKg: number | { toString(): string } | null;
  microchipId: string | null; healthStatus: string; allergies: string[]; notes: string | null;
  avatarUrl: string | null; identifyingMarks: string | null; lastSeenLocation: string | null;
  qrToken: string | null; qrEnabled: boolean; showOwnerPhone: boolean; showOwnerEmail: boolean;
  showOwnerAddress: boolean; showMedicalAlerts: boolean; rescueNote: string | null;
  createdAt: Date; updatedAt: Date;
};

export type PetChanges = Partial<Pick<PetValue,
  "name" | "species" | "breed" | "gender" | "ageLabel" | "weightKg" | "microchipId" |
  "healthStatus" | "allergies" | "notes" | "avatarUrl" | "identifyingMarks" | "lastSeenLocation" |
  "qrToken" | "qrEnabled" | "showOwnerPhone" | "showOwnerEmail" | "showOwnerAddress" |
  "showMedicalAlerts" | "rescueNote"
>> & { weightKg?: number | null };

export interface PetRepository {
  list(ownerId?: string): Promise<PetValue[]>;
  find(id: string): Promise<PetValue | null>;
  ownerExists(ownerId: string): Promise<boolean>;
  create(data: PetChanges & { ownerId: string; name: string; species: string; gender: string; healthStatus: string; allergies: string[]; qrToken: string | null }): Promise<PetValue>;
  update(id: string, changes: PetChanges): Promise<PetValue>;
}

export interface QrTokenPort {
  create(): string;
}
