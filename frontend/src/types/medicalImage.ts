import type { ApiSchemas } from "./generated/api";

// AQ-07: generated from the OpenAPI contract (types/generated/api.ts). `url` is the
// short-lived Valet Key; null for a legacy image not yet moved to the bucket.
// `imageUrl` (inline data URL) is sent only by the single-backend Phase 1 API.
export type MedicalImage = ApiSchemas["MedicalImage"] & { imageUrl?: string };
