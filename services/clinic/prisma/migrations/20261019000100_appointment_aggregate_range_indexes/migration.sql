-- Support bounded read aggregates without repeatedly scanning wide heap rows.
-- Both indexes are non-unique; source ACL checks remain in every cache-miss SQL.
-- Do not INCLUDE unbounded serviceName/notes or change command constraints.
CREATE INDEX "appointments_read_acl_range_idx" ON appointments (id)
  INCLUDE (owner_id, pet_id);

CREATE INDEX "appointment_read_aggregate_range_idx" ON "AppointmentReadRow"
  (generation, "appointmentId")
  INCLUDE ("ownerId", "petId", status, "billingHeld", "appointmentDate", type)
  WHERE "deletedAt" IS NULL;
