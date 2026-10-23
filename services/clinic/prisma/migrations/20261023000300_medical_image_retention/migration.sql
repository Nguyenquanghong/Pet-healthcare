BEGIN;
-- AQ-09 retention. Additive: a deleted image becomes a tombstone (deleted_at,
-- deleted_by) that list/sign paths skip; blob_cleanup for its object is due at the
-- end of the retention window. Role grants are environment-owned
-- (tools/phase2/p7-cutover.mjs grants INSERT/SELECT only on the log); the trigger
-- keeps log rows immutable even for the schema owner.
ALTER TABLE "medical_images" ADD COLUMN "deleted_at" TIMESTAMP(3), ADD COLUMN "deleted_by" TEXT;
-- NOT VALID: both new columns are NULL in every existing row, so the rows already
-- satisfy it; skipping the scan keeps the ALTER lock short on a large table.
ALTER TABLE "medical_images" ADD CONSTRAINT "medical_images_tombstone_check"
  CHECK (("deleted_at" IS NULL) = ("deleted_by" IS NULL)) NOT VALID;
CREATE INDEX "medical_images_deleted_idx" ON "medical_images"("deleted_at") WHERE "deleted_at" IS NOT NULL;

CREATE TABLE "medical_image_deletions" (
  "id" TEXT NOT NULL,
  "image_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "pet_id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "storage_key" TEXT,
  "sha256" TEXT,
  "size_bytes" INTEGER,
  "actor_id" TEXT NOT NULL,
  "actor_role" TEXT NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "medical_image_deletions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "medical_image_deletions_action_check" CHECK ("action" IN ('delete','restore','purge'))
);
CREATE INDEX "medical_image_deletions_image_idx" ON "medical_image_deletions"("image_id","at","id");
CREATE FUNCTION medical_image_deletions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'MEDICAL_IMAGE_DELETION_IMMUTABLE' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER medical_image_deletions_immutable BEFORE UPDATE OR DELETE ON "medical_image_deletions"
FOR EACH ROW EXECUTE FUNCTION medical_image_deletions_immutable();
COMMIT;
