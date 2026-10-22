-- AQ-09 contract step for medical images (expand: 20261023000100/000200).
-- Run it only when ALL of these hold, never earlier:
--   1. tools/phase2/migrate-medical-images.mjs --check-contract reports contractReady=true
--      (every image is a bucket claim; no inline base64 left);
--   2. the Clinic release that removes `imageUrl` from services/clinic/prisma/schema.prisma
--      is ready to deploy right after it (older Clinic builds still name the column);
--   3. a database backup exists.
-- The guard refuses to drop anything while a legacy row remains.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "medical_images" WHERE "image_url" IS NOT NULL) THEN
    RAISE EXCEPTION 'AQ09_LEGACY_IMAGES_REMAIN: run migrate-medical-images.mjs --run first';
  END IF;
END $$;
ALTER TABLE "medical_images" DROP CONSTRAINT "medical_images_content_check";
ALTER TABLE "medical_images" DROP COLUMN "image_url";
ALTER TABLE "medical_images" ALTER COLUMN "storage_key" SET NOT NULL, ALTER COLUMN "size_bytes" SET NOT NULL, ALTER COLUMN "sha256" SET NOT NULL;
ALTER TABLE "medical_images" ADD CONSTRAINT "medical_images_claim_check" CHECK ("size_bytes" > 0 AND "sha256" ~ '^[0-9a-f]{64}$');
COMMIT;
