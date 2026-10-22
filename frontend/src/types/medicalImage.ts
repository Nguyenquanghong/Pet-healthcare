export type MedicalImage = {
  id: string;
  petId: string;
  title: string;
  mimeType: string;
  sizeBytes: number | null;
  // Valet key: short-lived presigned URL for the bytes in the image bucket;
  // null for a legacy image that has not been moved to the bucket yet.
  url: string | null;
  urlExpiresAt: string | null;
  createdAt: string;
};
