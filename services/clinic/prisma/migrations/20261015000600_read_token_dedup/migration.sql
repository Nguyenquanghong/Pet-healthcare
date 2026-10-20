-- Persist the exact committed read versions for idempotent response replay.
-- Historical keys remain replayable without inventing a revision/token.
ALTER TABLE "RequestDedup" ADD COLUMN "readVersions" JSONB NOT NULL DEFAULT '{}';
