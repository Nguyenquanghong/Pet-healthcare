BEGIN;
CREATE TABLE "ReadRebuildRun" (
 "id" TEXT PRIMARY KEY, "generation" TEXT NOT NULL UNIQUE,
 "expectedGeneration" TEXT, "ownerPid" INTEGER NOT NULL,
 "frozen" BOOLEAN NOT NULL DEFAULT true, "checkpoint" TEXT, "sourceHash" TEXT,
 "state" TEXT NOT NULL DEFAULT 'BUILDING', "copied" INTEGER NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "ReadRebuildRun_state_check" CHECK ("state" IN ('BUILDING','READY','COMPLETE','ABORTED'))
);
CREATE UNIQUE INDEX "ReadRebuildRun_one_frozen" ON "ReadRebuildRun" ("frozen") WHERE "frozen";
-- Runtime can read the fence, never own/change it. Resolve the metadata table in
-- the triggering table's schema, not an ambient search_path. No SECURITY DEFINER.
CREATE FUNCTION clinic_read_rebuild_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE blocked boolean;
BEGIN
 EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I."ReadRebuildRun" WHERE frozen AND "ownerPid" <> pg_backend_pid())',TG_TABLE_SCHEMA) INTO blocked;
 IF blocked THEN RAISE EXCEPTION 'CLINIC_READ_REBUILD_FROZEN' USING ERRCODE='55000'; END IF;
 RETURN NULL;
END;
$$;
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['appointments','AppointmentReservation','ClinicReadRevision','DirectoryProjection','InboxEvent','AppointmentReadRow','ReadProjectionGeneration','ReadProjectionControl'] LOOP
  EXECUTE format('CREATE TRIGGER read_rebuild_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION clinic_read_rebuild_fence()',t);
 END LOOP;
END;
$$;
COMMIT;
