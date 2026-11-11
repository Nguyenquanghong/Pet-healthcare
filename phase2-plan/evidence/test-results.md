# Tests actually executed — 11–12/10/2026

| Command                                                         | Exit/result  | Scope/evidence                                                                                                                                              |
| --------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test` before P1                                            | 0, PASS      | Backend/frontend build; 81 unit tests, 0 skipped; architecture 74 source files; OpenAPI 65 operations                                                       |
| `npm run phase2:build` first runs                               | 1, corrected | New contracts needed explicit Node types/import with installed compiler; fixed without changing existing compiler version                                   |
| `npm run phase2:build`                                          | 0, PASS      | Contracts, backend and independently generated/built Clinic/Notification clients; generated clients copied to service build artifacts                       |
| `docker compose -f deploy/phase2/compose.test.yml up -d --wait` | 0, PASS      | Separate new project/volumes; PostgreSQL, RabbitMQ, Redis healthy                                                                                           |
| `npm run phase2:test:integration` first run                     | 1, FAIL      | P3005: bootstrap marker made default schema nonempty; hooks prevented test bodies. Corrected fixture URL to `schema=p1_proof`, retaining marker/volume/data |
| `npm run phase2:verify`                                         | 0, PASS      | Build + contract 1/1 + boundaries + real integration 7/7 at that checkpoint                                                                                 |
| `npm run phase2:test:integration` final proof                   | 0, PASS      | 8/8 tests, 0 skipped, ~8.2 s; controlled barrier test added after initial proof                                                                             |
| `npm run phase2:test:contracts` final                           | 0, PASS      | 2/2: runtime envelope validation/size/version and Swagger validation of reserved internal billing OpenAPI                                                   |
| `npm test` after P1 changes                                     | 0, PASS      | Backend/frontend build, 81/81 unit tests, 0 skipped; architecture 83 scanned files; unchanged public OpenAPI 65 operations                                  |
| `npm run build -w @nipopeto/clinic` after barrier hook change   | 0, PASS      | Latest Clinic code compiles and generated client bundled                                                                                                    |
| `npm run phase2:test:architecture` final                        | 0, PASS      | Service import/SQL checks, distinct outputs, negative fixtures                                                                                              |
| `node tools/phase2/verify-local.mjs`                            | 0, PASS      | 18 original uncommitted/untracked files match captured SHA256                                                                                               |
| `git diff --check`                                              | 0, PASS      | Existing CRLF conversion warnings only; no whitespace errors                                                                                                |

Eight real integration test bodies:

1. Six cross-database CONNECT attempts rejected by PostgreSQL, using every service role.
2. Clinic/Notification built Node processes start independently; readiness succeeds against their own migrated DB; only spawned processes stopped.
3. Concurrent examination/Spa appointment inserts for one slot: one success, one PostgreSQL unique violation.
4. Barriers hold real row locks and query `pg_stat_activity` for a competing lock wait. Exercise prepare winner, undo winner, commit winner, abort winner; conflicting/late terminal action cannot violate state.
5. Twelve additional concurrent prepare/undo and commit/abort trials, with alternating commit/abort submission order.
6. Concurrent idempotent begin returns one operation; changed payload rejected; late prepare after durable abort cannot commit; pending leaves HELD blocking undo; verified abort releases.
7. Fault after invoice+outbox before transaction return rolls back invoice/state; retry returns same committed invoice; delayed finalize HELD blocks undo; release after INVOICED rejected.
8. Persistent broker message with confirms; injected failure after confirm before marking causes duplicate publication; notification+inbox rollback fault; close channel after DB commit before ACK gives real redelivery; inbox dedup and deletion replay; mandatory unroutable publish remains pending.

Initial eight-test proof used relay/inbox modules with real broker ACK/redelivery.
The continuation below also tests the actual consumer retry/DLQ implementation and
three built worker processes. Fault callbacks remain in-process hooks, not proof
of host/process death at every instruction boundary.

Not run: legacy PostgreSQL integration suite, Playwright E2E, Redis limiter,
load benchmarks, remote CI. No legacy
API/fixture stack was set up or redirected to these proof databases. P2–P7 still
need full public use cases, authorization, migration and failure coverage.

Continuation P1 — 11/10/2026:

| Command                               | Result                    | Evidence                                                                                                                      |
| ------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `phase2:build`                        | exit 0                    | Contracts/messaging and all three service workspaces; generated clients bundled with built worker artifacts                   |
| `phase2:test:contracts`               | exit 0, 3/3               | Envelope errors; seven internal paths validate; directory whitelist/source-version/Core-producer checks                       |
| `phase2:test:architecture`            | exit 0                    | Service/SQL boundaries, all distinct clients; shared messaging cannot import persistence                                      |
| First expanded `phase2:verify`        | exit 1, 10/12 integration | Caught incorrect topic wildcard: `directory.*`/`billing.*` did not match versioned event routing keys; fixed to `#`           |
| Second expanded `phase2:verify`       | exit 1, 11/12 integration | Broker process health preceded actual AMQP handshake readiness; added bounded authenticated protocol wait after restart       |
| `phase2:test:integration` after fixes | exit 0, 12/12, 0 skipped  | ~23.7 seconds; real three-DB/broker tests including restart/catch-up                                                          |
| `npm test` continuation               | exit 0                    | Backend/frontend build, 81/81 unit tests, architecture 84 files, unchanged public OpenAPI 65 operations                       |
| Final `npm run phase2:verify`         | exit 0, PASS              | All workspace builds, 3/3 contract tests, boundary checks, 12/12 real integration tests, 0 skipped; integration ~25.4 seconds |

Added four integration bodies:

9. Topic routing, monotonic directory/tombstone projection, duplicate delivery,
   actual billing-event finalization and rollback of inbox on terminal conflict.
10. Real consumer with PostgreSQL rollback fault retries successfully; invalid
    schema bypasses business handler and enters DLQ; three transient failures
    exhaust to DLQ; explicit replay preserves eventId and produces one effect.
11. Consumer channel closed before replacement, after replacement confirm and
    after DB commit. Original delivery preserved; confirmed retry crash creates
    duplicate deliveries but one effect. Deleted DLQ target produces mandatory
    return and original remains unacknowledged until topology is restored.
12. Three built service workers route notifications from Core and Clinic, consume
    billing finalization, tolerate broker downtime, retain outbox, recover queued
    persistent messages after restart from existing volume and catch up. Logs
    checked for fixture credentials/connection strings; spawned processes stopped.

Nonempty failed-run queues/rows retained. Passing runs delete only their empty
synthetic queues/exchanges. No seed/reset/truncate/volume deletion or live data write.

P2 API/inbox checkpoint — 11/10/2026:

| Actual command                                                                        | Result                 | Evidence/limits                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phase2:build`                                                                        | exit 0                 | Contracts/messaging/backend/Clinic/Notification; Prisma clients generated, built artifacts copied                                                                                                                                                              |
| `phase2:test:contracts` final                                                         | exit 0, 5/5, no skip   | New owner/admin/full-metadata payload and five-path Notification OpenAPI validate; existing envelope/directory/internal specs retained                                                                                                                         |
| `phase2:test:notification` first                                                      | exit 1, 4/5            | Test chose the migrated read=true fixture instead of the sent isolation fixture. Migration preservation assertions succeeded. Fixed test query to select status=sent                                                                                           |
| `phase2:test:notification` final                                                      | exit 0, 5/5, no skip   | ~3.7 seconds; real PostgreSQL/broker, HTTP CRUD/list/counts and RSA JWT verification, including owner/admin/doctor mutation scope                                                                                                                              |
| `phase2:test:integration` first P2 regression                                         | exit 1                 | 11 proof bodies passed; worker restart failed queue declaration 404 after container recreate changed RabbitMQ node name. Cleanup then failed on closed channel and retained an open connection; hung child stopped only after command-line/parent verification |
| `phase2:test:integration` after fix                                                   | exit 0, 12/12, no skip | ~24.7 seconds; stable broker hostname before/after restart; durable backlog loaded from retained volume; three built workers catch up                                                                                                                          |
| `test:unit -w backend`                                                                | exit 0, 81/81          | Legacy unit regression; no claim of legacy DB integration                                                                                                                                                                                                      |
| `test:architecture -w backend`, `test:openapi -w backend`, `phase2:test:architecture` | all exit 0             | 84 legacy source files; 65 main public operations unchanged; phase2 import/SQL/client boundaries                                                                                                                                                               |
| `node tools/phase2/verify-local.mjs`                                                  | exit 0                 | 18 original file SHA256 values unchanged                                                                                                                                                                                                                       |

Sandbox attempts failed before tests: offline npm metadata was not cached;
Prisma engine fetch blocked by sandbox network; Node test child spawn EPERM.
Normal elevated dependency/build/test calls subsequently succeeded. Automatic
review initially rejected stopping a PID with insufficient visible identity.
Full command line and parent chain proved it was the hung proof child; guarded
stop was then approved. No unrelated Node process was stopped.

P2 test bodies:

1. Full payload fields/timestamps survive broker delivery; injected transaction
   fault rolls back inbox/effect; HTTP delete plus same-event broker replay cannot
   resurrect the notification.
2. 23-row deterministic page order, filters/status/category counts, related DTO,
   strict query bounds, caller ownerId ignored and owner/staff rows isolated.
3. Owner/staff read/read-all/delete guards; repeated read succeeds; missing/delete
   returns 404; authoritative unread/asOf. Staff admin inbox mutations cannot alter
   an owner's rows, and owner cannot mutate the admin inbox.
4. Missing token, wrong key/issuer/audience/role, expired/no-exp and HS256 rejected;
   ephemeral fixture private keys stay in the test process.
5. Unavailable DB produces 503 without a false unread zero or raw sensitive error;
   unconfigured protected API fails closed. This failure test injects a failing DB
   port; the normal CRUD/inbox tests use real PostgreSQL.

`phase2:verify` and CI now include both suites; the updated aggregate wrapper was
not rerun because each constituent build/check/suite was run separately above.
Remote CI, frontend/E2E, legacy data import, manual send, request dedup and domain
producer outage behavior remain unverified. P2 is IN_PROGRESS, not DONE.

Dependency audit: `npm audit --json` processed with PowerShell on 11/10/2026
reported critical entries for proxy-addr and shell-quote (and concurrently via
shell-quote). Advisory URLs: https://github.com/advisories/GHSA-jqcg-44mw-7w3h
and https://github.com/advisories/GHSA-pqg4-j6r4-53mv. No automatic audit fix was
run. This is dependency metadata, not proof of exploitability in this runtime;
review/patch and regression belong before service deployment. Initial Node -e
summary command failed because of PowerShell quote parsing; the native
PowerShell JSON conversion succeeded. Notification's direct JWT dependency is
the already-installed jsonwebtoken 9.0.3; no new JWT advisory was reported.

Dedicated compose stopped after final test passes; named volumes and synthetic
rows retained. Final original-file verification still passed all 18 SHA256s.

## P2 final continuation — 11/10/2026

User removed the credit limit; continued sequentially without agents. Earlier
IN_PROGRESS/missing-feature statements above are historical checkpoints.

| Actual command/run                | Outcome                              | Evidence/limits                                                                                                                                                              |
| --------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase2:up                         | exit 0, three healthy containers     | Existing isolated project/volumes resumed after hidden Docker Desktop launch                                                                                                 |
| Initial expanded build            | FAIL, then PASS after fixes          | Added BusinessError 503; replaced incompatible proof/runtime Prisma delegate cast with local OutboxStore adapters; corrected Notification route declaration/middleware order |
| First runtime suite               | 6/8                                  | Fixtures used wrong owner login URL and reportTransfer argument order; corrected without reducing assertions                                                                 |
| Second runtime suite              | 7/8                                  | Synthetic PaymentAttempt lacked required id; corrected fixture                                                                                                               |
| Runtime suite after fixture fixes | exit 0, 8/8, 0 skip                  | ~21.8s, real PG/broker/Core/Notification, second built Notification process                                                                                                  |
| Default sandbox contract attempt  | failed before execution, spawn EPERM | Re-ran normally outside sandbox in aggregate wrapper, 5/5 passed                                                                                                             |
| First npm test                    | exit 1, build PASS, 80/81 unit       | Legacy HTTP fake expected Core notification insert/send 201; updated fake to outbox and fail-closed local manual fallback; real send 201 remains covered by runtime suite    |
| First unit retest                 | 80/81                                | Found missing JSON error schema for new public send 503 response; added public Error schemas and input limits                                                                |
| Final npm test                    | exit 0, 81/81, 0 skip                | Backend/frontend/packages build, architecture 88 files, public OpenAPI 66 operations; ~3.7s unit                                                                             |
| phase2:verify aggregate           | exit 0                               | All workspace builds; contracts 5/5; boundaries/writer audit; P1 12/12 (~25.2s); API/inbox 5/5 (~4.9s); runtime 8/8 (~25.0s); no skips                                       |
| Expanded runtime final            | exit 0, 8/8, 0 skip                  | ~24.5s, adds real lost HTTP body after commit + hotel/cash during broker outage and catch-up                                                                                 |
| First notification-ui             | failed before test bodies            | Missing Playwright Chromium executable; installed headless shell with browser GC disabled                                                                                    |
| notification-ui final             | exit 0, 3/3                          | ~7.6s, built React in Chromium; lost-response key retry, new intent/in-flight guard, saved/refresh-failed distinction, authoritative/unknown unread; every API intercepted   |
| verify-local, git diff --check    | exit 0                               | 18 original SHA256 values preserved; only Git LF/CRLF informational warnings                                                                                                 |

Runtime coverage: Core login issues valid Notification RS256 tokens; all four roles;
private service+actor auth and minimal response; two Notification processes,
concurrent request dedup/hash/actor scope, deletion replay; real response body
discarded after server commit and retry resolves original durable ID. New send
checks Core current role/recipient; outage fails closed, existing cached response
available. Injected send transaction fault rolls back effect/dedup. Actual Core
HTTP Spa/lifecycle/medical/hotel/rescue/invoice plus synthetic payment repository
paths emit outbox only, never internalNote. Actual OutboxEvent CHECK failure
rolls back public domain create and returns safe 503.

Migration tests: old sent/read fixtures with backdated timestamps export, dry-run,
import fault/rollback/resume, exact field comparison, no read regression/deletion
resurrection, checksum/collision rejection. Actual CLI runs all four commands on
retained fixture source dataset; artifacts stay under ignored test-results/phase2.

Broker test: stop only guarded test RabbitMQ; public appointment/hotel/cash payment
still commit plus pending outbox; manual send commits independently of broker.
Restart same volume/hostname; built Core runtime relay fills durable queue before
consumer starts, then built Notification consumer and Clinic own adapter catch up
all fixture events. Worker logs contain no fixture credentials/connection URLs.
Payment confirm/review uses synthetic repository inputs; no real gateway call.

No skipped test counted as PASS. Not run: remote CI, legacy full mutating DB
integration/default E2E, full real multi-service browser journey, Redis limiter or
auth surge, HA/host loss, production migration/backup restore, load benchmarks.
Dependency audit advisories remain for targeted P6 work before deployment.
Dedicated infrastructure stopped at checkpoint, retaining synthetic rows/volumes.

## P3 Clinic — 11/10/2026

User requested P3. Continued sequentially in the same dirty main/add596e working
tree, without agents/commit/push/merge or live database writes. All SQL-writing
tests used the guarded pet-phase2-p1-test project, per-service DB/user/marker and
explicit test URLs; no default legacy integration/E2E suite was authorized.
See [P3 evidence](p3-clinic.md), [API/transaction inventory](p3-api-and-transaction-inventory.md)
and [runtime runbook](../../deploy/phase2/clinic-runtime.md).

| Actual command/run                                           | Outcome                      | Evidence/limits                                                                                                                                                                                 |
| ------------------------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase2:up and guarded migration deploy                       | exit 0                       | Existing test volumes resumed; additive Core 006 / Clinic 007 applied only to their test schemas, no reset                                                                                      |
| Initial Clinic setup/build                                   | FAIL, then corrected         | Fixture missing required Core passwordHash/passwordSalt; appointment-only lifecycle port removed leftover hotel branches; assertions retained                                                   |
| Initial default sandbox test attempt                         | failed before test bodies    | Node child spawn EPERM; approved normal test invocation outside sandbox subsequently ran actual suites                                                                                          |
| phase2:test:clinic after fixes                               | exit 0, 7/7, 0 skip          | Real PostgreSQL/RabbitMQ/Core HTTP; two separate built Clinic processes; built Clinic and Notification workers                                                                                  |
| First extended UI run                                        | FAIL, then corrected         | Medical form feedback selector exposed missing accessible form error; added role=alert and verified retry/saved warning                                                                         |
| phase2:test:notification-ui final                            | exit 0, 6/6                  | ~9.3s, Chromium built React; 3 Clinic + 3 Notification, all API requests intercepted                                                                                                            |
| npm test                                                     | exit 0, 81/81 unit, 0 skip   | Backend/frontend build, backend architecture 90 files, public OpenAPI 66 operations                                                                                                             |
| Additional P1 regression                                     | 11/12, then fixed            | Concurrent Core begin same key could hit active-source unique index despite actor/key conflict target; use all unique arbiters and resolve durable actor/key row                                |
| P1 retest with new SQL barrier                               | exit 0, 12/12                | Two INSERT statements observed in PostgreSQL Lock wait before barrier released; same actor/key returns same operation, different key on active source returns SOURCE_BUSY                       |
| phase2:verify aggregate after race fix                       | exit 0                       | All workspace builds; contracts 6/6; boundaries/writer audit; P1 12/12 (~25.0s), P2 API 5/5, runtime 8/8 (~27.0s), P3 7/7 (~22.9s); 32 integration groups, no skips                             |
| Supplemental builds/contracts/unit/OpenAPI                   | exit 0                       | After public directoryVersion and inbox duplicate/Core-outage checks: phase2 build, contracts 6/6, backend unit 81/81 and OpenAPI 66 operations; frontend build also passed after UI change     |
| Supplemental Clinic fixture run                              | FAIL, then fixture corrected | Public pet PATCH correctly rejected >200-character name with 422; use valid public PATCH/assert version, then explicit test DB legacy long-name fixture; keep API validation unchanged          |
| Final npm run build -w @nipopeto/clinic + phase2:test:clinic | exit 0, 7/7, 0 skip          | ~23.2s; public directoryVersion, source deletion tombstone, full legacy-name search, bodyless/array validation, downgraded-actor cached replay and committed inbox duplicate during Core outage |
| phase2:test:architecture final                               | exit 0                       | Import/SQL boundaries, distinct generated clients and negative fixtures PASS                                                                                                                    |
| verify-local and git diff --check final                      | exit 0                       | All 18 original SHA256 values preserved; no whitespace error; LF/CRLF informational warnings only                                                                                               |
| Guarded dedicated compose stop + ps -a                       | exit 0                       | Identity check before stopping exactly three project containers; PostgreSQL/RabbitMQ/Redis Exited (0), all volumes and synthetic rows retained                                                  |

The final supplemental changes were verified by their affected builds/contracts/
unit/OpenAPI/Clinic suite; the full wrapper was not rerun after those narrow
changes. Do not present an unexecuted wrapper as a new PASS.

Clinic groups cover concurrent canonical create/idempotency through two processes,
lost HTTP response body after commit, owner/key scope; exam/Spa partial slot unique,
status revision/history/undo/reschedule/cancel; real SQL lock waiter for HELD versus
undo and linked medical create; INVOICED medical edit/delete guard. Linked record,
completion, history, notification outbox and request dedup roll back together on an
actual outbox SQL CHECK fault, and commit once on concurrent replay. Date/hash,
invalid vitals/link and immutable appointment association are checked.

Reads/writes cover owner/staff scope, internalNote redaction, filter/count/page/
related, images and history, Core clinical rows untouched by split writes, private
bootstrap clinical regions/totals and appointment invoice fail-closed 503. Missing/
invalid JWT and current role withdrawal fail closed; a new owner token cannot
replay a cached staff medical response. Core outage rejects new protected work
without partial dedup; already-committed inbox duplicate ACKs without a Core call.

Directory uses real Core transactional revisions/events and private HTTP snapshot,
queue-before-export plus concurrent page update; search lag is observable then
catch-up restores full long historical name/breed/email/microchip search. Old
versions/tombstones cannot regress or revive; an old queued upsert after actual
source delete resolves to durable source tombstone. Forged projection ownership
never grants permission. Public Core DTO directoryVersion was asserted via a valid
PATCH; historical long values were inserted only in the guarded test database.

Broker outage stops only the dedicated test RabbitMQ. Clinic appointment/reminder
commit with pending outbox; broker recovery and built workers deliver a single
Notification per event, durable replay remains deduped. Worker logs were checked
for fixture credentials/URLs. No real payment, mail or external notification sent.

Not run: remote CI, default legacy mutating integration/E2E, full real browser
journey across backends, full historical clinical import/reservation backfill,
backup restore/live cutover, billing HTTP/reconciler/crash matrix (P4), Redis
limiter/auth surge/HA/load or benchmarks. UI 6/6 is mocked-API browser coverage,
not real multi-service E2E. Dependency advisories recorded in P2 remain P6 work;
offline lock metadata success is not a new online advisory verification. H is not
achieved. P3 is DONE only for its delivery-plan acceptance on the isolated stack.

## P4 billing — 11/10/2026

Sequential implementation after P3; no agents/commit/push/merge/live DB writes.
Runtime now uses actual Core invoice/operation and Clinic appointment/reservation,
not P1 proof tables. [P4 evidence](p4-billing.md),
[runbook](../../deploy/phase2/billing-runtime.md). All DB-writing suites guard exact
test project, service DB/user/marker before additive 008/009 migration deploy.

| Actual command/run                              | Outcome                           | Evidence/limits                                                                                                                                                                                                                                    |
| ----------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase2:up                                       | exit 0, three healthy containers  | Existing isolated project recreated on retained volumes/hostname; no reset or live stack change                                                                                                                                                    |
| Initial phase2:build                            | FAIL, then PASS                   | TypeScript needed a narrowed terminal state outside the transaction closure                                                                                                                                                                        |
| Initial frontend build                          | FAIL, then PASS                   | Use ES target-compatible string replacement and ApiError.httpStatus; no target/dependency downgrade                                                                                                                                                |
| First phase2:test:billing                       | 7/8, then fixture fixed           | Undo-winning history fixture used status_changed rather than baseline transition; correct fixture, preserve lock-wait/winner assertions                                                                                                            |
| Expanded phase2:test:billing                    | exit 0, 10/10, 0 skip             | ~29.5s; two built Core + two Clinic, both SQL race orders, kill actual Core after HELD, lost prepare and committed invoice responses, real outbox constraint fault                                                                                 |
| Initial P4 Chromium                             | 7/9                               | Two staff selectors matched pagination and source comboboxes; narrow to source's accessible label                                                                                                                                                  |
| Chromium after selector fix                     | exit 0, 9/9                       | ~19.1s; later frontend build + 9/9 (~18.3s) after pending close-label clarification; all APIs intercepted                                                                                                                                          |
| Contracts/unit/OpenAPI                          | exit 0                            | 7/7 contracts, backend unit 81/81, public 67 operations; schema/source inventory and JSON errors validate                                                                                                                                          |
| First expanded phase2:verify                    | exit 0                            | Full workspace builds, contracts 7/7, boundaries/writer audit, P1 12/12, P2 API 5/5, runtime 8/8 (~31.1s), P3 7/7 (~23.7s), P4 10/10 (~27.3s); 42 groups, no skip                                                                                  |
| Further phase2 build + billing                  | exit 0, 12/12                     | ~36.2s; revision int bounds, dead lease reclaim, Core timeout/404 retains HELD, delayed prepare after abort, deadline under SQL wait, old financial rows, bank report/pay and synthetic IPN duplicates, invoice notice through broker/Notification |
| npm test before aggregate regression            | exit 0                            | Backend/frontend builds, 81/81 unit, architecture 93 files, public OpenAPI 67 operations                                                                                                                                                           |
| Following aggregate regression                  | FAIL at P2 runtime teardown       | Its 8 bodies passed but after-hook retained one Clinic queue. Final ready=0 had hidden an unacked directory event, killed before SQL/inbox commit; remaining suites were not run by that failed wrapper                                            |
| Read-only failure diagnosis                     | event retained/requeued unchanged | Dedicated queue p2.runtime.34ab904b-8e9e-49df-9231-fdc46808dd90.clinic; event 099a562f-1e5d-4be8-a9c8-73551dbeaa2e; inbox absent. No ACK/purge/delete of failure evidence                                                                          |
| P2 runtime after queue guard fix                | exit 0, 8/8, 0 skip               | ~26.9s; broker ready AND unacknowledged counters must be zero before consumer termination; original empty-queue assertion remains                                                                                                                  |
| P4 after queue guard fix                        | exit 0, 12/12, 0 skip             | ~36.6s; finalize and notice replay await actual broker ACK/drain, not a sleep-only check                                                                                                                                                           |
| Final architecture/OpenAPI/original-file checks | exit 0                            | 93 source files; 67 operations; all 18 original SHA256 values match; git diff --check has only LF/CRLF informational warnings                                                                                                                      |

Final `npm run phase2:verify` after the queue guard and strict private-body
validation completed with **exit 0**. Workspace builds, contracts 7/7, boundaries
and writer audit pass; P1 12/12 (~25.8s), P2 API 5/5 (~3.6s), P2 runtime 8/8
(~30.8s), P3 7/7 (~27.6s), P4 12/12 (~38.6s): **44 integration groups, 0 skip**.
Raw local output retained at ignored `test-results/phase2/p4-final-verify.log`.
Earlier transient terminal output was not used to infer this final result.
Final verify-local (18 hashes), git diff --check and documentation links pass;
HEAD remains main/add596e4488e3cac2584115874c2f65a97af7047. Dedicated project
identity was checked before stopping its three containers, all Exited (0);
volumes, synthetic rows and the retained failure queue/message remain.

P4 SQL barriers observe pg_stat_activity Lock waiters, including both sides of
prepare–undo and commit–abort on actual tables. Core body loss and after-HELD
process kill use real HTTP/built processes; restart reconcilers commit/finalize
the original operation once. Outbox CHECK fault proves invoice, notice and billing
event rollback; Core operation remains pending and Clinic HELD stays protected.
Core deadline returns 202/Location while a row lock holds commit, then releasing
it permits the original work to commit without another invoice.

Current role/source/actor/key guards cover owner isolation, staff role withdrawal,
key reuse with different canonical charges and multiple keys on the same source.
Fixed Spa prices and 9.999.999.999 VND are preserved. Release body cannot assert
terminal state; Core timeout/404/PREPARING never releases HELD. Abort tombstone,
late prepare and reversed terminal event/inbox rollback are covered. Worker lease
reclaim is real SQL; two separate built reconcilers share durable state.

Historical synthetic invoice reads preserve IDs/items/issuedAt/paidAt/amount/status
without a clinical FK. Transfer report/pay and IPN confirmation retries use actual
Core repositories/HTTP with synthetic inputs; no bank/gateway/external mail call.
Broker outage still commits invoice/outbox; Clinic finalizes and Notification
receives one invoice_requested after recovery and unchanged-event replay.

UI 9/9 is built React/Chromium with all APIs intercepted, covering persisted
pending across reload, fee freeze, poll without new POST/key, uncertain response
retry with same body, definitive abort/new intent and saved/refresh-failed feedback.
No full real browser journey/remote CI claimed. Historical snapshot/reservation
backfill, whole-model import, backup restore/live cutover, auth surge/Redis limiter,
HA/load and benchmarks remain P5–P8. P2 dependency advisories remain P6 work.

## P5 frontend/bootstrap — 11/10/2026

Sequential implementation after P4, on the same guarded dedicated project;
no agents/commit/push/merge/live DB writes/reset/seed. PostgreSQL, broker and
service processes are real for the new browser suite. No new P5 migration.
[Implementation](p5-frontend.md), [API/transactions](p5-api-and-transaction-inventory.md),
[runbook](../../deploy/phase2/frontend-runtime.md).

| Actual command/run                | Outcome                               | Evidence/limits                                                                                                                                                                                                                                           |
| --------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase2:up                         | exit 0, three healthy test containers | Docker Desktop started hidden; retained DB/broker volumes, no live stack change                                                                                                                                                                           |
| Initial frontend build            | FAIL, then PASS                       | Removed callers of obsolete global cached arrays/refresh signature; no framework/target downgrade                                                                                                                                                         |
| Initial sandbox contract test     | spawn EPERM, not a PASS               | Reran with process execution approval; final contracts 8/8                                                                                                                                                                                                |
| P4 UI baseline attempts           | FAIL, then 1/1 PASS (~27.6s)          | Correct baked localhost URL for own proxy, selector and authenticated baseline warm-up; preserved hashes and actual capture                                                                                                                               |
| Initial journey suite             | 4/8, then expanded suite 6/17         | Selectors/fixture status and actual auth 429 errors recorded; API helper token cache plus fresh owned Core per browser case avoids accumulating the legacy quota, without changing production auth policy                                                 |
| Following expanded suite          | 13/17                                 | Fixed confirmed-dialog/financial guard selectors and fixture payloads; inline medical creation missing Idempotency-Key was an application bug, now fixed and tested after actual commit/body loss                                                         |
| First aggregate E2E               | 15/17; wrapper FAIL                   | 44 integration groups and contracts 8/8 had passed; one Windows worker native exit 3221226505 (cause not established), one retained-data medical row hidden by earlier future fixtures; select the test pet instead of assuming first page order          |
| Mock UI regression                | 8/9, then 9/9                         | Fault fixture targeted obsolete bootstrap/list reads; changed it to the actual mounted scoped reads/unread query, keeping saved/error assertions                                                                                                          |
| Second aggregate E2E              | 15/17; wrapper FAIL                   | Clock installation after timer did not exercise unread poll; install before login. Atomic control-file rename hit transient Windows EPERM sharing lock; bounded retry handles it without deleting original control file                                   |
| Standalone real E2E after fixes   | exit 0, 17/17 (~1.9m)                 | Old list and selected-detail response isolation, failed-new-login token clearing, real 202 completion and notification polling fault assertions all retained                                                                                              |
| Final npm test                    | exit 0                                | Backend/frontend builds, 81/81 unit (0 skip, ~3.95s), architecture 94 source files including negative fixture, public OpenAPI 69 operations                                                                                                               |
| Final phase2:test:notification-ui | exit 0, 9/9 (~19s)                    | Built React/Chromium; APIs intercepted, separate evidence from real E2E                                                                                                                                                                                   |
| Final phase2:verify               | exit 0                                | Workspace builds, contracts 8/8, boundaries/writer audit; P1 12/12 (~25.2s), P2 API 5/5 (~3.3s), runtime 8/8 (~30.5s), P3 7/7 (~27.1s), P4 12/12 (~36.5s): 44 integration groups, 0 skip; then 18/18 real E2E (~2m) and successful queue/process teardown |
| Final original-file/Git checks    | exit 0                                | All 18 original SHA256 hashes match, main/add596e4488e3cac2584115874c2f65a97af7047 unchanged; git diff --check passes with LF/CRLF informational warnings only                                                                                            |
| Guarded test stack stop           | exit 0, three Exited (0)              | Original retained P4 failure queue read-only ready=1/unacked=0 before stop; no ACK/purge/delete/down-v, DB/volumes/rows preserved                                                                                                                         |

Final raw local outputs are ignored artifacts:
`test-results/phase2/p5-final-verify.log`, `p5-npm-test.log`,
`p5-ui-regression.log`. Earlier aggregate failures remain in
`p5-aggregate-failed.log` and `p5-aggregate-failed-2.log`; no retry/skip policy
converts them to PASS. Final aggregate includes the added registration validation/
success-feedback regression, so 18 is the final suite count, not the earlier 17.

Browser proof covers registration, exam/record/redaction, Spa/reserved billing/cash,
hotel care/financial guard, activation preserving owner/history, rescue and actual
outbox/inbox delivery, page-two selection/debounce/delete-clamp and Vietnam dates.
Fault cases stop only the runner's Notification API; abort region/auth/read
transport or lose a real committed response body; hold actual old list/detail
responses across identity change; pause only the run's directory relay; apply
a finally-cleaned SQL CHECK scoped to one fixture appointment to force 202 and
observe same-operation completion without another POST/invoice. Authorization,
business/financial transaction responses are actual service/SQL results.

[Before](p5-network-before.json) and [after](p5-network-after.json) preserve only
method/path/status. Across the same two hard-navigation flows and 12 seconds per
region after initial network idle: 8 → 7 calls, background 3 → 0, bootstrap 4 → 0.
Dashboard initial rises 2 → 4 with independent regions; appointments total falls
5 → 3. Unread's 20s poll is outside this measurement; this is not a load/latency
benchmark. The retained P4 build was observed locally, not rebuilt by clean CI.

Remote CI, external payment/mail, shared limiter/same-IP/hash admission,
Redis/replica proxy/HA/security/metrics/resource budget, historical backfill,
backup restore/live cutover/rollback and benchmark remain P6–P8. P5 DONE does
not mean H achieved or any live service/data traffic transferred.

## P6 — Auth/resilience/scale, 11–12/10/2026

All writing suites used guarded exact3 pet-phase2-p1-test, each own DB/role/marker;
no live DB/traffic, seed/reset/volume delete, commit/push/merge.
Detailed proof and policy: [P6 evidence](p6-auth-resilience.md),
[inventory](p6-api-and-runtime-inventory.md),
[runbook](../../deploy/phase2/resilience-runtime.md).

| Command/run                                                | Actual result                       | Finding/validation                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial runtime/workspace build                            | FAIL then exit 0                    | traceHeaders typing and owned OpenAPI path corrected                                                                                                                                                                                                                                                                                    |
| p6-first-proof.log                                         | setup FAIL, 0 body tests            | Missing Nginx temp prefix directory, corrected                                                                                                                                                                                                                                                                                          |
| p6-proof-2.log                                             | 7/10 + teardown FAIL                | Prisma time field, notification aggregate scope, broker ping health too early; check_running preserves hostname/volume                                                                                                                                                                                                                  |
| p6-proof-3.log                                             | 12/13, exit 1                       | Fixture payload uses relatedAppointmentId; fixed exact scope                                                                                                                                                                                                                                                                            |
| p6-proof-4.log                                             | 18/18, exit 0, 0 skip (~70.75s)     | Two Core/two Clinic + real Nginx, Redis/broker/replica faults, auth/history/metrics, real SQL deadline/API+worker drain                                                                                                                                                                                                                 |
| First concurrent npm test                                  | FAIL                                | Orchestration regenerated Windows Prisma DLL while proof used it; subsequent builds/tests sequential                                                                                                                                                                                                                                    |
| p6-npm-test-final.log                                      | exit 0                              | 81 unit, 4 runtime, 2 dependency; architecture 96 files, OpenAPI 69 operations; frontend/backend build                                                                                                                                                                                                                                  |
| First aggregate                                            | FAIL at E2E startup                 | 62 integration groups + runtime/dependency passed, then native Windows exit 3221226505 before browser results; cause not established                                                                                                                                                                                                    |
| p6-e2e-first.log                                           | 17/18, exit 1                       | Valid bootstrap token rejected by billing middleware covering all /internal; fixed billing namespace and added positive credential checks                                                                                                                                                                                               |
| First isolated outage E2E                                  | FAIL                                | Fixture assumed owner notice from previous tests; now confirms appointment via real API to produce its own notice                                                                                                                                                                                                                       |
| p6-e2e-scope-final.log                                     | 1/1, exit 0 (~8.1s)                 | Notification outage keeps session/write/Clinic bootstrap available with distinct token                                                                                                                                                                                                                                                  |
| Second aggregate                                           | FAIL, P6 17/18                      | New fixture used partial-unique appointmentId as Prisma findUnique selector; corrected query, kept reservation check                                                                                                                                                                                                                    |
| Third aggregate                                            | FAIL, P6 17/18                      | Fixture waited for finalize without Core relay/reconciler; now starts built worker scoped to its operation, checks public status contract                                                                                                                                                                                               |
| p6-proof-final.log                                         | 18/18, exit 0 (~73.32s), 0 skip     | Trace through actual outbox/confirm/inbox, terminal evidence via scoped built billing worker, startup/health/deadline/bounded admission and drain                                                                                                                                                                                       |
| Fourth aggregate, p6-final-verify-4.log                    | exit 1; integration 62/62, E2E 3/18 | Core ceased accepting TCP during browser suite; old harness did not record child exit code. Cause not established; not counted as PASS                                                                                                                                                                                                  |
| p6-e2e-exit-diagnostic.log                                 | 18/18, exit 0 (~1.7m)               | Runner now records child exit code/signal/expected shutdown and asserts zero even if child already exited. All six owned child lifetimes exited 0 as expected; no automatic restart between cases                                                                                                                                       |
| p6-npm-test-complete.log                                   | exit 1 before tests                 | Sandbox network denied Prisma engine checksum fetch; not a code/test PASS                                                                                                                                                                                                                                                               |
| p6-npm-test-complete-network.log                           | exit 0                              | Source-final backend/frontend build; 81 unit + 4 runtime + 2 dependency, 0 skip; architecture 96 files, OpenAPI 69 operations                                                                                                                                                                                                           |
| p6-ui-final.log                                            | 9/9, exit 0 (~19.3s)                | Chromium intercept suite; distinct from actual PostgreSQL/broker E2E                                                                                                                                                                                                                                                                    |
| Nginx preparation + example -t                             | exit 0                              | Official pinned Windows 1.30.5 archive/hash; example syntax verified with own logs/temp prefix                                                                                                                                                                                                                                          |
| Dependency/CSS checks                                      | PASS                                | Actual transitive braces guard + patched exact overrides; audit 11→0, compiled CSS SHA256 unchanged                                                                                                                                                                                                                                     |
| npm run phase2:verify, p6-verify-complete.log (12/10/2026) | exit 0                              | Source-final workspace builds, boundaries/writer audit; contracts 8/8; P1 12/12 (~33.40s), P2 API 5/5 (~4.96s), runtime 8/8 (~40.25s), P3 7/7 (~39.12s), P4 12/12 (~48.72s), P6 18/18 (~71.64s): 62 real integration groups, 0 skip; runtime 4/4, dependency 2/2; real E2E 18/18 (~1.7m), all six owned child lifetimes expected exit 0 |

Final aggregate and UI PASS are new source-final executions, not reclassification
of failed/partial runs. Earlier Windows native startup exit 3221226505 and Core
TCP/process loss still have unestablished causes. No retries/per-case restart,
quota reset, reduced hash cost, skipped assertion or automatic native-crash fix
claim. P7 must verify clean setup/machine/CI and retain this history.

Final read-only queue observation found two retained failure queues with one
ready and zero unacknowledged message each: p2.runtime.34ab904b…clinic and
p4.billing.9ce7ecfc…notification. No consume/ACK/purge/delete. Guarded Compose
stop exited 0; all exact3 containers Exited (0), volumes/database/rows retained.
Owned test processes exited; two pre-existing Node processes remain untouched.
Final verify-local: all 18 original SHA256 checks PASS; main/HEAD unchanged.
git diff --check exit 0; 92 local documentation links resolve. P6 final evidence
contains no stale pending markers. No remote CI/clean npm ci was run at P6.

## P7 — 12/10/2026

| Execution / raw log under ignored test-results/phase2     | Actual result                   | Meaning                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase2:up, p7-startup.log                                 | exit 0, exact3 healthy          | Same dedicated volumes; new per-run P7 databases/roles only                                                                                                                                                                                                                                                                                    |
| p7-first-proof.log                                        | exit 1, before-hook FAIL        | Synthetic PaymentAttempt used success instead of CHECK-allowed succeeded; test bodies not counted as executed                                                                                                                                                                                                                                  |
| p7-second-proof.log                                       | exit 1, before-hook FAIL        | Legacy harness blanked RSA keys but inherited issuer/audience, login 500; fixed explicit legacy profile, no production auth fallback                                                                                                                                                                                                           |
| p7-third-proof.log                                        | 3/10, exit 1                    | GET /pets/:id fixture route nonexistent; Prisma cannot deserialize advisory-lock void column; changed to list API and ::text, dependent failures retained                                                                                                                                                                                      |
| p7-fourth-proof.log                                       | 9/10, exit 1 (~63.42s)          | Fixture used limit instead of pageSize; import/restore/cutover/new journey/replay/forward-fix passed; corrected query parameter                                                                                                                                                                                                                |
| p7-fifth-proof.log                                        | 11/11, exit 0 (~73.02s), 0 skip | Added actual SQL barrier for concurrent pause/forward-fix; 17 owned API/worker lifetimes expected exit 0                                                                                                                                                                                                                                       |
| phase2:verify:clean-local, p7-clean-local.log             | exit 0                          | Copy 509 dirty source files, hash 4e41e6a…; npm ci, npm test (81 unit + 4 runtime + 2 dependency), phase2:build and P7 11/11 (~75.21s) all exit 0                                                                                                                                                                                              |
| npm test, p7-npm-test-final.log                           | exit 0                          | Backend/frontend build, 81 unit + 4 runtime + 2 dependency, 0 skip; architecture 96 source files/OpenAPI 69 operations                                                                                                                                                                                                                         |
| phase2:verify, p7-verify-final.log                        | exit 0                          | Final workspace builds, contracts 8/8, boundaries/writer audit; P1 12/12 (~32.69s), P2 API 5/5 (~4.79s), runtime 8/8 (~53.32s), P3 7/7 (~55.60s), P4 12/12 (~46.38s), P6 18/18 (~70.28s), P7 11/11 (~72.73s): 73 integration groups, 0 skip; runtime 4/4 + dependency 2/2; actual Chromium E2E 18/18 (~1.7m), all owned child exits expected 0 |
| phase2:test:migration, p7-cli-guard-final.log             | exit 0, 11/11 (~74.93s), 0 skip | Final CLI positive read-only-target before open and negative after open; no ledger/grant bypass. 17 owned runtime lifetimes expected exit 0                                                                                                                                                                                                    |
| node tools/phase2/p7-evidence.mjs with last run artifacts | exit 0                          | Sanitized 18-model/234-field manifest + reconciliation; source/target exact before open, real restore and retained new writes recorded                                                                                                                                                                                                         |

Aggregate completed before the final read-only-target CLI guard refinement; the
last targeted P7 run verifies that change. The isolated copy captured source
before final report/catalog/CLI refinements; the aggregate and last proof verify
final code separately. No production business source/API or frontend change P7.
No tests run against backend/.env/default demo DB; no reset/seed/down-v, no external
payments/mail. Failed-run DBs/roles/rows/logs remain. Snapshots/context/backup stay
ignored because they contain protected fields/credentials; published JSON has
counts/hashes/schema/aggregate totals only.

Actual restore compares all 18 source tables and transfer sequence; two historical
clinical invoices get snapshots/INVOICED reservations. Source fixture has no old
P4 terminal operations, so this does not prove migration of all possible mixed
datasets. P4 terminal protocol is tested separately in the aggregate. After target
new writes, forward-fix keeps the new medical record and one 450,000 VND invoice;
old snapshot restore/reverse migration/target PITR not claimed.

Native Windows losses observed in P6 remain unexplained. No native loss repeated
in these P7 runs, no retry/skip/per-case restart/quota reset used to conceal them.
Fresh npm ci happened on the same host, not another machine/remote CI or independent
handoff. UI intercept suite was not rerun because P7 changes tools only; actual
18-test E2E did run anew. P8/load/HA/live cutover remain unverified.

Final checkpoint: published P7 reports pass the fixture-content/password privacy
check. Doc checker initially could not spawn rg inside the sandbox (EPERM); added
filesystem fallback, final exit 0 with 36 documents/156 local links. verify-local
still 18/18 hashes; main/HEAD unchanged; git diff --check exit 0 (CRLF warnings only).
Guarded stop script exited 0; all exact3 test containers Exited (0), DBs/roles/rows/
dumps/volumes retained. Both old failure queues still ready=1/unacked=0 before stop;
no consume/ACK/purge/delete. Owned APIs/workers all exited; original two Node
processes and three automation helper processes were identified and left alone.
No automatic approval rejection occurred; read-only CIM required escalation after
sandbox permission denial. Start test infrastructure with phase2:up next session.

## H package — 12/10/2026, đang kiểm source cuối

| Lượt chạy                   | Kết quả thực                                                            | Phạm vi                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WSL inventory               | Sandbox E_ACCESSDENIED; read-only escalation exit 0, chỉ docker-desktop | Không có application Linux distro, không cài WSL mới hoặc đổi Docker settings                                                                                                                   |
| Source guards first sandbox | exit 1 trước test bodies, spawn EPERM                                   | Không tính là test PASS; chạy cùng code với quyền spawn được cho phép                                                                                                                           |
| h-source-guards-first.log   | 6/6, exit 0 (~0.31s)                                                    | No Git/client dependency, hash mismatch, missing/tamper/traversal/private/extra paths, generated outputs, Git parent                                                                            |
| First package sandbox       | exit 1 trước stage                                                      | Git subprocess unavailable; nothing overwritten                                                                                                                                                 |
| h-package-first-network.log | exit 0, 503 files staged/hash/tar                                       | Intermediate package, not claimed fully verified                                                                                                                                                |
| h-package-candidate.log     | exit 0, 505 files/3,614,885 bytes                                       | source hash b0c9936b…; whole archive/manifest pinned, seven protected baseline files included, unrelated original files omitted from archive and preserved                                      |
| h-detached-candidate.log    | exit 1                                                                  | Temp extraction without .git, npm ci/test/build/browser/nginx PASS, contracts 8, source guard 6, P1–P7 73 groups PASS; real E2E 17/18, zero skip, all runtime exits expected 0; no native crash |

Candidate E2E failure: two /api/auth/me calls had no response status in the old
request-only recorder. HAR trace records response.\_failureText=net::ERR_ABORTED,
with a finished replacement 200 on each page; background counts remain zero.
Fixed recorder to include requestfinished/requestfailed. Network assertion allows
at most one initial canceled GET /auth/me per page and requires completed replacement
200; all other pending/failure/business requests remain rejected and budget counts
still include canceled calls. No frontend change, reduced idle duration, removed
assertion, quota reset, native retry or per-case restart. Failed package/clone/log
retained; exact3 stopped exit 0 and both old queues ready=1/unacked=0 preserved.

Targeted h-network-recorder-fixed.log exited 1 before browser tests: Clinic worker
PID 4800 exited 3221226505 unexpectedly before readiness, its log was empty.
This reoccurs the P6 native issue; it is not classified as a recorder regression
or a passing test. Read-only Windows Application event checks found no node.exe
report in the lookback, so subcode/stack and cause remain unknown. Original user
processes unchanged, no registry changes/dump/debugger installs. Microsoft documents
0xC0000409 as a [fail-fast exception](https://learn.microsoft.com/en-us/shows/inside/c0000409);
the status alone does not establish the app's underlying cause. No Windows/Node
upgrade or automatic retry used to claim a fix.

Second detached run h-detached-final.log, source hash 66396106… (507 files), exited
1: install/build/unit/73 integration groups passed; E2E 17/18 with the same network
test now reaching the unchanged request budget (9 attempts versus baseline 8).
Root cause was the new H runner setting NODE_ENV=test for Vite as well as backend,
which selected React development/extra session initialization. Removed that override
and forced production specifically in E2E frontend build, without removing StrictMode
or changing product code. Browser test now checks renderer bundleType=0.

h-network-production-fixed.log: targeted real E2E exit 0, 1/1 (~29.1s), zero skip,
five child lifetimes expected exit 0. Caller deliberately NODE_ENV=test; frontend
still production, completed request count 7 < baseline 8, zero background requests
in both 12-second phases. Original thresholds/duration/failed-business checks kept.
This proves the recorder/build fix, not a native Windows crash fix. A new archive
must pass full detached verification; earlier two failed hashes remain retained.

Full h-detached-production-final.log (source 8330475c…, 507 files): npm ci, npm test
81/81 unit + 4 runtime + 2 dependency + 6 source guards, build three services,
contracts 8/8, P1–P7 73/73 integration groups, actual E2E 18/18 (~1.7m), UI
intercept 9/9 (~19.3s), all commands exit 0/no skip/owned exits expected zero.
Final wrapper exited 1 because two docs links pointed to PATCH-NOTES.md omitted
by local \*.md exclusion. That report remains FAIL; source bytes verified unchanged
after the failed wrapper, and P7 snapshot provenance verified manifest/source hash.

Added !tools/vendor/braces/PATCH-NOTES.md and created final 508-file package
8f5bbfbd…/archive d9f30219…. h-doc-delta-final.log exit 0: fresh temp extraction,
archive/manifest/source hashes, all source bytes and new provenance checked;
source guards 6/6 (~0.25s), all local docs links resolve. Exact diff versus prior
functional package is only .gitignore and PATCH-NOTES.md; code/config/schema/lock
hashes all identical. Functional results belong to the prior exact-code execution,
not a invented new full execution. [Public report](h-source-package.json) records
both hashes, command exits/durations and doc-only validation. No DB tests repeated
after they passed because this last change only affected packaging documentation.

Final stack stop from full wrapper: exact3 Exited (0), volumes/DBs/roles/rows/dumps
retained, both original queues ready=1/unacked=0, no consume/ACK/purge/delete. Only
two prior user Node processes remain. Original18/main/HEAD unchanged. No remote CI,
independent receiver/machine, Linux run, live cutover or native crash fix claimed.
