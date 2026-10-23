import type { ApiSchemas } from "./generated/api";

// AQ-07: API shapes are generated from backend/openapi.json (types/generated/api.ts);
// this file only names them for the UI.
export type Pet = ApiSchemas["Pet"];
export type PetSpecies = Pet["species"];
export type PetGender = Pet["gender"];
export type PetHealthStatus = Pet["healthStatus"];
export type PetPublicProfile = ApiSchemas["PublicProfile"];
// The QR endpoint intentionally returns only a public subset of the private Pet DTO.
export type PublicPet = ApiSchemas["PublicPetProfile"];
