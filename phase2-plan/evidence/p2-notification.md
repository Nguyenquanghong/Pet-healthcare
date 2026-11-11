# P2 Notification completed on the isolated stack, 11/10/2026

Status: DONE against P2 acceptance; no live traffic/data cutover or handoff H.
Sequential implementation on main/add596e, no agents/merge/commit/push. Original
18 local file SHA256 values still match. User revoked the old credit limit.

## Implemented behavior

Notification owns Notification, InboxEvent and RequestDedup with a separate
generated client/database. Six public paths: list/unread/read/read-all/delete/send.
Owner scope derives only from verified subject; admin/doctor/staff use the admin
inbox as on main. Pagination/filter/count/related/query bounds and stable
createdAt/id ordering retained. DB errors return 503, never a false unread zero.
Scoped mutation guards remain at the write statement.

Inbox/effect share a transaction; ACK follows commit, inbox survives deletion.
P1 retry/DLQ/selected replay confirms replacement before original ACK and preserves
eventId. All 12 P1 regression bodies passed with the full Notification model.

Manual send validates actor RS256 and queries current staff/recipient authority
through Core before new writes. Core requires a separate service credential plus
verified actor token, returns only bound sender/role/recipient. Missing recipient
or withdrawn role fails closed. RequestDedup unique actor/type/key, canonical
validated content hash; conflicting insert waits for the winning transaction.
Dedup/effect/response cache commit together. Same request returns original ID/body;
changed content is 409. Retry after delete does not recreate a row. Historical
cache can be returned with Core offline, still requiring valid local actor JWT;
new sends cannot bypass Core. No dedup TTL/purge.

Core index now uses a separate composition before mounting the original app.ts,
preserving that dirty user file. Every /api/notifications route goes to Notification
or returns 503, never falls back to a local insert. Additive RS256 private/public/
issuer/audience config is required for split routing; Notification gets public key
only. Old HS256 remains only when all asymmetric variables are absent. No mixed
algorithm fallback; async PBKDF2 210000 iterations and default 8h expiry retained.

All Core domain NotificationWriters use outbox in their existing transaction:
appointment/reminder/lifecycle, medical, hotel/care, invoice/pay/transfer,
payment confirm/review and rescue. Reminder has no other mutation, a single atomic
outbox insert. Stable notification/event IDs persist after commit; 32 KiB whitelist
validation excludes internalNote. Core runtime relay has its own full-schema
OutboxStore adapter; Core billing proof schema/client/worker stays separate.
Clinic proof has a local writer; actual PG success/rollback couples appointment
and outbox atomically.

Frontend reuses Idempotency-Key after response failure, changes for changed/new
intent, disables in-flight submission, distinguishes saved from refresh failed.
Owner/admin inbox unread comes from Notification, unknown/error is not all-read.
Public OpenAPI has 66 operations (65 baseline + unread-count), required send key.
Notification OpenAPI has six paths. Internal OpenAPI adds implemented authorize-send;
seven P1 directory/billing paths remain reserved contracts.

## Rehearsal and migrations

Full legacy Core migrations plus additive OutboxEvent applied only to
p2_core_test/core_runtime_test, a synthetic clone schema. Notification conversion
and RequestDedup only on p2_notification_test/p1_proof; Clinic own p1_proof retained.
No historical migration edited or live database altered.

Offline CLI export/dry-run/import/verify uses hardcoded fixture endpoints, no .env.
Guard project/services/PG binding/DB/role/schema/marker before writes. Snapshot has
checksum/field whitelist/deterministic legacy event IDs. Atomic per-row import can
resume after partial failure; occupied IDs reject overwrite. Two backdated legacy
sent/read fixtures retain every ID/recipient/type/link/sender/status/createdAt/sentAt
exactly. Destination read advancement/deletion survives replay. Actual CLI executed
all four commands on retained source fixture dataset. No production migration or
backup/restore claim.

## Actual verification

- phase2:verify exit 0: all workspace builds, contracts 5/5, boundaries/writer audit,
  P1 real PG/broker 12/12 (~25.2s), Notification API/inbox 5/5 (~4.9s), runtime
  8/8 (~25.0s), no skips.
- Runtime retest after adding real discarded HTTP response body and hotel/cash
  during broker outage: exit 0, 8/8, no skips (~24.5s).
- Final npm test exit 0: backend/frontend/package builds, 81/81 unit,
  architecture 88 files, public OpenAPI 66 operations.
- notification-ui exit 0, 3/3 Chromium (~7.6s), built frontend on isolated static
  server 127.0.0.1:5187; every API intercepted, no database proxy.
- verify-local exit 0, 18 hashes; git diff --check exit 0, informational LF/CRLF only.
- CI includes writer/runtime/UI suites; remote CI not run.

Runtime tests use actual Core composition, Notification API and two Notification
processes on their own database. Real Core-issued login token accepted; concurrent
send/key mismatch/actor/delete, discarded HTTP body after commit and retry same
durable ID, current-role revocation/authority outage, send rollback and all producer
types. A real OutboxEvent CHECK failure rolls back actual HTTP appointment create.
Broker stopped while appointment/hotel/cash commit plus pending outbox; manual send
independent of broker. Restart retained volume, actual built Core relay fills durable
queue before consumer, then Notification worker and Clinic writer catch up all events.
Synthetic payment repository calls test confirm/review writers without real gateway.
UI mocks verify state/request behavior, not substitutes for real PG/broker tests.
Failed runs and fixes retained in test-results.md.

## Remaining work

P3 still ports Appointment/Medical/Images/history/read routes to Clinic, directory
source revisions/projection/authorization and idempotency. Core owns these domains
during P2; Clinic is still proof/health, not a full public service. P4 proof billing
is not public protocol/reconciler. Bootstrap/header/dashboard still read legacy
Notification and global polling; P5 adapter needed before application cutover.
P6 shared limiter/auth surge/key rotation/network/metrics/dependency advisories;
P7 full migration/backup restore/cutover; P8 benchmark. Full legacy DB integration,
real multi-service browser journeys, remote CI, HA/host loss and capacity unverified.
H and the whole phase 2 are not complete.

[Runtime runbook](../../deploy/phase2/notification-runtime.md),
[API/writer delta](p2-api-and-writer-inventory.md),
[migration report](migration-report.md), [test history](test-results.md),
[decisions](decisions.md).
