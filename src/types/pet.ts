export type PetSpecies = "dog" | "cat" | "rabbit" | "other";
export type PetGender = "male" | "female" | "unknown";
export type PetHealthStatus = "healthy" | "vaccination_due" | "under_treatment" | "critical" | "stable";

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
};