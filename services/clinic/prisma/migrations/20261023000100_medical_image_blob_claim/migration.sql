BEGIN;
-- AQ-09 expand step (Claim Check). Additive and reversible: base64 rows keep
-- working until tools/phase2/migrate-medical-images.mjs has moved them to the
-- bucket; a later contract migration may drop "image_url".
ALTER TABLE "medical_images" ALTER COLUMN "image_url" DROP NOT NULL;
ALTER TABLE "medical_images" ADD COLUMN "storage_key" TEXT, ADD COLUMN "size_bytes" INTEGER, ADD COLUMN "sha256" TEXT;
CREATE UNIQUE INDEX "medical_images_storage_key_key" ON "medical_images"("storage_key");
ALTER TABLE "medical_images" ADD CONSTRAINT "medical_images_content_check" CHECK (
  ("image_url" IS NOT NULL AND "storage_key" IS NULL AND "size_bytes" IS NULL AND "sha256" IS NULL) OR
  ("image_url" IS NULL AND "storage_key" IS NOT NULL AND "size_bytes" > 0 AND "sha256" ~ '^[0-9a-f]{64}$')) NOT VALID;
-- NOT VALID: enforced for new writes at once; existing rows are checked by the next
-- migration under a lock that does not block reads and writes.

CREATE TABLE "blob_cleanup" (
  "storage_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "blob_cleanup_pkey" PRIMARY KEY ("storage_key")
);
CREATE INDEX "blob_cleanup_next_attempt_at_idx" ON "blob_cleanup"("next_attempt_at");
COMMIT;
