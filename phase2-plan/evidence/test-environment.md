# Verified isolated test environment

## P7 — 12/10/2026

- Retain exact3 project/volumes/old failure queues. Each rehearsal creates new
  legacy/Core/Clinic/Notification databases and a separate restore DB, runtime
  schema, UUID-derived roles/markers. Bootstrap owns DDL; app roles cannot self-
  grant revoked privileges. PostgreSQL host/port fixed to loopback:55432.
- Monolith source, three built target APIs, four built workers and Nginx use own
  ports/PID/prefix. Source/target JWT, RSA kid and scoped tokens are explicitly
  configured; no .env/live URLs. Target APIs use pool=2, control clients=4.
- Snapshots/context/backup/child logs remain ignored locally; reports contain
  only counts/hashes/schema/aggregate totals. All P7 DBs/roles/rows and failed
  artifacts are retained, no reset/seed/down-v, old message queues untouched.
- Fresh install check copied 509 current source files with hash
  4e41e6a187488b4859b28d8a4a849075e8a21de34f49105934e4c8d281f0c76c;
  isolated npm ci, npm test, phase2:build and P7 11/11 each exited 0. No old
  node_modules/generated/dist copied. It is the same Windows host, not remote CI.
  Copy captured before final report/catalog-check refinements; the source-final
  aggregate separately verifies final P7 code. Native P6 loss cause remains unknown.
- Reproduction/rollback limits are in the
  [migration runbook](../../deploy/phase2/migration-runtime.md).
- Final guarded stop: exact3 containers Exited (0), all DBs/roles/rows/dumps/volumes
  retained; both P2/P4 failure queues still ready=1/unacked=0 before stop. Original
  user Node processes and automation helpers untouched; owned API/worker exits zero.

## P6 verification — historical 11–12/10/2026

- Retained exact3 `pet-phase2-p1-test`, own database/role/marker and loopback port
  guards apply to every writing suite. Core uses `core_runtime_test`, the other
  services `p1_proof`; no live DB/config, seed/reset or volume deletion.
- Node v24.15.0/Windows, Prisma 6.19.3. P6 adds Redis client 6.3.0 and the scoped
  runtime workspace; build dependency overrides/guard are recorded in the P6
  report. This supersedes the initial dependency snapshot below.
- Two Core and two Clinic APIs, Notification API, own built workers and actual
  Nginx 1.30.5 run on dynamic loopback ports. Official Windows Nginx archive is
  pinned/hash-checked in ignored workspace tooling; no global install or change
  to the user's gateway. E2E uses strict target RSA/kid/credentials and Redis.
- Proof API/worker pools are 2, control clients 4; default deployment budget is
  separately documented in [runtime runbook](../../deploy/phase2/resilience-runtime.md).
  Metrics/resources are single correctness snapshots, not workload capacity.
- Build/generate and service proofs run sequentially to avoid Windows DLL sharing
  failures. Network-restricted Prisma checksum download failed before tests;
  the authorized network-enabled regression then exited 0.
- Runtime/process failure history, exact commands and results remain in
  [test history](test-results.md). Native Windows startup/process-loss causes
  are not established; diagnostic runner checks every owned child's exit code.
- Reports contain sanitized metadata; raw logs/resources stay under ignored
  `test-results/phase2`. Prior nonempty failure queues and all fixture data remain.
- Final guarded stop completed: all three test containers Exited (0), all volumes
  retained; two prior failure queues each had ready=1/unacked=0. Start again with
  `npm run phase2:up`; no user API/process or live database was stopped/modified.

## Initial P0/P1 environment snapshot — historical

- Local date: 11/10/2026, Asia/Ho_Chi_Minh.
- Windows/PowerShell, Node v24.15.0, npm 11.12.1, Prisma 6.19.3; lockfile retained existing dependency versions. New dependencies: amqplib 0.10.9/types and workspace links.
- Docker engine 29.8.1. Initially unavailable; initial sandbox launch could not write Docker host logs. Relaunched only this session's Desktop processes normally; no running engine/old stack was present during restart. No auto-review rejection.
- Compose file: `deploy/phase2/compose.test.yml`; fixed project label `pet-phase2-p1-test`. The test runner checks container project labels before proceeding.
- Infrastructure: postgres:16-alpine at 127.0.0.1:55432, rabbitmq:4.1-management-alpine at 127.0.0.1:5679, redis:7.4-alpine at 127.0.0.1:6389. All three healthy when observed. This is local single-instance infrastructure, not HA.
- New volumes: `pet-phase2-p1-test_p2_pg_test`, `pet-phase2-p1-test_p2_rabbit_test`. Existing volumes/compose/config untouched; no volume deletion.
- Databases/roles: `p2_core_test` / `p2_core`, `p2_clinic_test` / `p2_clinic`, `p2_notification_test` / `p2_notification`. App roles are NOSUPERUSER/NOCREATEDB/NOCREATEROLE; PUBLIC CONNECT revoked; no cross grants.
- Each client verifies `current_database()` and `current_user`, plus `public.p2_test_marker` equal to `pet-phase2-p1-test:<service>:v1`, before any migration/test write.
- App/migration tables reside in `p1_proof`; marker is in `public`. URLs are explicit synthetic localhost fixtures in test code; legacy `.env` is not used for test writes. Reports omit connection strings/passwords.
- Synthetic actor/appointment/event IDs use fresh UUIDs each run. Rows and terminal operations retained; no seed/reset/truncate. Only the unique proof queue is deleted after tests, after processing the expected messages.
- Built runtimes tested temporarily on localhost:55101 and 55102 with their own DB URLs, then the spawned processes stopped. Readiness queries owned tables, not broker availability.
- Infrastructure stopped at checkpoint with Compose `stop`; volumes/data retained. Next session: `npm run phase2:up` then `npm run phase2:test:integration`.

Continuation P1 — 11/10/2026:

- Resumed the same project and volumes; 18 original local file hashes still match. New transport-only workspace uses already locked amqplib/types; no fourth service or new infrastructure.
- Three built worker processes tested with distinct DB URLs, unique broker prefix and selected fixture aggregate. Observed notifications from both producer DBs and billing finalization by Clinic.
- Guarded suite stopped/restarted only this project's RabbitMQ. An already confirmed persistent queued message survived restart; another event remained in outbox while broker was down, then both appeared once in Notification after catch-up.
- Readiness after restart checked by bounded authenticated AMQP handshake. Docker health alone initially allowed a handshake failure; it is no longer the readiness proof.
- Only empty per-run queues/exchanges deleted; nonempty failed-run queues retained. Spawned workers stopped. Infrastructure stopped again at final checkpoint; volumes/data retained.

## P2 final environment — 11/10/2026

- Same dedicated three-container project and retained volumes. Docker Desktop was
  stopped at resume; launched the installed application hidden, then phase2:up
  passed all three health checks. No legacy Compose command or DB write.
- Full Core clone uses core_runtime_test schema on p2_core_test with Core role;
  Clinic/Notification retain p1_proof in their DBs. Marker remains in public.
  Project/services and PostgreSQL 127.0.0.1:55432 binding now checked in a shared
  test-project guard, also invoked by standalone migration CLI.
- Core/Notification HTTP use dynamically reserved localhost ports; a second built
  Notification API process shares only its own Notification DB. Ephemeral RSA
  private key exists only in Core test process; children strip signing keys.
  Core runtime relay and Notification consumer are built child processes, stopped
  by their owned process handles after the catch-up tests.
- Chromium headless v1243 installed with Playwright browser GC disabled, preserving
  existing caches. UI test server 127.0.0.1:5187 serves built frontend only, fails
  if port already occupied, has no API/DB proxy. All APIs are intercepted; external
  browser requests blocked. No default demo E2E or real login credentials used.
- RabbitMQ outage is restricted to this Compose project, stable hostname retained,
  authenticated AMQP wait before resuming. Synthetic DB rows/volumes/import
  artifacts retained; no resets/seeds/truncates/purges/down-v. Only empty queues of
  the test's unique prefix are removed. Final stack stop preserves all volumes.
