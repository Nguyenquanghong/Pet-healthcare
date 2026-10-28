BEGIN;
-- The CQRS read projection left the code on 28/10 (tag cqrs-projection-archive-20261028).
-- Its database hooks stayed behind and still act on the write path. This migration
-- removes the hooks and keeps every table, row and migration of the projection as history.

-- 1. Rebuild write fence. With any ReadRebuildRun.frozen row present, every write to these
--    tables failed with CLINIC_READ_REBUILD_FROZEN, and the operator tool that clears it is gone.
--    Created by 20261015000300, 20261015000500 and 20261021000100.
DROP TRIGGER IF EXISTS read_rebuild_fence ON "appointments";
DROP TRIGGER IF EXISTS read_rebuild_fence ON "AppointmentReservation";
DROP TRIGGER IF EXISTS read_rebuild_fence ON "ClinicReadRevision";
DROP TRIGGER IF EXISTS read_rebuild_fence ON "DirectoryProjection";
DROP TRIGGER IF EXISTS read_rebuild_fence ON "InboxEvent";
DROP TRIGGER IF EXISTS read_rebuild_fence ON "AppointmentReadRow";
DROP TRIGGER IF EXISTS read_rebuild_fence ON "ReadProjectionGeneration";
DROP TRIGGER IF EXISTS read_rebuild_fence ON "ReadProjectionControl";
DROP TRIGGER IF EXISTS read_rebuild_fence ON "medical_records";
DROP TRIGGER IF EXISTS read_rebuild_fence ON "medical_images";
DROP TRIGGER IF EXISTS read_rebuild_fence ON "booking_status_events";
DROP TRIGGER IF EXISTS read_rebuild_fence ON "AppointmentBillingTerminal";
DROP TRIGGER IF EXISTS read_rebuild_fence ON "RequestDedup";
DROP TRIGGER IF EXISTS read_rebuild_fence ON "OutboxEvent";
DROP TRIGGER IF EXISTS read_rebuild_fence ON "AppointmentDailySummary";
DROP TRIGGER IF EXISTS read_rebuild_fence ON "ClinicActivityControl";
-- No CASCADE: a fence trigger missed above makes this fail instead of being dropped unseen.
DROP FUNCTION IF EXISTS clinic_read_rebuild_fence();

-- 2. The source-acl epoch. Every appointment INSERT/DELETE bumped the same row, so concurrent
--    writers queued on its lock. Nothing reads AppointmentQueryEpoch any more (the aggregate
--    cache that did is gone). Created by 20261017000100. The shared function
--    appointment_query_epoch_bump() stays: the 'projection' and 'directory' epoch triggers
--    still use it.
DROP TRIGGER IF EXISTS appointment_query_source_membership ON "appointments";
DROP TRIGGER IF EXISTS appointment_query_source_acl ON "appointments";

-- 3. Events for the removed read projection. No code emits them, the contract no longer
--    lists the type and the broker has no binding for it, so the relay would retry such a
--    row every 60 s forever. Close the open ones the way the relay does after a confirm
--    (published, lease released) and keep the rows, attempts and last error as the trace.
--    publishedAt is TIMESTAMP(3) written by Prisma in UTC.
UPDATE "OutboxEvent"
SET "publishedAt" = now() AT TIME ZONE 'UTC', "leaseOwner" = NULL, "leaseUntil" = NULL
WHERE "publishedAt" IS NULL AND envelope->>'eventType' = 'clinic.appointment-read-changed.v1';
COMMIT;
