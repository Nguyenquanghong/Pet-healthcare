BEGIN;
-- Pair each writer transaction with the operator's schema-scoped exclusive
-- advisory lock. This also fences writers whose MVCC snapshot predates the run.
CREATE OR REPLACE FUNCTION clinic_read_rebuild_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE blocked boolean;
BEGIN
 IF NOT pg_try_advisory_xact_lock_shared(hashtext(TG_TABLE_SCHEMA),730003) THEN
  RAISE EXCEPTION 'CLINIC_READ_REBUILD_FROZEN' USING ERRCODE='55000';
 END IF;
 EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I."ReadRebuildRun" WHERE frozen AND "ownerPid" <> pg_backend_pid())',TG_TABLE_SCHEMA) INTO blocked;
 IF blocked THEN RAISE EXCEPTION 'CLINIC_READ_REBUILD_FROZEN' USING ERRCODE='55000'; END IF;
 RETURN NULL;
END;
$$;
COMMIT;
