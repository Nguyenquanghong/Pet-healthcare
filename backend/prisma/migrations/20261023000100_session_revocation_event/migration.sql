-- AQ-05: a password change revokes earlier sessions in every service, not only
-- in Core/Clinic. Like the directory events, a trigger writes the outbox row in
-- the same transaction as the change, for every writer of password_changed_at.
-- Notification consumes it (identity.sessions-revoked.v1) and refuses older tokens.
-- password_changed_at is TIMESTAMP(3) holding UTC (Prisma), so it is formatted
-- without a zone conversion; aggregateVersion is its whole epoch second.
CREATE FUNCTION session_revoked_event_write() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE event_id text;
BEGIN
  event_id=gen_random_uuid()::text;
  INSERT INTO "OutboxEvent" (id,envelope) VALUES (event_id,jsonb_build_object('schemaVersion',1,'eventId',event_id,
    'eventType','identity.sessions-revoked.v1','producer','core','aggregateType','user','aggregateId',NEW.id,
    'aggregateVersion',floor(extract(epoch FROM NEW.password_changed_at))::bigint,
    'occurredAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'correlationId',event_id,
    'payload',jsonb_build_object('userId',NEW.id,'revokedBefore',to_char(NEW.password_changed_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))));
  RETURN NULL;
END $$;
CREATE TRIGGER users_session_revoked_event AFTER UPDATE OF password_changed_at ON users FOR EACH ROW
  WHEN (NEW.password_changed_at IS NOT NULL AND NEW.password_changed_at IS DISTINCT FROM OLD.password_changed_at)
  EXECUTE FUNCTION session_revoked_event_write();
