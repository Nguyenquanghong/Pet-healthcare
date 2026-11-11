# P0–P2 implementation decisions

## Quantitative NFR / Kaggle protocol — 14/10/2026

- User requested measurable NFRs and a deep Kaggle notebook, and selected running
  the entire isolated stack inside Kaggle. Use native Linux processes and fresh
  PostgreSQL clusters, not a tunnel to the user's DB or Docker-in-Docker.
- Preserve existing p95 targets; add p99, completion, sample/repeat requirements,
  bounded recovery/terminal deadlines and generator validity before measurement.
  [Protocol 07](../07-benchmark-protocol.md) and versioned acceptance.json are the
  source of thresholds; these are proposed acceptance targets, not achieved SLOs.
- Private runtime state lives under /tmp; only aggregate reports/CSV/charts go to
  Kaggle working output. Cross-DB permissions and cluster identity are checked.
- One/two Clinic topology on shared Kaggle CPU has no enforced equal resource
  budget; label measured scope, not B2/B3 capacity. No application contract or
  production migration change. Existing Kaggle/local notebooks remain intact.

Entries are chronological. The final P2 decisions below supersede statements
about missing manual send, RSA compatibility and the old credit checkpoint.

- ADR-01/02/03/04 retained: three TypeScript/Express services; Clinic owns all appointments; transactional outbox/inbox; operation/reservation locking. No Java, fourth service, merge or traffic cutover.
- P1 uses a separate **proof Core schema** under `backend/prisma/phase2` and minimal `ProofInvoice`/`ProofAppointment`/`ProofNotification` models. This preserves legacy main/schema/tests and the user's dirty `app.ts`. These models are not the completed production data split. Port complete fields/constraints in P2–P4.
- Generated outputs are distinct: `backend/src/generated/phase2-core`, `services/clinic/src/generated/client`, `services/notification/src/generated/client`. Legacy client generation is retained only for baseline runtime; it is never shared with new services. Contracts contain wire DTO/validation, no persistence/domain repository.
- Use three databases/roles on a new local PostgreSQL instance. Credentials deny cross access; CPU/IO/failure domain remain shared. This is correctness proof, not resource-isolation benchmark.
- Bootstrap safety marker remains outside the app schema. Initial Prisma P3005 corrected by using empty `p1_proof`, without resetting the test volume or touching legacy data.
- Initial proof used the default exchange. Continuation adds a durable topic exchange and separate Notification/Clinic queues. Notification binds its exact event; Clinic binds `directory.#`/`billing.#`. Three service-local workers reconnect. Default-exchange override remains for selected fault tests and retry/DLQ republishing.
- Reserved internal billing OpenAPI is validated but not exposed in the P1 health APIs. `ClinicBilling.reconcile` consumes trusted terminal evidence at the application boundary; service credential verification, directory authorization and actual endpoints belong to subsequent implementation. Public use cases remain legacy.
- Consumer retry confirms and checks mandatory returns before original ACK; failure closes the unacked channel. Continuation tests real DB rollback, poison, exhaustion/DLQ, selected replay, crash before/after replacement confirm, crash after DB commit, unroutable DLQ, broker stop/restart and durable catch-up. This does not certify HA/host loss or every OS process-kill instruction boundary.
- Billing proof hooks are test callbacks, never public debug endpoints. Deterministic contention additionally observes PostgreSQL lock waits; no sleep-only assertion is used as proof of race ordering.
- CI workflow prepared for reproducible local checks on Linux but not run remotely; no CI success claimed. No commit/push was authorized or performed.
- Credit: no account usage telemetry available. Pause at this concrete proof checkpoint per user preference, without claiming a measured credit percentage.

- Shared `packages/messaging` contains transport/lifecycle helpers only, with architecture checks rejecting Prisma/repository/service imports. Core/Clinic retain separate persistence adapters and clients. It is not another service.
- Directory wire payload whitelists ID/display/version/tombstone fields; credential/internal-note fields rejected. Seven reserved internal APIs validated but not exposed in health runtimes. Full authorization and domain producers remain P2–P6 work.
- Revised single-person estimate after P1: 15–23 working days for P2–P7/H, then P8/review. One-month target has risk; re-estimate after P2/P3 without assuming other members help before H.

P2 checkpoint decisions:

- Port Notification behavior from current main rather than merging an experiment branch. Keep full model/metadata and scope rules; independent public OpenAPI explicitly describes only the implemented subset. No frontend/gateway cutover while manual send/producers/migration are pending.
- New Notification runtime only verifies asymmetric actor tokens, using public RSA key plus issuer/audience/exp/role restrictions. Do not copy Core's HMAC signing secret. Core's current HS256 tokens remain incompatible pending issuer work; tests use ephemeral RSA keys. Missing auth makes protected API unavailable, not anonymously accessible.
- Retain initial P1 migration and add a forward conversion to the full Notification model. No legacy DB changes; no fictional timestamp preservation for proof rows that originally lacked timestamps.
- Fix stable RabbitMQ hostname in the dedicated compose. Default random container hostname was unsafe when Compose recreated a container on an existing volume. Verify durability through restart/recreate; retain old node directories. This is a test-infrastructure correction, not a HA claim.
- Stop at a runnable P2 API/inbox checkpoint for the user's credit constraint, without asserting measured usage. P2 remains IN_PROGRESS; next authorized continuation implements manual send/Core authorization and transactional domain producer outbox.

## P2 final decisions — 11/10/2026

- User removed the credit limit; finish P2 sequentially. No agent delegation or
  assumed team capacity. Estimate P3–P7/H 13–20 working days, then P8/review;
  revise after P3. H requires all P0–P7, not one extracted service.
- Add Core composition before mounting the existing app to preserve dirty app.ts.
  index.ts runs that composition. All Notification public routes use the service;
  missing configuration returns 503. Legacy model/read adapters remain for
  bootstrap until P5/P7, but there is no legacy manual-send fallback writer.
- Core asymmetric JWT configuration is additive: legacy HS256 only when all
  asymmetric variables are absent; RS256 with issuer/audience/exp/known role
  otherwise. Split Notification URL requires matching RSA private/public keys
  and service credential. No mixed-algorithm fallback. Existing password format
  and 210000 async PBKDF2 iterations retained. Default access lifetime remains 8h;
  role revocation for general reads has token lifetime latency until P6 policies.
  New manual sends additionally check current role at Core.
- Notification gets only public key. Built replica/worker test environments strip
  Core private key and JWT_SECRET. Private authorize-send credential is scoped to
  this endpoint, SHA256 timing-safe checked and paired with verified actor token;
  bounded recipient-only request/current role/minimal bound response. General
  internal permissions, key rotation/kid and edge network exposure remain P6.
- Notification creation is an aggregate of its own: aggregateType=notification,
  aggregateId=notificationId, aggregateVersion=1 means one creation, not an invented
  appointment revision. Source relation IDs remain payload metadata. Directory
  and billing aggregates keep their own monotonic version/state requirements.
- Core uses its exclusive full-schema client with a local OutboxStore adapter;
  proof Core uses its own generated client/adapter. No casting generated Prisma
  delegates between schemas or sharing a service client's persistence in packages.
  All domain notification calls stay in the existing UoW; no best-effort HTTP send.
- Manual send validates/normalizes content before canonical hash, durable dedup
  unique actor/type/key plus effect/cache in one transaction. Concurrent conflict
  waits for committed response. Retry returns historical cached response without
  authority/network dependency, while actor JWT must still verify locally. Delete
  does not recreate effect; changed content key reuse is 409; no TTL purge.
- Offline migration tools may construct both clients because they are separate
  guarded scripts, never runtime imports. Fixture-only checksum/preflight/resume
  avoids overwrite or status regression. Future P7 freezes actual source and proves
  backup/restore, then removes legacy read ownership; no live cutover authorized.
- Frontend stores a request key per compose intent, retains it after failed response,
  changes it for changed content/next success, guards in-flight submit. Unread is
  unavailable until authoritative response; error is not all-read. Full bootstrap,
  header/dashboard invalidation/session polling changes belong to P5.
- Dependency audit advisories recorded at earlier checkpoint remain unresolved;
  review/targeted patch and regression before deployment in P6. No automatic audit
  fix, downgrade of crypto/workload or production-readiness claim.

## P3 design before implementation

- Port reviewed pure application/domain code into Clinic, not runtime imports from
  Core. Clinic keeps its own Prisma models/adapters and all clinical reads/writes.
  Retain proof tables for P1 regression; full models are additive, no reset.
- Core directory revisions and minimal display events use PostgreSQL row triggers
  in a new migration: every User/Pet insert/update records revision/outbox in the
  same transaction, including registration/profile/activation/password/pet paths.
  No credentials/medical data serialized. Existing records start at revision 1;
  guarded export supplies backfill, subscribe before export then catch-up by version.
- Add optional phone/breed to directory wire schema for baseline joined search.
  Runtime authorization and related DTOs come from bounded Core HTTP with service
  credential and verified actor; projection never grants permission. Owner source
  IDs are immutable under baseline (no transfer/delete API). Images gain ownerId
  source snapshot and verify referenced pets through Core before returning rows.
- Full appointment reservation is local to Clinic, checked under appointment lock
  for conflicting mutations; existing proof reservation is retained independently.
  Actual billing HTTP/reconciler integration belongs to P4. When split Clinic is
  configured, appointment invoice creation must fail closed until P4 is implemented.
- Gateway routing is opt-in through Clinic URL/RSA/private credential config;
  no existing traffic/database cutover. Update request keys/UI/OpenAPI with create
  appointment/medical routes; repeated writes use durable transaction dedup.

## P3 implementation decisions and verified behavior

- Keep wire directory fields bounded, but hydrate full search data through a
  service-authenticated exact Core export before inbox SQL work. This preserves
  baseline name/breed/phone/email/microchip search (including names longer than 200) without placing unbounded profile data in a <=32KiB message. Events remain
  versioned invalidation/source markers. Export returns the durable tombstone
  when an older queued upsert arrives after deletion or owner/staff kind change.
  A committed inbox duplicate ACKs without a new Core call during outage.
- Directory projection never authorizes: current role/source checked through
  Core for all protected clinical reads/writes, page related data via bounded
  request-local lookup. Role withdrawal also prevents replaying a previously
  cached private medical response under a new owner token. Owner scope checks
  remain before pagination/counts; baseline has no pet transfer/delete API.
- Clinic worker runtime must configure Core source/credential; missing source
  fails startup. Explicit CLINIC_PROOF_ONLY=1 retains P1/P2 transport fixtures,
  cannot stand in for a full P3 search projection. No extra service is introduced.
- Core bootstrap compatibility mounts before the retained user app.ts. Its own
  repository skips all clinical queries; private Clinic bootstrap supplies
  dashboard regions and totals. Do not wait for P5 to remove a stale medical
  read path. The global polling/Notification bootstrap parts still belong to P5.
- Pure Clinic lifecycle is restricted to appointments, with the original status
  machine and roles; hotel stays in Core. Medical/reservation/lifecycle mutations
  serialize on the same actual appointment row. No public billing protocol is
  inferred from fixture reservation insertion; P4 remains required.
- Remove the owner's hardcoded doctor ID: this form does not select a doctor,
  so staff assigns one later. Explicit doctorId inputs must refer to a current
  Core doctor. Frontend creates keep request key across uncertain outcomes and
  treat a committed write with reload failure as saved.
- Return Core source directoryVersion in owner/pet DTOs, preserving DTO fields
  and the existing public name length limit. P5 can use it to observe projection
  lag after a source write; a UI search-sync wait/retry mechanism is not yet
  implemented in P3. Historical long names are covered by test-only legacy data,
  not by relaxing public input validation.
- Resolve Core begin insert conflicts across both actor/key and active-source
  unique indexes, then look up the durable actor/key operation. Same-key races
  return one operation; a different key retaining the source returns SOURCE_BUSY.
  PostgreSQL barrier test observes both INSERT lock waiters before release; no
  billing state machine or reservation timeout policy changed.

## P4 runtime decisions

- Keep P1 proof tables/clients separate; actual Core operation is named
  AppointmentBillingOperation and actual Clinic reservation AppointmentReservation.
  Prepare uses service credential plus freshly minted RS256 actor JWT; Core checks
  current role, Clinic checks source owner/status/revision under its appointment
  lock. No reverse Core HTTP call during prepare or cross-service SQL.
- Drop the Core invoice FK to legacy clinical appointments while retaining its
  scalar unique pointer, all legacy financial rows and a new immutable snapshot.
  No destructive rewrite or live cutover. Historical snapshot/reservation backfill
  remains P7; null legacy snapshots still allow existing invoice reads/payments.
- A repeated owner checkout with a new key may alias an existing P4 invoice,
  matching baseline. Alias operations are finalized at Core without another
  reservation, event or notice. InvoiceId is a local many-to-one operation pointer;
  appointmentId uniqueness still enforces at most one actual invoice.
- HTTP deadline ends waiting, not the operation: 202 + Location, durable polling
  by original actor/role and same-key retry. Pending UI persists key/body/id scoped
  to session, freezes fees, and closing the form never claims an abort. Failed
  terminal result unlocks a new intent; saved with refresh failure remains saved.
- Terminal HTTP evidence is fetched from a credential-protected Core read-only
  endpoint, outside Clinic SQL. Browser-supplied state/invoiceId is rejected.
  Inbox applies the same terminal guard atomically; abort tombstones survive
  delivery before prepare. Timeout/404/PREPARING cannot release HELD.
- Reconciler is a Core process, not another service. Leased SKIP LOCKED claims,
  capped retry backoff and lease-owner guarded metadata support crash recovery.
  It can finalize through HTTP when broker is down; invoice/notice outbox remains
  the durable primary delivery path. No age-based Clinic release.
- Test teardown must wait for broker ready **and unacknowledged** counters before
  terminating consumers. A P2 regression retained a directory event not yet in
  inbox: ready=0 had hidden its in-flight SQL/ACK. Added read-only guarded RabbitMQ
  queue statistics, kept failure queue/message and empty-queue assertions; no
  sleep-only workaround, forced ACK, purge or dropped test.

## P5 — Session and screen reads

- Session owns identity/auth lifecycle, including validation/error and registration
  completion feedback across a session boundary. Epoch changes abort previous
  work and remount business query/form state; login clears a prior token before
  attempting another identity. A failed attempt cannot restore that older identity
  on reload. Transient `/me` failure retains token and offers verification retry.
- Keep a lightweight action facade for callers, with domain-scoped invalidation
  of mounted queries. Remove bootstrap/business arrays/global polling from it;
  do not recreate a global cache under a different name. Bounded pet response
  snapshots only support selections/read-your-writes within the current session.
- Dashboard regions are two public authenticated GETs; Core never reads Clinic
  or Notification SQL in split mode. Unread is one Notification query shared by
  header/sidebar/inbox. Errors are explicit, retain previous read timestamps and
  do not masquerade as zero or logout. Region timestamps are not a distributed
  database snapshot. Keep bootstrap as a temporary compatibility adapter with
  separate remote availability and nullable unknown counts.
- Search still uses eventual projections. Selected-pet metadata compares the
  current Core directory version with the projection read beside list data;
  show synchronization lag and retry, while authorization/related DTOs stay fresh.
  This adds metadata, not a projection-based permission grant or another service.
- Browser proof uses real service processes, PostgreSQL and RabbitMQ, with loopback
  proxy and private test-only filesystem control. Restart only the owned Core
  process between cases to isolate the legacy `/auth` quota; do not raise quota,
  bypass hashing or claim an auth surge/replica test. Windows atomic IPC replacement
  retries transient sharing locks without deleting the original control file.
- Network comparison keeps the observed P4 built artifact; only its baked API URL
  changes for the isolated proxy, with before/after hashes. Save full count breakdown:
  independent dashboard requests increase initial count, while removing global
  polling reduces background/page traffic in the measured flows. Do not infer
  throughput/latency/load capacity from this short browser measurement.

## P6 — Shared admission and service resilience

- Identity stays in Core. A shared runtime package owns admission/JWT verification/
  HTTP observation only, never SQL/repositories. Strict target flag requires RSA
  signing + kid and both remote service URLs in Core, public verification only
  in Clinic/Notification, distinct scoped credentials. Preserve original local
  app.ts; own Core composition removes legacy auth limiter and sanitizes errors.
- Login/account/IP counters use one atomic Redis Lua policy, with HMAC keys and
  stable namespace/secret across replicas. /me uses read quota. Redis outage
  rejects writes/auth and admits bounded per-process reads with explicit degraded
  header. This limit is intentionally weaker across multiple replicas; no claim
  of a shared degraded counter. Never trust arbitrary forwarded IP/hop count.
- PBKDF2 keeps the existing 210,000 SHA-256 iterations/hash format, with bounded
  per-process active/queued work. Expired queued work never runs; a running hash
  is not freed by HTTP timeout. Registration/activation/password change use it.
- No mixed HS256/RS256 target acceptance. P7 needs coordinated verifier/key/kid
  rollout and re-login of old tokens; current 8h TTL, no new refresh/revocation
  feature. No live credential rotation or assertion of immediate revocation.
- Separate DB/migration readiness from broker/Redis degradation. Broker outage
  keeps domain+outbox writes valid; persisted backlog soft/hard admission uses a
  bounded own-DB sample and 3s write cache, not an atomic storage ceiling. Pending
  HELD reservations are metrics, never released from timeout/age alone.
- Scope middleware to its actual route namespace. Splitting bootstrap and billing
  credentials exposed the old Clinic billing guard mounted over all /internal;
  valid bootstrap credentials were rejected. Billing guard now leaves unrelated
  internal routes to their own credential middleware, verified by positive and
  negative scope tests and real Notification outage/bootstrap E2E.
- API/worker pools have explicit per-process budgets; HTTP/upstream/queue waits
  are bounded. HTTP deadline can precede actual SQL result; preserve same-key
  retry semantics and never assert rollback from timeout. Windows parent IPC
  invokes real graceful shutdown (child.kill(SIGTERM) force-terminates on Windows),
  with no public debug endpoint. SQL barrier proves worker effect+inbox commit
  before ACK and graceful Core in-flight drain.
- Nginx two-replica proof uses passive failure removal/safe read retry, no
  non_idempotent replay. Durable idempotency/slot constraints remain in Clinic DB.
  Medical images currently use URLs/data stored in that DB, no replica-local
  upload filesystem. Public proxy checks normalized paths remain public domain.
- RabbitMQ test healthcheck checks the Rabbit application, not only a live BEAM
  node. A restart previously reported healthy before AMQP/queue CLI was usable;
  keep the same hostname/volume and wait for real ready+unacked counters. Preserve
  the prior nonempty failure queue without consuming/purging/ACKing it.
- Dependency remediation uses exact overrides and a local build-only braces
  recursion guard because the advisory had no published upstream fixed release.
  Require actual Tailwind/chokidar/micromatch consumers to resolve the guarded
  package, preserve normal glob/range behavior and compare compiled CSS hashes.
  npm audit=0 describes the installed tree, not independent security certification.
- P6 real UI proof now uses strict credentials/Redis, one Core across normal
  cases; remove P5's per-case process restart. Restart remains only an explicit
  fault capability; Redis counters survive it. Run builds/proofs sequentially on
  Windows to avoid regenerating an in-use Prisma DLL.
- Notification HTTP correlation is persisted in outbox and logged at confirmed
  publish/committed effect/ACK with event IDs only, never payloads. Billing logs
  bridge request→operation, terminal events keep operation correlation across
  recovery. Directory SQL trigger correlation remains separate; no new migration
  only for tracing in P6. Non-UUID event metadata is redacted from transport logs.
- Record child exit code/signal/expected shutdown and assert a clean owned-child
  exit even when it exited before teardown. Unexpected native process loss must
  fail the run; do not add per-case restart, quota resets or retries to conceal it.
  Windows native startup/process-loss causes remain unestablished after a passing
  standalone diagnostic; preserve both failed and passed runs for P7 machine/CI
  verification rather than claiming the harness change fixed a native crash.

## P7 — 12/10/2026

- Use a new monolith fixture on the current additive migration chain, three new
  service DBs and a new restore DB per UUID. No arbitrary/live URL. Runtime roles
  are not database/table owners; bootstrap owns DDL, so source revoke works.
  Core retains empty moved tables without runtime SELECT/DML and hotel-only history.
- Export every scalar field and verify SQL catalog/index/FK/migration checksums.
  Preserve IDs/revisions/time/decimals; transport SQL NULL separately from JSON null.
- Import is atomic per service with a snapshot-hash journal and common advisory
  cutover lock. Partial import resumes; target stays read-only until exact checks
  pass. Disable only Core directory triggers inside import and re-enable them.
- Historical clinical invoices receive snapshot/INVOICED reservation/terminal
  evidence without replaying payment. Preserve existing snapshot; reconstruct
  absent snapshot only with timestamps/history, otherwise require review.
- Missing notice cannot be classified from publishedAt. Require reviewed
  pending/deleted evidence, seed inbox for materialized/deleted event IDs, retain
  pending outbox. Directory seed/catch-up excludes credentials.
- Persist opened_at before any target write grant. Before open, revoke target
  writes before restoring source; after open, always forward-fix. No verified
  reverse migration. Source advisory lock serializes cutover commands while the
  opened_at transaction remains independently durable.
- Isolated dirty-source copy with hash/npm ci/build/tests verifies installation
  on the same host. It is not another machine, remote CI or a committed handoff.
  Preserve unexplained P6 Windows process-loss history; PASS does not prove a fix.

## Audit fixes ? 13/10/2026

- Root Compose remains a transitional local composition while Clinic cutover is
  separately authorized. Connect the existing Notification service, its own DB,
  broker and outbox/inbox workers; never revive Core Notification inserts.
- Refuse local startup over nonempty legacy inbox storage until a reviewed data
  reconciliation is available. Do not delete/archive source data automatically.
- Legacy domain tests measure transactional notification obligations in outbox.
  Archived inbox CRUD fixtures are explicit; delivery proof uses real workers.
- Core validates current account existence and role per authenticated request,
  after runtime admission. Fail closed on lookup errors; public auth/callbacks
  remain usable with a stale bearer. Independent Clinic/Notification reads retain
  bounded JWT verification; this is not global immediate token revocation.
- Details, test results and limits: [audit fixes](fixes-20261013.md).
