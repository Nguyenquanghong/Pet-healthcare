// AQ-09 Claim Check + Valet Key port: bytes in an S3-compatible bucket, the row keeps a claim,
// readers get a short-lived presigned GET URL. Implemented by ../../blobStore.ts.
export interface BlobStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  signedGetUrl(key: string, options?: { now?: Date }): { url: string; expiresAt: Date };
  ensureBucket(): Promise<void>;
  check(): Promise<void>;
}
