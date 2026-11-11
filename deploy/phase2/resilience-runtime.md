# P6 — Auth, resilience và vận hành runtime

Runtime đích vẫn gồm Core, Clinic & Scheduling và Notification. Package
`@nipopeto/runtime` chỉ chứa transport/admission/quan sát, không repository hay
Prisma client dùng chung. Chưa chuyển dữ liệu/traffic đang dùng; P7 phải rehearsal
trước khi áp dụng cấu hình này ngoài stack thử.

## Cấu hình bắt buộc

Bật `PHASE2_RUNTIME_REQUIRED=1` cho các API/worker đích. Các suite proof lịch sử
có factory tương thích khi flag/Redis vắng mặt; đó không phải cấu hình deployment.
Không nạp `.env` Core vào Clinic/Notification. Cấp từng process các biến của nó.

| Process             | Credential/JWT cần cấp                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Core API            | RSA private/public key, issuer/audience/kid; cả bốn token nghiệp vụ bên dưới; URL Clinic/Notification                         |
| Clinic API          | RSA public key/issuer/audience/kid; CORE_DIRECTORY_TOKEN, CORE_BILLING_EVIDENCE_TOKEN, CLINIC_BILLING_TOKEN; CORE_SERVICE_URL |
| Notification API    | RSA public key/issuer/audience/kid; CORE_NOTIFICATION_SEND_TOKEN; CORE_SERVICE_URL                                            |
| Core outbox worker  | DB Core + broker; không cần signing key                                                                                       |
| Core billing worker | DB Core + RSA signing config + CLINIC_BILLING_TOKEN + CLINIC_SERVICE_URL                                                      |
| Clinic worker       | DB Clinic + broker + CORE_DIRECTORY_TOKEN/CORE_SERVICE_URL; không cần private key                                             |
| Notification worker | DB Notification + broker; không cần private key                                                                               |

Các API dùng DB credential riêng, REDIS_URL, RATE_LIMIT_NAMESPACE,
RATE_LIMIT_KEY_SECRET và OBSERVABILITY_TOKEN. Token/limiter secret dài 32–512 ký
tự, cấp từ secret manager hoặc môi trường; không đưa giá trị vào Git/logs.
Namespace và HMAC secret phải đồng nhất giữa replica, giữ ổn định qua restart.
Các token phải khác nhau. Core/Clinic strict startup từ chối token dùng chung.

| Token                        | Quyền endpoint                                                         |
| ---------------------------- | ---------------------------------------------------------------------- |
| CORE_DIRECTORY_TOKEN         | Core /internal/directory/\*, gồm authorize actor/pet hiện tại          |
| CORE_BILLING_EVIDENCE_TOKEN  | Core /internal/billing-operations/:id, xác minh terminal evidence      |
| CLINIC_BILLING_TOKEN         | Clinic /internal/billing-sources/_ và /internal/billing-reservations/_ |
| CORE_NOTIFICATION_SEND_TOKEN | Core /internal/notifications/authorize-send                            |
| OBSERVABILITY_TOKEN          | /metrics riêng; không cấp quyền nghiệp vụ                              |

Actor vẫn cần Bearer JWT ở endpoint yêu cầu actor; service token không cấp quyền
admin, projection không cấp quyền. Public gateway chặn /internal, /metrics và
/health. Core proxy kiểm tra pathname sau chuẩn hóa vẫn thuộc domain public.

## Token và mật khẩu

Core ký RS256, RSA ít nhất 2048 bit; cặp key phải khớp. Clinic/Notification chỉ
verify, strict startup từ chối JWT_PRIVATE_KEY/JWT_SECRET. Kiểm algorithm,
issuer/audience/kid/expiry/role/sub và token size. Không fallback HS256 trong
runtime đích. JWT_EXPIRES_IN mặc định vẫn 8h; chưa có refresh/revocation list.

P7 phải rollout key/public verifier/issuer/audience/kid đồng bộ và thông báo
đăng nhập lại cho token HS256 cũ. Chưa đổi token đang dùng. Đổi mật khẩu không
thu hồi JWT đã phát tức thì; thay key/kid khiến token cũ hết hiệu lực. Core role
guards cũ có thể còn hiệu lực token đến hạn; Clinic/manual-send kiểm actor hiện
tại qua Core. Không quảng cáo khả năng thu hồi tức thì hoặc rotation nhiều key.

Password giữ PBKDF2 SHA-256 210,000 iterations và format hash/salt cũ. Admission
mặc định mỗi Core 2 hash đang chạy, 16 đang chờ, queue deadline 1250ms. Các biến
HASH_CONCURRENCY/HASH_PENDING_LIMIT/HASH_QUEUE_TIMEOUT_MS có giới hạn cấu hình.
Queue đầy/hết hạn trả 503; running hash giữ slot đến khi hoàn tất. Không hạ số
iterations để đo tải. Reg/activation/change-password dùng cùng admission.

## Rate limit dùng chung và degraded

Redis Lua kiểm mọi dimension trước khi tăng counter, TTL dùng clock Redis;
HMAC keys không chứa email/IP thô. TRUST_PROXY_CIDRS là danh sách proxy/address
được tin rõ ràng; mặc định không tin X-Forwarded-For. Không dùng trust hop tùy ý.

| Nhóm               | Mặc định                               | Khi Redis lỗi                                            |
| ------------------ | -------------------------------------- | -------------------------------------------------------- |
| Owner/admin login  | 1000/IP + 30/account /15 phút          | 503, Retry-After 2                                       |
| Register           | 300/IP /15 phút                        | 503                                                      |
| Activation/inspect | 300/IP /15 phút                        | 503                                                      |
| Password change    | 10/actor + 200/IP /15 phút             | 503                                                      |
| /me và read domain | 3000/IP + 600/actor /phút, mỗi service | Local 300/IP + 60/actor /phút, X-Service-Degraded: redis |
| Write domain       | 1000/IP + 120/actor /phút, mỗi service | 503                                                      |

429 luôn kèm Retry-After; /me không dùng quota login. AUTH*\* và API*\* limit có
thể cấu hình trong bounds, giữ cùng policy giữa replica. Proof account limit 3
để kiểm counter; cùng-IP dùng limit IP mặc định, 60 tài khoản thật, hash thật.
Degraded reads là per-process, tổng quota tăng theo replica; Map tối đa 4096
keys, đầy sẽ từ chối. Chỉ phục vụ read sau auth/domain guard hiện có. Mọi write
fail closed khi không có Redis; không nhận write bằng memory limiter. Client
Redis không có offline queue, command queue tối đa 256, timeout 350ms mặc định.

## Health, backlog và deadline

- /health/live: process còn sống. /health/ready: DB riêng và migration expected
  đã deploy; DB lỗi trả 503. Redis/broker outage trả 200 degraded, không khiến
  gateway loại một replica vẫn có thể đọc hoặc ghi outbox an toàn khi broker lỗi.
- Health/metrics refresh thực, write admission cache tối đa 3s; probe DB dùng
  transaction/statement timeout và không mutate dữ liệu. Không tự migrate/seed
  tại API startup. Migration IDs vẫn là P0–P4; P6 không tạo migration mới.
- Outbox soft=10,000 báo degraded, hard=20,000 trả 503 cho write. OUTBOX\_\* tùy
  chỉnh, soft phải nhỏ hơn hard. Count/retries được cap hard+1, age từ hàng cũ
  nhất. Cache + in-flight có thể vượt threshold; đây là admission, không phải
  constraint dung lượng tuyệt đối. Dành headroom và giám sát disk; không tự xóa
  backlog hoặc release HELD theo tuổi. Notification không có producer outbox.
- DB_POOL_LIMIT mặc định 4/process (1–32), pool wait 2s, connect 2s. HTTP deadline
  10s, Node request 15s/header 10s/keepalive 5s; upstream directory/billing/proxy
  có timeout riêng. Deadline trả 503/Retry-After, không khẳng định write rollback
  hay hủy SQL/PBKDF2. Client tra/retry cùng durable key với create/billing; thao
  tác không có key phải đọc lại trạng thái/revision trước khi thử tiếp.
- SIGTERM/SIGINT ngừng nhận request và drain trước DB disconnect. Windows proof
  dùng parent IPC được tạo bởi OS parent để gọi chính hàm drain; không có HTTP
  debug/shutdown endpoint. Worker drain pending SQL + ACK rồi đóng channel. Forced
  kill không chạy drain; lease/inbox/durable retry phục hồi theo P1–P4.

## Proxy, storage và resource budget

[nginx.split.conf.example](nginx.split.conf.example) là cấu hình API tham khảo,
chưa thay gateway người dùng. Hai Clinic thực chạy trên cùng DB Clinic với pool
riêng. Nginx passive failover, GET có thể retry sang replica sống; không bật
non_idempotent retry. POST không rõ kết quả phải retry durable key ở client.
Private loopback listener 8081 trong example cho Core billing/bootstrap, vẫn
kiểm credential/actor ở từng endpoint. Windows dùng prefix Nginx có sẵn `logs`
và `temp` directory trước `nginx -t`; syntax check example đã chạy thành công.
MedicalImage hiện lưu imageUrl trong DB Clinic (gồm data URL), không dùng disk
cục bộ replica; proof tạo qua replica 1 và đọc qua replica 2. Chưa thêm object
storage/upload service hoặc kiểm chứng persistence ảnh ở dịch vụ bên ngoài.

| Deployment tham khảo                                       | Pool DB ứng dụng tối đa                   |
| ---------------------------------------------------------- | ----------------------------------------- |
| 2 Core API + outbox worker + billing worker, mỗi process 4 | 16 Core                                   |
| 2 Clinic API + worker, mỗi process 4                       | 12 Clinic                                 |
| Notification API + worker, mỗi process 4                   | 8 Notification                            |
| Tổng                                                       | 36, cộng migration/admin/control/headroom |

Đây là ngân sách cấu hình, chưa phải capacity benchmark. Stack proof dùng API và
worker pool 2, mỗi control client 4; đo pg_stat_activity theo own role khi cả hai
Clinic còn sống. Hash 2/Core, pending 2 trong proof (production default 16).
Nginx proof 1 worker/256 connections; Redis/Rabbit/PostgreSQL một container mỗi
loại, không HA. P8 mới đo workload mix/RSS/CPU/event loop/throughput lặp lại.

## Quan sát và tái hiện

/metrics cần X-Service-Token=OBSERVABILITY_TOKEN trên mạng private. Prometheus:
HTTP histogram route template/status, hash active/queue/peak/reject/durations,
Redis/degraded/reject, DB availability/own-role lock waits, pending outbox/age/
retry, billing pending/age, broker queue ready/DLQ ready, CPU/RSS/event loop.
Queue không đọc được là -1 (unknown). Không xuất raw ID/email/IP/query/body hoặc
credentials. X-Request-Id UUID được truyền Core→Clinic/Notification và internal
HTTP, logs fixed fields service/instance/requestId/route/method/status/latency.
Notification outbox giữ request correlation; relay log publish-confirmed,
consumer log effect-committed/duplicate trước acknowledged, không log payload.
Billing result log nối requestId với operationId; terminal event dùng operation
correlation bền vững qua restart. Directory trigger vẫn sinh correlation event
riêng; chưa nối trigger SQL đó về HTTP request. Không gắn event/operation ID vào
metric labels. Có thể tính p95 từ histogram bằng PromQL; chưa chạy Prometheus
server/dashboard trong stack proof:

```promql
histogram_quantile(0.95, sum by (service, route, le) (rate(pet_http_duration_seconds_bucket[5m])))
```

```powershell
npm ci
npm run phase2:prepare:nginx # Windows: pinned official archive/hash under test-results
npm run phase2:up
npm test
npm run phase2:verify
```

Linux cần nginx binary (`apt-get install nginx`); P6_NGINX_BINARY override đường
dẫn. Suite tự sinh RSA/credential ephemeral và UUID namespace/queue, xác minh
exact3 Docker project + database/role/marker trước mọi ghi. Chỉ dừng/restart
container thử đúng tên. Không down -v, seed/reset, FLUSH Redis, purge/ACK backlog
cũ. Build/test tuần tự trên Windows để không generate Prisma DLL đang được dùng.
Raw outputs nằm trong test-results bị ignore; report chỉ dùng artifact sanitized.

Browser runner ghi exit code/signal của từng child do nó tạo và kiểm drain exit 0,
kể cả child đã thoát trước teardown; log riêng ở test-results/phase2/p6-child-\*.log.
Không tự restart Core giữa các ca để che process loss hoặc reset quota. Trong
kiểm chứng Windows có một native startup exit 3221226505 và một lượt Core mất TCP
chưa rõ nguyên nhân; E2E diagnostic sau đó đạt 18/18. Kết quả PASS trên máy này
không chứng minh đã sửa nguyên nhân native crash; cần đối chiếu trên clone/máy
khác và remote CI trong P7/H, giữ raw FAIL để điều tra nếu lặp lại.

Dependency build có braces guard cục bộ vì advisory chưa có release upstream sửa;
không coi npm audit=0 là bằng chứng bảo mật toàn diện. Xem
[PATCH-NOTES](../../tools/vendor/braces/PATCH-NOTES.md) và regression tests.
Chưa chạy remote CI, HA/host loss, long load, payment/mail thật hay live cutover.
