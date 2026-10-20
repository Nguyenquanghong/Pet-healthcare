BEGIN;
-- A reused backend PID alone must not inherit the operator's fence exemption.
CREATE OR REPLACE FUNCTION clinic_read_rebuild_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_pid integer; operator_lock boolean;
BEGIN
 IF NOT pg_try_advisory_xact_lock_shared(hashtext(TG_TABLE_SCHEMA),730003) THEN
  RAISE EXCEPTION 'CLINIC_READ_REBUILD_FROZEN' USING ERRCODE='55000';
 END IF;
 EXECUTE format('SELECT "ownerPid" FROM %I."ReadRebuildRun" WHERE frozen',TG_TABLE_SCHEMA) INTO owner_pid;
 IF owner_pid IS NULL THEN RETURN NULL; END IF;
 IF owner_pid <> pg_backend_pid() THEN RAISE EXCEPTION 'CLINIC_READ_REBUILD_FROZEN' USING ERRCODE='55000'; END IF;
 SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock' AND objsubid=2 AND objid=730003 AND classid::bigint=(hashtext(TG_TABLE_SCHEMA)::bigint & 4294967295)) INTO operator_lock;
 IF NOT operator_lock THEN RAISE EXCEPTION 'CLINIC_READ_REBUILD_FROZEN' USING ERRCODE='55000'; END IF;
 RETURN NULL;
END;
$$;
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['medical_records','medical_images','booking_status_events','AppointmentBillingTerminal','RequestDedup'] LOOP
  EXECUTE format('CREATE TRIGGER read_rebuild_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION clinic_read_rebuild_fence()',t);
 END LOOP;
END;
$$;
-- Relay may mark/lease already committed events; producing new ones is fenced.
CREATE TRIGGER read_rebuild_fence BEFORE INSERT OR DELETE OR TRUNCATE ON "OutboxEvent" FOR EACH STATEMENT EXECUTE FUNCTION clinic_read_rebuild_fence();
COMMIT;
