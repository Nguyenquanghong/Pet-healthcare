BEGIN;
-- Exact aggregate-cache invalidation, not event versions or a commit watermark.
-- Separate rows avoid coupling source, directory and projector write locks.
CREATE TABLE "AppointmentQueryEpoch" (
  scope TEXT PRIMARY KEY CHECK (scope IN ('source-acl','projection','directory')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0)
);
INSERT INTO "AppointmentQueryEpoch" (scope) VALUES ('source-acl'),('projection'),('directory');

-- Restricted projector roles need not receive UPDATE on the guard table.
-- Qualify the target from the trigger's schema, not the caller's search_path.
CREATE FUNCTION appointment_query_epoch_bump() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE affected integer;
BEGIN
  EXECUTE format('UPDATE %I."AppointmentQueryEpoch" SET revision=revision+1 WHERE scope=$1',TG_TABLE_SCHEMA) USING TG_ARGV[0];
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'APPOINTMENT_QUERY_EPOCH_UNAVAILABLE'; END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER appointment_query_source_membership
AFTER INSERT OR DELETE OR TRUNCATE ON appointments
FOR EACH STATEMENT EXECUTE FUNCTION appointment_query_epoch_bump('source-acl');
CREATE TRIGGER appointment_query_source_acl
AFTER UPDATE OF id,owner_id,pet_id ON appointments
FOR EACH ROW WHEN (OLD.id IS DISTINCT FROM NEW.id OR OLD.owner_id IS DISTINCT FROM NEW.owner_id OR OLD.pet_id IS DISTINCT FROM NEW.pet_id)
EXECUTE FUNCTION appointment_query_epoch_bump('source-acl');
CREATE TRIGGER appointment_query_projection
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "AppointmentReadRow"
FOR EACH STATEMENT EXECUTE FUNCTION appointment_query_epoch_bump('projection');
CREATE TRIGGER appointment_query_directory
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "DirectoryProjection"
FOR EACH STATEMENT EXECUTE FUNCTION appointment_query_epoch_bump('directory');
COMMIT;
