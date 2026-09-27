export type PetSpecies = "dog" | "cat" | "rabbit" | "other";
export type PetGender = "male" | "female" | "unknown";
export type PetHealthStatus = "healthy" | "vaccination_due" | "under_treatment" | "critical" | "stable";

export type PetPublicProfile = {
  showOwnerPhone: boolean;
  showOwnerEmail: boolean;
  showOwnerAddress: boolean;
  showMedicalAlerts: boolean;
  rescueNote?: string;
};

export type Pet = {
  id: string;
  ownerId: string;
  name: string;
  species: PetSpecies;
  breed: string;
  gender: PetGender;
  ageLabel: string;
  weightKg?: number;
  microchipId?: string;
  avatarUrl?: string;
  healthStatus: PetHealthStatus;
  allergies?: string[];
  notes?: string;
  identifyingMarks?: string;
  lastSeenLocation?: string;
  qrToken?: string;
  qrEnabled?: boolean;
  publicProfile?: PetPublicProfile;
};

// The QR endpoint intentionally returns only a public subset of the private Pet DTO.
export type PublicPet = Pick<Pet, "id" | "name" | "species" | "breed" | "gender" | "ageLabel" | "microchipId" | "avatarUrl" | "identifyingMarks" | "lastSeenLocation" | "qrEnabled" | "publicProfile"> &
  Partial<Pick<Pet, "healthStatus" | "allergies">>;
