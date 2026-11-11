# P3 Clinic trên stack thử riêng

**Cấu hình runtime đích hiện tại ở [P6 auth/resilience](resilience-runtime.md).**
Các credential/env P2–P5 bên dưới là compatibility proof lịch sử; không dùng
chúng để deploy target. `phase2:verify` hiện gồm P1–P6 và E2E thật, cần Redis
và Nginx; trên Windows chạy `npm run phase2:prepare:nginx` trước.

P3 đã có runtime đọc/ghi thật, không chỉ health/proof. Cấu hình tách Clinic là
opt-in; chưa đổi `.env`, Compose/Nginx hoặc traffic đang sử dụng.

## Tái hiện kết quả

Từ repo root, Docker Desktop đang chạy:

```powershell
npm run phase2:up
npm run phase2:verify
npm test
npm run phase2:test:notification-ui
docker compose -f deploy/phase2/compose.test.yml stop
```

`phase2:verify` build trước rồi chạy tuần tự contracts/boundaries/writer audit,
P1, Notification P2, Clinic P3 và billing P4. Riêng P3: `npm run phase2:test:clinic`.
Guard kiểm project/container/port, database/role/marker trước khi deploy migration.
Core dùng `p2_core_test/core_runtime_test`, Clinic dùng
`p2_clinic_test/p1_proof`, Notification dùng `p2_notification_test/p1_proof`.
Không gọi seed/reset, không xóa dữ liệu/volume; UUID fixture được giữ lại.

Suite P3 tự cấp cặp RSA thử, chọn ports trống, chạy hai process Clinic build,
Core HTTP và worker Clinic/Notification. Đóng đúng process/queue trống đã tạo.
UI tests dùng frontend build và intercept mọi API; không phải full real UI E2E.

## Cấu hình runtime

| Runtime             | Biến bắt buộc cho cấu hình tách service                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core API            | Core `DATABASE_URL`; `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_ISSUER`, `JWT_AUDIENCE`; `CLINIC_SERVICE_URL` là origin; `CLINIC_SERVICE_TOKEN` 32–512 ký tự |
| Clinic API          | Clinic `DATABASE_URL`; chỉ `JWT_PUBLIC_KEY`, `JWT_ISSUER`, `JWT_AUDIENCE`; `CORE_SERVICE_URL`, cùng `CLINIC_SERVICE_TOKEN`; `PORT`                          |
| Core runtime relay  | Core `DATABASE_URL`, `BROKER_URL`, `BROKER_PREFIX`; `npm run worker:notifications -w backend` hiện publish cả directory và Notification events              |
| Clinic worker       | Clinic `DATABASE_URL`, `BROKER_URL`, `BROKER_PREFIX`, `CORE_SERVICE_URL`, `CLINIC_SERVICE_TOKEN`; `npm run worker:built -w @nipopeto/clinic`                |
| Notification worker | Notification `DATABASE_URL`, cùng broker/prefix; `npm run worker:built -w @nipopeto/notification`                                                           |

Worker Clinic thiếu Core source sẽ từ chối khởi động. `CLINIC_PROOF_ONLY=1`
chỉ dành cho P1/P2 transport proofs: không hydrate đủ các trường search.
Không dùng cờ này cho runtime P3. API thiếu auth/source trả 503 cho nghiệp vụ;
health chỉ xác nhận process/schema khả dụng. Clinic không giữ signing key.

Core gateway chuyển `/api/appointments/**`, `/api/medical-records/**` sang
Clinic khi có URL cấu hình; lỗi downstream trả 503, không đọc/ghi bản clinical cũ
ở Core. `/api/bootstrap` dùng adapter: Core chỉ đọc phần Core, lấy clinical
region/count/related từ private Clinic bootstrap. Session giữ clinical arrays
rỗng như baseline, dashboard lấy các vùng nhỏ theo contract cũ. Private routes
yêu cầu service credential và actor JWT; không proxy `/internal` ra public edge.

## Directory và quyền

Core User/Pet có `directory_revision`, tăng và ghi outbox bằng trigger trong
cùng transaction với mọi writer. Export keyset cung cấp id/version và các trường
search cần thiết, không password/salt/medical notes. Đăng ký durable Clinic queue
**trước** export. `backfill(db, sync)` tại `services/clinic/src/infrastructure/messaging/backfill.ts` import
theo từng page với stable inbox IDs; event catch-up từ Core relay bảo vệ cập nhật
xen giữa snapshot. Chỉ API nội bộ HTTP đọc Core; không có SQL/client chéo service.

Wire directory events giữ displayName/phone/breed ngắn và tổng payload <=32KiB.
Worker hydrate full name, breed, phone, email, microchip từ Core trước transaction
inbox để giữ joined search cả tên dài. Nếu nguồn đã xóa/đổi kind, exact export
trả durable tombstone. Inbox + projection update atomic; version cũ không ghi đè
hoặc làm sống lại tombstone. Core outage có thể đưa hydration vào retry/DLQ;
sau hồi phục phải replay event ID theo cơ chế P1 và kiểm catch-up trước cutover.

Projection lag có thể làm kết quả **search** tạm cũ. Quyền và DTO `related` luôn
tra nguồn Core theo request; outage trả 503, không coi projection là quyền.
Core owner/pet DTO có `directoryVersion` của nguồn để theo dõi catch-up; UI chờ
projection đạt version sau write thuộc P5, chưa triển khai trong P3.
Owner IDs/quan hệ pet-owner là bất biến qua API baseline; chưa có transfer/delete
pet API. Nếu thêm chuyển chủ sau này phải thiết kế lại owner snapshot/filter
và migration trước khi bật tính năng. Ảnh có ownerId snapshot cục bộ, mọi page
trả ảnh vẫn xác minh pet/owner qua Core.

## Transaction, retry và P4

Khám/Spa dùng chung partial unique pet/date/time khi status khác cancelled/no_show.
Lifecycle có row lock, revision/history; bệnh án liên kết + completion/history +
outbox cùng transaction. Sửa/xóa bệnh án liên kết cũng khóa appointment và kiểm
reservation. `HELD`/`INVOICED` chặn mutation xung đột; proof reservation P1 được
giữ riêng, chưa là billing HTTP runtime P4.

Create appointment/record bắt buộc `Idempotency-Key`; cache kết quả/hash đã
normalize được commit cùng domain/outbox. Retry qua replica hoặc mất HTTP body
trả cùng resource; key khác nội dung trả 409. UI form giữ key qua kết quả chưa rõ,
chặn double submit, thông báo đã lưu nếu reload lỗi. Không hardcode doctor ID
không do Core xác minh; lịch chủ nuôi chưa chọn bác sĩ để staff phân công.

Sau P4, create/checkout invoice appointment dùng actual reservation/operation,
key và 202 pending theo [billing runbook](billing-runtime.md). Hotel ở Core giữ
nguyên. **Chưa được cutover hay bàn giao H**; whole-model migration còn P7.

Migrations Core `20261011000600_directory_outbox`, Clinic
`20261011000700_clinic_domains` đã deploy **chỉ** trên DB thử. Không tự rollback
bằng drop table/trigger: dữ liệu Clinic mới cần được giữ/export/reconcile trước
khi đổi writer. Full legacy migration/backup restore/cutover thuộc P7.
