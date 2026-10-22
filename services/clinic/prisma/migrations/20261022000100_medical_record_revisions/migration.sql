BEGIN;
-- AQ-15: append-only audit history of medical record create/update/delete.
-- Additive; no existing table changes. Role grants are environment-owned
-- (tools/phase2/p7-cutover.mjs grants INSERT/SELECT only); the trigger keeps
-- rows immutable even for the schema owner.
CREATE TABLE "medical_record_revisions" (
  "id" TEXT NOT NULL,
  "record_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "before" JSONB,
  "after" JSONB,
  "actor_id" TEXT NOT NULL,
  "actor_role" TEXT NOT NULL,
  "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "medical_record_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "medical_record_revisions_action_check" CHECK ("action" IN ('create','update','delete')),
  CONSTRAINT "medical_record_revisions_shape_check" CHECK (
    ("action" = 'create' AND "before" IS NULL AND "after" IS NOT NULL) OR
    ("action" = 'update' AND "before" IS NOT NULL AND "after" IS NOT NULL) OR
    ("action" = 'delete' AND "before" IS NOT NULL AND "after" IS NULL))
);
CREATE INDEX "medical_record_revisions_record_idx" ON "medical_record_revisions"("record_id","changed_at","id");
CREATE FUNCTION medical_record_revisions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'MEDICAL_RECORD_REVISION_IMMUTABLE' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER medical_record_revisions_immutable BEFORE UPDATE OR DELETE ON "medical_record_revisions"
FOR EACH ROW EXECUTE FUNCTION medical_record_revisions_immutable();
COMMIT;
