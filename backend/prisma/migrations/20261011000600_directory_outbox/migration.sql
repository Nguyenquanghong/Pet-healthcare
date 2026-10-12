ALTER TABLE users ADD COLUMN directory_revision INTEGER NOT NULL DEFAULT 1 CHECK (directory_revision > 0);
ALTER TABLE pets ADD COLUMN directory_revision INTEGER NOT NULL DEFAULT 1 CHECK (directory_revision > 0);

-- Invoker rights and pinned migration search path; only the owning Core schema.
CREATE FUNCTION directory_revision_increment() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP='UPDATE' THEN NEW.directory_revision=OLD.directory_revision+1;
  ELSE NEW.directory_revision=1; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_directory_revision BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION directory_revision_increment();
CREATE TRIGGER pets_directory_revision BEFORE INSERT OR UPDATE ON pets FOR EACH ROW EXECUTE FUNCTION directory_revision_increment();

CREATE FUNCTION directory_event_write() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE r jsonb; payload jsonb; kind text; event_id text; v integer; deleted text; old_kind text;
BEGIN
  r=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  v=(r->>'directory_revision')::integer + CASE WHEN TG_OP='DELETE' THEN 1 ELSE 0 END;
  deleted=CASE WHEN TG_OP='DELETE' THEN to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END;
  kind=CASE WHEN TG_TABLE_NAME='pets' THEN 'pet' WHEN r->>'role'='owner' THEN 'owner' ELSE 'staff' END;
  -- Baseline identity is never reused. On role change tombstone the previous kind.
  IF TG_TABLE_NAME='users' AND TG_OP='UPDATE' THEN
   IF (OLD.role='owner') IS DISTINCT FROM (NEW.role='owner') THEN
    old_kind=CASE WHEN OLD.role='owner' THEN 'owner' ELSE 'staff' END;
    event_id=gen_random_uuid()::text;
    INSERT INTO "OutboxEvent" (id,envelope) VALUES (event_id,jsonb_build_object('schemaVersion',1,'eventId',event_id,'eventType','directory.'||old_kind||'-upserted.v1','producer','core','aggregateType',old_kind,'aggregateId',OLD.id,'aggregateVersion',v,'occurredAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'correlationId',event_id,'payload',jsonb_build_object('id',OLD.id,'sourceVersion',v,'displayName',left(OLD.full_name,200),'deletedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))));
   END IF;
  END IF;
  payload=jsonb_build_object('id',r->>'id','sourceVersion',v,'displayName',left(CASE WHEN kind='pet' THEN r->>'name' ELSE r->>'full_name' END,200),'deletedAt',deleted);
  IF kind='pet' THEN payload=payload||jsonb_build_object('ownerId',r->>'owner_id','species',r->>'species','breed',left(r->>'breed',200));
  ELSIF kind='owner' THEN payload=payload||jsonb_build_object('phone',left(r->>'phone',200)); END IF;
  event_id=gen_random_uuid()::text;
  INSERT INTO "OutboxEvent" (id,envelope) VALUES (event_id,jsonb_build_object('schemaVersion',1,'eventId',event_id,'eventType','directory.'||kind||'-upserted.v1','producer','core','aggregateType',kind,'aggregateId',r->>'id','aggregateVersion',v,'occurredAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'correlationId',event_id,'payload',payload));
  RETURN NULL;
END $$;
CREATE TRIGGER users_directory_event AFTER INSERT OR UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION directory_event_write();
CREATE TRIGGER pets_directory_event AFTER INSERT OR UPDATE OR DELETE ON pets FOR EACH ROW EXECUTE FUNCTION directory_event_write();
