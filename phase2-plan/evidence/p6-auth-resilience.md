# P6 — Auth, resilience, scale và quan sát

11–12/10/2026, main/add596e4488e3cac2584115874c2f65a97af7047, working tree dirty.
Triển khai tuần tự. 18 original SHA256 còn nguyên.
Không commit/push/merge, không sửa DB/traffic đang dùng hoặc seed/reset/down-v.

## Code và hành vi

- Shared runtime: Redis Lua/HMAC quota login riêng /me; bounded async PBKDF2
  admission giữ 210,000 iterations; 429/503/retry/degraded explicit. Redis outage
  fail closed write/auth, bounded per-process JWT reads. Không memory dedup.
- Core strict RS256/kid, Clinic/Notification public verify only; năm credential
  riêng cho directory, billing source, terminal evidence, bootstrap và manual
  send. Thiếu URL service ở Core target fail startup; tránh writer legacy bật lại.
  Internal actor checks vẫn fresh Core source, không dựa projection.
- Own DB/migration readiness, private Prometheus/correlation logs; bounded DB
  pools/upstream/HTTP deadline. Backlog soft/hard admission; timeout không khẳng
  định rollback. SIG/parent IPC graceful API/worker drain, no HTTP debug route.
- Notification request correlation đi qua outbox/publish/inbox; JSON eventId/
  correlationId/transport status không có payload. Billing result nối requestId
  với operationId, terminal event giữ operation correlation qua restart. Directory
  trigger vẫn dùng event correlation riêng, chưa có HTTP-to-trigger trace.
- Hai Core và hai Clinic process thật qua Nginx round-robin; SQL durable
  idempotency/slot unique, same-key retry sau replica kill. MedicalImage DB URLs
  đọc được từ replica khác. Redis/broker lỗi/recovery giữ đúng policy/outbox/inbox.
- Root scripts/CI dùng P6 proof thật. P5 browser suite chuyển strict runtime/
  Redis, bỏ fresh Core mỗi case. Legacy proof factories vẫn riêng để test tương
  thích; không dùng chúng làm cấu hình target. Không thêm service/framework.

Files chính: packages/runtime; backend/src/phase2/{coreApp,coreDomains,runtime},
password/token/worker; services/{clinic,notification}/src/{index,app,runtime};
tools/phase2/resilience.test.mjs và e2e-server.mjs. [Inventory](p6-api-and-runtime-inventory.md),
[runbook](../../deploy/phase2/resilience-runtime.md), [ADR](decisions.md).
Public business OpenAPI vẫn 69 operations; P6 không có Prisma migration mới.

## Kiểm chứng thật

Suite chạy trên exact3 project pet-phase2-p1-test, PG/Redis/Rabbit loopback; từng
DB/role/marker xác minh trước migrate/write. RSA/tokens ephemeral, fixture UUID,
outbox relay/consumer scope theo run; không drain old failure queue. SQL lock
barrier quan sát pg_stat_activity, không thay business bằng mock success.

Aggregate cuối p6-verify-complete.log: **18/18 P6 PASS, 0 skip, ~71.64s**, gồm:

1. 60 tài khoản chung IP, hai Core; /me không dùng login quota, hash cũ hoạt động.
2. Một Redis account counter qua hai Core, forged X-Forwarded-For không bypass.
3. Burst 30 PBKDF2 thật, phải có 503 admission; peak active=2/pending=2 mỗi Core.
4. JWT sai algorithm/issuer/audience/kid/role/expiry và actor giả bị từ chối.
5. Credential sai scope, public private-path denial, normalized-path traversal.
6. Nginx phân phối hai Clinic, cùng key một resource, khám/Spa cùng slot 201/409.
7. Ảnh y tế tạo replica 1/read replica 2, không cần filesystem chung.
8. Startup thiếu kid/token alias/private signing key ở verifier exit 1 sạch.
9. Profile SQL thật bị khóa, HTTP deadline 503, late SQL commit/read lại đúng.
10. Persisted outbox backlog: readiness degraded, hard reject write/read vẫn 200.
11. Redis stop: auth/write 503, JWT read degraded, recover shared authority.
12. Broker stop: Clinic business+outbox commit, pending rồi một notice khi recover.
13. Kill Clinic giữa requests: surviving replica/durable replay, lỗi đếm trung thực.
14. Register/password/activation giữ owner/pets/appointment/medical/invoice history.
15. Activation revoke/expiry/single-use không đổi owner history.
16. Private metrics/resources/correlation; không secret/ID/email labels/logs.
17. Worker inbox chờ khóa SQL, unacked>0/effect=0 trước drain; commit rồi ACK.
18. Core drain profile write đang chờ SQL, response/row đúng trước disconnect.

Lượt aggregate chạy source cuối, gồm required remote URLs, tracing, positive
credential checks, scoped billing worker và exit-code diagnostic; **exit 0**.
Tổng **62 integration groups** (P1 12 + P2 API 5 + runtime 8 + P3 7 + P4 12 +
P6 18), **18/18 real E2E (~1.7 phút)**, contracts **8/8**, runtime **4/4**,
dependency **2/2**, boundaries và writer audit đều đạt, không skip. E2E dùng
một Core qua các ca bình thường; sáu child lifetimes (gồm Notification outage/
restart có chủ đích) đều expected exit 0. Không giả định harness sửa native crash.

npm test source cuối (p6-npm-test-complete-network.log): **exit 0**,
backend/frontend build, **81 unit + 4 runtime + 2
dependency**, 0 skip, architecture 96 files và OpenAPI 69 operations. CSS sau
dependency overrides vẫn index-COwuqpYj.css, SHA256
7a38d0adde8ec08c7c34fc454964a4a7e22e5eeb73774b6650aa8153a551d4a9,
khớp snapshot trước P6. npm ls actual tree hợp lệ; audit 0 theo lockfile hiện tại.

UI intercept suite riêng **9/9, exit 0 (~19.3s)**; không thay real E2E. Số đo
đã lọc ở [runtime observations](p6-runtime-observations.json): own-role connection
snapshot Core 5/Clinic 5/Notification 3, hash peak active/pending 2/2 mỗi Core,
11 admission rejects mỗi Core; 15/15 GET sau kill Clinic trả 200. Đây không phải
peak/capacity benchmark. [Test history](test-results.md) giữ đầy đủ các FAIL.

Cuối phiên guard exact3 rồi stop riêng: cả ba container Exited (0), volumes/
database/fixture rows giữ nguyên. Hai queue lỗi cũ còn ready=1/unacked=0 mỗi
queue, gồm p2.runtime.34ab904b…clinic và p4.billing.9ce7ecfc…notification;
không consume/ACK/purge/delete. API/worker/Nginx do runner tạo đã dừng; không
dừng hai Node process có từ trước phiên. P6 DONE chỉ trong phạm vi stack thử.

## Lỗi đã sửa và dependency

- Build đầu lỗi typing traceHeaders/OpenAPI import path: sửa, full workspace
  build exit 0. Nginx setup thiếu temp dir: 0 body tests, sửa fixture dir.
- Proof 7/10: fixture Prisma time phải appointmentTime; notification aggregateId
  khác appointmentId; broker health ping báo healthy khi Rabbit app chưa chạy.
  Sửa field/envelope scope/healthcheck check_running, giữ assertions/old queue.
- Proof tiếp 12/13: payload dùng relatedAppointmentId, sửa relay/filter fixture.
  Sau đó 18/18 cả body + teardown. Không biến run failed thành PASS.
- Chạy npm test đồng thời proof gây Prisma Windows DLL EPERM generate; đó là lỗi
  orchestration, không PASS. Chạy tuần tự sau drain: npm test exit 0.
- Aggregate đầu: 62 integration groups + runtime/dependency đạt, sau đó native
  Windows exit 3221226505 ngay startup E2E, chưa rõ nguyên nhân. E2E riêng chạy
  được 17/18; tìm lỗi middleware billing mount toàn /internal, chặn credential
  bootstrap hợp lệ. Giới hạn guard billing theo đúng path và bổ sung cả positive
  scope + bootstrap compatibility checks, không hạ assertion region available.
- E2E outage chạy riêng ban đầu không có unread do đặt lịch chỉ báo admin; trước
  đó nó dựa notification từ test trước. Fixture nay xác nhận lịch bằng API thật
  để phát owner notice trước outage, giữ assertion broker/inbox/unread thật.
- Aggregate hai: P1–P4 đạt, P6 17/18 do assertion mới gọi findUnique bằng
  appointmentId của partial unique; Prisma unique selector chỉ có operationId.
  Sửa fixture dùng findFirst với state INVOICED; giữ proof terminal evidence.
- Aggregate ba: tracing/outage đã đạt nhưng reservation check hết hạn vì fixture
  chưa chạy relay/reconciler Core cho operation mới. API invoice commit không
  tự finalize Clinic; fixture nay khởi động built billing worker chỉ cho operation
  UUID của mình, kiểm HTTP terminal evidence thật, không drain operation cũ.
  Nhánh 202 kiểm public operation.status=succeeded theo contract hiện hành.
- Aggregate bốn: 62 integration groups đạt, browser chỉ 3/18 rồi Core mất TCP.
  Harness cũ bỏ kiểm exit code khi child đã thoát; chưa xác định nguyên nhân
  process loss. Runner nay lưu exit code/signal và log riêng, kiểm exit 0 cả khi
  child đã thoát. E2E diagnostic source cuối đạt 18/18, exit 0 (~1.7 phút), mọi
  child lifetime thoát 0 qua drain. Không restart Core giữa ca hoặc skip test.
  Một lần native Windows startup exit 3221226505 và process loss này vẫn là
  rủi ro chưa giải thích; không kết luận đã sửa native crash bằng thay harness.
- Audit đầu: 11 findings (2 moderate/6 high/3 critical). Override exact proxy-addr
  2.0.8, shell-quote 1.12.0, source-map-js 1.2.2, selector-parser 7.1.6; giữ
  Tailwind 3.4.19. Node redis client 6.3.0. braces chưa có release fix upstream;
  vendor build-only 3.0.3-pet-p6.1 giữ MIT, iterative depth/node/cycle guard trước
  recursive APIs. Tests kiểm cả actual chokidar/micromatch/Tailwind resolution,
  pattern/AST 2000 cấp và glob/range thường; compiled CSS không đổi.
  [Patch notes/advisory](../../tools/vendor/braces/PATCH-NOTES.md).

## Giới hạn và bước tiếp

Đây là correctness/fault proof, không benchmark throughput/capacity. Default
pool tham khảo 36 connections cho 2 Core API + 2 Clinic API + Notification API
và các worker; thêm control/migration/headroom. Proof pool API/worker=2, control=4;
snapshot CPU/RSS/latency/own-role connections không phải peak workload mix.
Outbox admission cache 3s có thể vượt threshold bởi in-flight; không atomic cap.
Graceful proof hoàn tất trước deadline, không chứng minh mọi SQL hang vô hạn.

Chưa remote CI/clean-clone independent machine, HA/host loss, external storage,
mail/payment thật, long load, historical backup/restore/cutover/rollback. JWT 8h
và password change không thu hồi token ngay; chưa dual-kid rotation/refresh list.
P7 cần migration manifest/full backfill/reservations/history, restore DB thử,
single-writer switch và rollback rehearsal; chưa đạt H hoặc bàn giao thành viên.
