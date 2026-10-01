CREATE TABLE "owner_activations" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "issued_by" TEXT NOT NULL,
  "issued_by_name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "owner_activations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "owner_activations_token_hash_key" ON "owner_activations"("token_hash");
CREATE INDEX "owner_activations_owner_id_created_at_idx" ON "owner_activations"("owner_id", "created_at");
ALTER TABLE "owner_activations" ADD CONSTRAINT "owner_activations_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
