BEGIN;
-- Optimistic lock: every successful edit bumps "revision"; an edit or delete
-- names the revision it was based on and a stale one is refused (409).
-- Authorship: "doctor_id" is the responsible doctor, decided by the server from
-- the session or the appointment; "doctor_name" stays the name snapshot taken at
-- creation. Older rows keep doctor_id NULL: no trustworthy name -> id mapping.
-- Additive with defaults, so existing rows and readers stay valid.
ALTER TABLE "medical_records"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "doctor_id" TEXT,
  ADD CONSTRAINT "medical_records_revision_valid" CHECK ("revision" >= 0);
-- Record revision after the change (before it, for a delete); NULL on older audit rows.
ALTER TABLE "medical_record_revisions" ADD COLUMN "record_revision" INTEGER;
COMMIT;
