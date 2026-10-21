BEGIN;
-- Additive projection V2 schema (clinic-activity D2). Existing V1 generations,
-- rows, inbox namespaces and serving modes are unchanged. Role grants are
-- environment-owned (tools/phase2/p7-cutover.mjs and trial harnesses), not here.

-- Projection schemaVersion is 1 (rows) or 2 (rows + daily summary) and never
-- changes in place; a V2 generation is always a new UUID built from source.
ALTER TABLE "ReadProjectionGeneration" ADD CONSTRAINT "ReadProjectionGeneration_schemaVersion_check" CHECK ("schemaVersion" IN (1,2));
CREATE UNIQUE INDEX "ReadProjectionGeneration_id_schemaVersion_key" ON "ReadProjectionGeneration"("id","schemaVersion");
CREATE FUNCTION read_projection_schema_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'READ_PROJECTION_SCHEMA_VERSION_IMMUTABLE' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER read_projection_schema_version_immutable BEFORE UPDATE OF "schemaVersion" ON "ReadProjectionGeneration"
FOR EACH ROW WHEN (OLD."schemaVersion" IS DISTINCT FROM NEW."schemaVersion") EXECUTE FUNCTION read_projection_schema_version_immutable();

-- One counter per business day (SQL DATE appointmentDate), service type and
-- current status. Projector changes it only with atomic SQL increments/guarded
-- decrements in the row+inbox transaction. No ownerId/notes/billing/PII.
CREATE TABLE "AppointmentDailySummary" (
    "generation" TEXT NOT NULL,
    "appointmentDate" DATE NOT NULL,
    "type" "AppointmentType" NOT NULL,
    "status" "AppointmentStatus" NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 2,
    "appointmentCount" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "AppointmentDailySummary_pkey" PRIMARY KEY ("generation","appointmentDate","type","status"),
    CONSTRAINT "AppointmentDailySummary_count_nonnegative" CHECK ("appointmentCount" >= 0),
    CONSTRAINT "AppointmentDailySummary_schemaVersion_check" CHECK ("schemaVersion" = 2)
);
-- Summary rows exist only for V2 generations; deleting a generation with
-- counters requires the runbook (RESTRICT), never a cascade.
ALTER TABLE "AppointmentDailySummary" ADD CONSTRAINT "AppointmentDailySummary_generation_schemaVersion_fkey" FOREIGN KEY ("generation","schemaVersion") REFERENCES "ReadProjectionGeneration"("id","schemaVersion") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Operator-owned activity serving mode, default authoritative source. The
-- summary generation is ReadProjectionControl('appointments'), not a column here.
CREATE TABLE "ClinicActivityControl" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "servingMode" TEXT NOT NULL DEFAULT 'source',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicActivityControl_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ClinicActivityControl_singleton" CHECK ("id" = 1),
    CONSTRAINT "ClinicActivityControl_servingMode_check" CHECK ("servingMode" IN ('source','cached','summary'))
);
INSERT INTO "ClinicActivityControl" ("id","servingMode") VALUES (1,'source');

-- Same durable rebuild fence as other projection tables.
CREATE TRIGGER read_rebuild_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "AppointmentDailySummary" FOR EACH STATEMENT EXECUTE FUNCTION clinic_read_rebuild_fence();
CREATE TRIGGER read_rebuild_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "ClinicActivityControl" FOR EACH STATEMENT EXECUTE FUNCTION clinic_read_rebuild_fence();
COMMIT;
