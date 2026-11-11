# P0–P2 migration report

Current P2 report is appended below; prior checkpoints describe their state at
the time and do not supersede the final P2 results.

Initial migration ID in each new proof schema: `20261011000100_p1_proof`.

| Owner              | Location                                  | Contents                                                                                                                                                                                   |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core proof         | `backend/prisma/phase2/migrations`        | BillingOperation, ProofInvoice, OutboxEvent; actor/key unique; one PREPARING operation/source; terminal state check; VND nonnegative integer; invoice source/operation unique and local FK |
| Clinic proof       | `services/clinic/prisma/migrations`       | ProofAppointment, BillingReservation, OutboxEvent; active pet/date/time unique across types; one HELD/INVOICED reservation/source; state check; local appointment FK                       |
| Notification proof | `services/notification/prisma/migrations` | InboxEvent composite consumer/event primary key; ProofNotification ID unique                                                                                                               |

Applied with `prisma migrate deploy` only after fixture identity/marker verification,
to the three new test databases in schema `p1_proof`. Repeated deployment succeeded.
Bootstrap SQL creates separate roles/database CONNECT permissions and safety markers
only on first initialization of the new volume.

No old migration edited. No legacy schema altered, no source data copied, no cutover.
Proof tables intentionally omit full clinical/history/payment fields; they are not
the P7 data manifest or a production migration. Existing public API/OpenAPI unchanged.

Rollback scope: stop only the proof project and review/revert source changes. Keep
synthetic volumes/data for evidence; do not use reset/down-v. There has been no live
write migration to reverse. P7 needs an explicit validated cutover/rollback plan.

Continuation P1 — 11/10/2026:

- Added Clinic migration `20261011000200_p1_inbox_directory`, applied after the same identity/marker checks.
- Adds local InboxEvent and DirectoryProjection, with consumer/event dedup, `(kind,id)` key and positive source version check; no foreign-service FK or credential fields.
- Existing initial migrations unchanged. Repeated deploy succeeds; no reset or manual terminal-state edits.
- Projection/inbox and billing effects/inbox share local transactions. Older versions cannot overwrite newer projections/tombstones; terminal billing conflicts roll back inbox.

P2 checkpoint — 11/10/2026:

- Notification migration `20261011000300_p2_notification` applied only to guarded `p2_notification_test/p1_proof`. Initial migration unchanged.
- Renames retained ProofNotification to notifications, converts read boolean to sent/read status without deleting IDs/rows, adds all legacy metadata fields and page indexes. Owner/admin recipient and status checks are local; no cross-service FK.
- First deployment test inserted a synthetic read=true P1 row, then verified its ID/owner/title and read status after migration. Existing proof rows did not have timestamps; the migration initializes those timestamps at migration time. This does **not** claim preservation of timestamps absent from P1.
- Full P2 event timestamps/status/IDs are preserved exactly in a real consumer test. Legacy export/import has not been implemented or run; its timestamps must be supplied explicitly during later rehearsal.
- This field/status conversion is not directly compatible with the old P1 generated client. Do not run old binaries on the upgraded test schema; forward-fix/rebuild or restore a separately verified test backup, rather than assuming code-only rollback.
- RabbitMQ hostname is now stable to load the same node directory from its named volume after recreate. Prior node directories/data remain on that volume; no reset/down-v/purge was used. Recovering messages from older node directories requires explicit operator procedure; no recovery claim for those failed-run fixtures.

## P2 final — 11/10/2026

| Migration                                     | Destination actually applied     | Behavior                                                                             |
| --------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| Core 20261011000400_notification_outbox       | p2_core_test / core_runtime_test | Add OutboxEvent with pending/next-attempt index, no changes to historical migrations |
| Notification 20261011000500_manual_send_dedup | p2_notification_test / p1_proof  | Add durable RequestDedup, unique actor/operation/key; no cross-service FK or TTL     |

Core runtime suite first deployed the full existing Core migration chain into a
new empty core_runtime_test schema on the guarded Core test database, then the
additive outbox migration. This is a synthetic legacy-schema clone, not the DB in
backend/.env. Core P1 billing proof remains separately in p1_proof. Notification
and Clinic repeated migrate deploy on their own roles/DBs; no reset/data deletion.

Offline export/dry-run/import/verify tooling implemented. CLI checks dedicated
three-service Docker project, bound fixture PG host/port, current DB/role/schema
and marker before writes; explicit hardcoded test URLs, no .env destination.
Snapshot has fields whitelist, checksum, deterministic legacy event ID; export
uses exclusive file creation under ignored test-results/phase2. Reports omit bodies.

Real PostgreSQL rehearsal compares two old Notification fixtures with sent/read
states and backdated createdAt/sentAt. IDs, recipients, type, status, action/related
IDs, sender and both timestamps compare exactly. Fault after effect before commit
on second row rolls back inbox/effect; earlier row remains, replay resumes safely.
After destination read/delete, repeat import does not regress/resurrect. Corrupted
snapshot and occupied target ID are rejected without overwrite. All four CLI
commands also executed successfully against the retained legacy fixture dataset.

No traffic/ownership cutover, real data export, backup restore, history split or
reservation backfill performed. P7 still requires a quiesced source, retained
backup/restore proof and whole-model manifest. Do not use these CLI fixtures as a
production data migration without explicit destination authorization and review.
Rollback is not dropping tables: keep test data; stop stack or forward-fix. After
Notification accepts new writes, re-enabling a legacy writer would split ownership
and is not a supported code-only rollback. User's running DB is unchanged.

## P3 additive schemas and source directory, 11/10/2026

Core migration `20261011000600_directory_outbox` applied only to
`p2_core_test/core_runtime_test`. User/Pet existing rows start revision 1; every
insert/update increments/records directory event in the transaction via invoker
triggers with pinned Core schema search path. Delete and role-kind change record
tombstones. No credential/medical fields are copied into event payloads.

Clinic migration `20261011000700_clinic_domains` applied only to
`p2_clinic_test/p1_proof`. Adds complete appointment/medical/image/history models,
status enums/indexes, partial active-slot unique, local appointment reservation
with active unique/state check, request dedup and directory search fields. No
cross-service FK/client; local medical/history/reservation FKs stay in Clinic.
P1 proof rows/models and earlier migrations are retained, no reset or seed.

Directory backfill rehearsal used private Core keyset export, stable inbox keys
and a durable queue declared before snapshot. A source update after its snapshot
page remains absent from search until built worker catches up, then sourceVersion
and full text match. Older versions/tombstones do not regress; a queued upsert
after source deletion hydrates the durable tombstone. Resume/backfill is per
version, not a destructive replacement of the projection.

No full Appointment/MedicalRecord/MedicalImage/history import from the live DB
performed. No ownership/traffic cutover or backup/restore claim. Full manifest,
IDs/timestamps/Decimal/history verification and reservation/invoice snapshot
backfill remain P7. New Clinic writes cannot be rolled back by simply re-enabling
a Core writer; retain/export/reconcile them before any separately authorized
cutover. No drop/down-v commands were run.

## P4 actual billing, 11/10/2026

Core `20261011000800_appointment_billing` deployed only to
`p2_core_test/core_runtime_test`: actual operation with actor/type/key hash,
revision/fees/state/invoice/snapshot, terminal/finalized timestamps and retry lease
metadata; unique active PREPARING source. Invoice gets optional source_snapshot,
keeps appointment_id scalar unique and financial data, drops only the legacy
appointment FK. Operation invoice relation stays local to Core; multiple owner
checkout aliases may reference one already-issued invoice, without new effects.

Clinic `20261011000900_billing_terminal` deployed only to
`p2_clinic_test/p1_proof`: metadata timestamps on actual reservations, durable
terminal marker, state/invoice checks. Existing P3 reservation timestamps start
at migration time because prior model had none; no historical timestamp claim.
All appointment/medical/history local FKs, partial unique and prior proof models
remain. InvoiceId is scalar Core evidence, never a cross-service FK.

New invoices preserve VND/fees and store selected Clinic source snapshot. A legacy
paid synthetic fixture without clinical FK/snapshot was read through Core HTTP:
same IDs/items/issuedAt/paidAt/totals/status; no live data used. Broker/inbox and
HTTP reconciliation keep one INVOICED or RELEASED reservation. Actual outbox
constraint fault rolls back invoice/both outbox effects while retaining a pending
operation for same-key retry. No migration files from earlier checkpoints edited.

Full historical snapshot/INVOICED reservation backfill, whole-model migration,
backup restore and reverse migration still P7. Null legacy snapshots need that
backfill before split checkout/cutover. Do not re-enable a Core clinical writer
after new Clinic writes or drop protocol tables to rollback; preserve/export/
reconcile new data, run a verified reverse migration or forward-fix. No live
DB/traffic cutover, seed/reset, volume delete or financial history rewrite.

## P5 — No new database migration

Dashboard GETs, session/query lifecycle and directory/search metadata add no
schema or historical data rewrite. The guarded browser runner only deploys the
existing P0–P4 migrations to the already identified test schemas; it never resets
them. New clinical/financial rows are UUID fixtures, not migrated real records.
Core OutboxEvent CHECK in the pending UI test is a temporary constraint scoped to
one test appointment, removed in finally; it is not a release migration.

Deploy Core/Clinic API contracts before frontend P5. A frontend rollback can use
the retained bootstrap adapter when its dependencies are available; it does not
reverse Clinic ownership or restore historical snapshot/reservation data. The P7
cutover/rollback limitations above still apply.

## P6 — Runtime only, no new migration

Auth admission/JWT/scoped credentials/health/metrics/pool budgets add no SQL schema
or business-history rewrite. Tests deploy existing P0–P4 migrations only on
identified test schemas; no runtime seed/migrate. UUID counter-owner activation
proof keeps ownerId/pet/appointment/medical/invoice relations. The expiry test
only expires its own fixture activation, not any pre-existing account token.

The target config requires coordinated RSA public/private key/issuer/audience/kid
and separate service credential deployment. HS256 tokens need re-login; reverting
to legacy Core clinical/notification writers is not a safe data rollback. P7
must rehearse ownership/data reversal or forward-fix before any live change.

## P7 final — 12/10/2026

Full guarded export/dry-run/import/validate, backup restore and single-writer
cutover now run on new synthetic legacy/Core/Clinic/Notification/restore DBs per
UUID. See [P7 evidence](p7-migration-cutover.md), [234-field manifest](p7-field-manifest.json),
[reconciliation](p7-reconciliation.json) and [runbook](../../deploy/phase2/migration-runtime.md).
This supersedes earlier statements that historical backfill/restore are pending
for the synthetic current-schema rehearsal; it does not claim live dataset migration.

No new Prisma migration P7 or edits to historical migrations. New fixture-only
marker/journal/cutover control, roles/grants and Core hotel-history CHECK are
managed by guarded tooling. Import transactions retain all source fields and
invoice/notification history. Core moved tables remain empty with runtime grants
revoked; six real cross-service DB connection attempts fail.

Two historical clinical invoices receive snapshots and INVOICED reservation/terminal
evidence. Source fixture has no pre-existing P4 terminal operation; broad mixed
dataset/schema upgrade is not inferred. Missing historic snapshots and ambiguous
missing notification recipients/events require reviewed evidence, not silent
repair. Partial component import journals resume without overwriting target data.

Custom source backup was restored into a fresh database and compared exactly.
Pre-open rollback and post-open forward-fix with retained new data passed. Once
opened_at is recorded, old-source rollback is always rejected. Reverse migration,
target restore after new writes/PITR and any live cutover remain outside verified scope.
