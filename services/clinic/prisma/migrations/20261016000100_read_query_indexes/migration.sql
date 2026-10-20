-- Clinic read-model paging; source ACL checks remain mandatory.
CREATE INDEX "appointment_read_admin_page_idx" ON "AppointmentReadRow"
  ("generation","deletedAt","status","createdAt" DESC,"appointmentId" DESC);
CREATE INDEX "appointment_read_owner_page_idx" ON "AppointmentReadRow"
  ("generation","deletedAt","ownerId","status","appointmentDate" DESC,"appointmentTime" DESC,"appointmentId" DESC);
