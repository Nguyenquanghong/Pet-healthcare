# P2 Notification runtime và rehearsal riêng

**Cập nhật local 13/10/2026:** root Compose đã có Notification API/worker,
PostgreSQL riêng và RabbitMQ/relay trong [bản sửa A01](../../phase2-plan/evidence/fixes-20261013.md).
Phần rehearsal bên dưới giữ phạm vi lịch sử; chưa cutover DB đang dùng.

**Cấu hình runtime đích hiện tại ở [P6 auth/resilience](resilience-runtime.md).**
Các credential/env P2–P5 bên dưới là compatibility proof lịch sử; không dùng
chúng để deploy target. `phase2:verify` hiện gồm P1–P6 và E2E thật, cần Redis
và Nginx; trên Windows chạy `npm run phase2:prepare:nginx` trước.

Chỉ dùng project `pet-phase2-p1-test`. Không áp các lệnh này lên `.env`/DB demo.
`npm run phase2:test:notification-runtime` dựng Core/Notification HTTP trên ports
trống, hai process Notification, fixture RSA, ba DB và worker thật; tự đóng đúng
process đã tạo. Đây là cách kiểm chứng đầy đủ mà không phải cấu hình secret thủ công.

```powershell
npm run phase2:up
npm run phase2:verify
npm test
# UI tests dùng built frontend, mọi API bị intercept
$env:PLAYWRIGHT_SKIP_BROWSER_GC = '1'
npx playwright install chromium --only-shell
npm run phase2:test:notification-ui
```

`phase2:verify` gồm build, contracts, boundaries, writer audit, P1 integration,
P2 Notification CRUD/inbox và P2 Core/manual-send/migration/outage. Legacy mutating suites mặc định vẫn không chạy; real phase2 E2E có guard và
stack riêng, đã bổ sung từ P5, hiện dùng strict P6 credentials/shared limiter.

## Composition và cấu hình

Core entrypoint `backend/src/index.ts` dùng `phase2/coreApp.ts`, giữ nguyên file
`app.ts` có thay đổi người dùng. Core chuyển `/api/notifications/**` đến một
Notification origin cố định, deadline 4 giây, chỉ forward actor token/request key.
Không cấu hình service trả 503; không fallback local Notification writer.
Private `/internal/notifications/authorize-send` yêu cầu cả service credential
và Bearer actor hợp lệ; chỉ đọc current actor role và recipient owner trong Core.
Không proxy `/internal` ra public edge. Thư mục này chưa thay stack/Nginx đang dùng.

| Runtime                  | Cấu hình cần có                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core API                 | Core DATABASE_URL; JWT_PRIVATE_KEY/JWT_PUBLIC_KEY PEM cùng cặp RSA, JWT_ISSUER/JWT_AUDIENCE; NOTIFICATION_SERVICE_URL origin; NOTIFICATION_SERVICE_TOKEN 32–512 ký tự |
| Notification API         | Notification DATABASE_URL; JWT_PUBLIC_KEY/JWT_ISSUER/JWT_AUDIENCE giống Core; CORE_SERVICE_URL origin; cùng NOTIFICATION_SERVICE_TOKEN; PORT riêng                    |
| Core runtime relay       | Core DATABASE_URL; BROKER_URL; BROKER_PREFIX; `npm run worker:notifications -w backend`                                                                               |
| Notification consumer    | Notification DATABASE_URL; BROKER_URL; cùng BROKER_PREFIX; `npm run worker:built -w @nipopeto/notification`                                                           |
| Clinic proof relay/inbox | Clinic DATABASE_URL/BROKER_URL/BROKER_PREFIX; `npm run worker:built -w @nipopeto/clinic`                                                                              |

Credential service dùng riêng cho authorize-send, không là JWT signing key.
Core giữ HS256 legacy khi không có bất kỳ asymmetric config nào; khi có RSA config
chỉ chấp nhận RS256. Split Notification URL yêu cầu cấu hình RSA đầy đủ có private
key và credential; token HS256 cũ cần đăng nhập lại trước cutover sau này.
Expiry mặc định 8h, PBKDF2 async 210000 vòng không thay. Kid/key rotation, shared
limiter, auth surge và thu hồi tức thời vẫn thuộc P6.

Migrations chỉ chạy qua suite đã guard: full Core schema tại
`p2_core_test/core_runtime_test`, Notification/Clinic tại DB của mình/schema
`p1_proof`. `backend/prisma/phase2` vẫn là Core billing proof riêng; worker:built
của backend là proof relay, worker:notifications dùng Core runtime outbox.
Không trộn hai schema/client. Không chạy db:migrate/db:seed legacy theo runbook này.

`core_runtime_test` dùng chung giữ lại outbox chưa publish của các suite khác (không
reset). Từ 22/10, suite chạy Core worker với `OUTBOX_CREATED_AFTER` = thời điểm bắt
đầu run theo đồng hồ DB trừ 1s, nên chỉ relay event của run; event cũ giữ nguyên.
Worker từ chối biến này (`WORKER_START_FAILED`) khi thiếu
`PHASE2_TEST_CONFIRM=pet-phase2-p1-test` hoặc giá trị không phải ISO UTC. Không đặt
biến này ở môi trường thật.

## Rehearsal Notification legacy fixture

Suite runtime tạo legacy source fixtures có ID/status/timestamps cũ, xác minh
DB/role/marker rồi kiểm export/import. CLI chỉ chấp nhận các endpoint fixture
hardcoded; không đọc `.env`, không hỗ trợ DB thật trong P2.

```powershell
$env:PHASE2_TEST_CONFIRM = 'pet-phase2-p1-test'
# Chọn tên artifact mới; export dùng flag wx, không ghi đè file cũ.
$snapshot = 'test-results/phase2/notification-rehearsal-new.json'
node tools/phase2/migrate-notifications.mjs export $snapshot
node tools/phase2/migrate-notifications.mjs dry-run $snapshot
node tools/phase2/migrate-notifications.mjs import $snapshot
node tools/phase2/migrate-notifications.mjs verify $snapshot
```

CLI kiểm đúng ba container/project, PostgreSQL 127.0.0.1:55432, database/role/schema
và marker trước writes. Artifact chỉ ở thư mục test-results/phase2 đã ignore;
report stdout chỉ có counts/checksum. Dry-run kiểm fields/checksum/duplicate/collision,
không ghi. Import mỗi row qua inbox+effect atomic, event ID xác định từ legacy ID;
lỗi giữa chừng có thể resume bằng cùng snapshot. Collision không bị overwrite.
Verify cho phép sent→read và delete sau import, không làm lùi trạng thái.

P2 không quiesce writer thật, không cutover traffic hoặc restore production backup.
Tại P7 cần freeze source, manifest/backup/restore riêng và chốt ownership; sau khi
Notification có writes mới không rollback bằng cách chạy lại writer legacy.
Bootstrap/header/dashboard còn đọc Notification legacy và polling cũ, cần adapter
P5 trước cutover toàn ứng dụng. Trang hộp thư/count/manual send đã dùng API mới.

Kết thúc chỉ `docker compose -f deploy/phase2/compose.test.yml stop`, giữ volumes.
Một PostgreSQL host và RabbitMQ local không chứng minh HA/host loss hoặc capacity.
Xem STATUS/evidence về dependency advisories chưa xử lý, CI remote chưa chạy.
