BEGIN;
-- PostgreSQL row locks require UPDATE on at least one column. Runtime receives
-- UPDATE(lockAnchor) only; generation pointer and serving mode remain operator-only.
ALTER TABLE "ReadProjectionControl" ADD COLUMN "lockAnchor" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ReadProjectionControl" ADD CONSTRAINT "ReadProjectionControl_lockAnchor_check" CHECK ("lockAnchor");
COMMIT;
