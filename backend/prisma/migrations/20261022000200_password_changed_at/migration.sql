-- AQ-05: revoke sessions issued before a password change. Additive and nullable:
-- existing users and tokens are unaffected until their next password change.
ALTER TABLE "users" ADD COLUMN "password_changed_at" TIMESTAMP(3);
