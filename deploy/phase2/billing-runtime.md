# P4 — Billing appointment trên stack thử riêng

**Cấu hình runtime đích hiện tại ở [P6 auth/resilience](resilience-runtime.md).**
Các credential/env P2–P5 bên dưới là compatibility proof lịch sử; không dùng
chúng để deploy target. `phase2:verify` hiện gồm P1–P6 và E2E thật, cần Redis
và Nginx; trên Windows chạy `npm run phase2:prepare:nginx` trước.

Core giữ hóa đơn/thanh toán; Clinic giữ appointment và reservation. Runtime P4
dùng `AppointmentBillingOperation` ở Core, `AppointmentReservation` và
`AppointmentBillingTerminal` ở Clinic. Các bảng/client proof P1 được giữ riêng.
Không bật traffic hoặc migrate DB đang dùng bằng runbook này.

## Tái hiện

Từ root, Docker Desktop đang chạy:

```powershell
npm run phase2:up
npm run phase2:verify
npm test
npm run phase2:test:notification-ui
docker compose -f deploy/phase2/compose.test.yml stop
```

Riêng P4, build trước rồi `npm run phase2:test:billing`. Wrapper guard project,
host/port, database/user và marker trước migration/SQL. Suite cấp RSA fixture,
chọn ports trống, chạy hai Core + hai Clinic process build, worker đối soát,
Clinic/Notification consumers và PostgreSQL/RabbitMQ thật. Không gọi gateway
thanh toán; confirm IPN/transfer chỉ dùng dữ liệu synthetic trong DB thử.
Giữ volumes, rows và queue lỗi; cleanup chỉ queue rỗng thuộc UUID của suite.

## Cấu hình runtime

Giữ cấu hình Core/Clinic từ [runbook Clinic](clinic-runtime.md): Core có RSA
private/public, issuer/audience; Clinic chỉ public key. Core API và billing worker
cần `CLINIC_SERVICE_URL` (origin cố định) và `CLINIC_SERVICE_TOKEN` 32–512 ký tự.
Clinic cần `CORE_SERVICE_URL` trỏ Core API và cùng credential. Không lưu JWT/keys
hay connection string thật vào evidence. DB/client/credential riêng mỗi service.

Chạy worker đối soát trong environment của Core API:

```powershell
npm run worker:billing -w backend
```

Worker này không phụ thuộc broker để resume/finalize qua HTTP. Vẫn chạy Core
outbox relay (`worker:notifications`) và Clinic/Notification workers để gửi sự
kiện/notice. Đây là các process của ba service, không thêm service thứ tư.
`BILLING_OPERATION_ID` là filter chọn một operation để kiểm chứng/đối soát có
phạm vi; mặc định worker xử lý toàn bộ pending/unfinalized trong Core DB.

## HTTP và transaction

- Staff `POST /api/invoices`, owner `POST /api/invoices/checkout` với nguồn
  appointment bắt buộc `Idempotency-Key` tối đa 128 ký tự. Hash canonical phí,
  dòng dịch vụ, notes và revision nếu caller cung cấp; key theo actor/type.
  Hotel giữ contract và transaction baseline. VND nguyên tối đa 9.999.999.999;
  owner Spa lấy giá cố định từ bảng giá backend, không nhận giá từ browser.
- Core tạo PREPARING bền vững trước network. Nếu thiếu revision, lấy nguồn
  Clinic rồi CAS revision vào operation một lần. Core mint actor RS256 sau khi
  kiểm current role; Clinic kiểm service credential/JWT và owner snapshot nguồn,
  không gọi ngược Core trong prepare hoặc giữ SQL transaction qua HTTP.
- Prepare khóa appointment, kiểm completed/revision và active unique; lưu HELD
  - snapshot tối thiểu. Snapshot không chứa internalNote/bệnh án. Replay trả
    snapshot đã lưu; RELEASED/abort tombstone không được prepare lại.
- Core khóa operation; commit chỉ khi PREPARING, tạo invoice/items/snapshot,
  COMMITTED và billing/notification outbox cùng transaction. Abort dùng cùng
  khóa và ghi ABORTED + outbox; terminal không hồi sinh. Invoice giữ unique
  appointmentId nhưng không còn FK tới bản clinical cũ tại Core.
- Thành công giữ 201 staff / 200 checkout và `{ invoice }`. Sau deadline chờ
  4,5s hoặc network unknown, trả `202 { operationId, status: "pending" }`,
  `Location: /api/operations/:id`, Retry-After. Deadline kết thúc chờ HTTP;
  tác vụ đang chạy vẫn có thể commit dưới khóa operation.
- `GET /api/operations/:id` chỉ original actor **và role**, current role còn
  hợp lệ; trả pending/succeeded/failed và invoice đã commit khi có. Role hạ xuống
  owner không được xem lại operation staff của mình cho owner khác.
- Private Core operation GET chỉ service-auth, đọc state/appointmentId/invoiceId,
  không gọi Clinic. Clinic commit/release không nhận terminal evidence từ body:
  đọc endpoint này ngoài transaction rồi áp bằng chứng terminal dưới khóa.
  Core timeout/404/PREPARING giữ HELD; không release theo tuổi reservation.
- Inbox billing + actual reservation/terminal marker cùng transaction. Abort
  đến trước prepare lưu tombstone; prepare đang bay sau abort có thể HELD, nhưng
  Core không commit được, và trusted abort event/reconcile đưa về RELEASED.
  Release trái COMMITTED/INVOICED bị từ chối, inbox lỗi không commit.

Checkout cùng key trả invoice cũ. Checkout key mới cho một invoice P4 đã có
giữ baseline: operation alias trỏ cùng invoice/snapshot, finalized ngay, không
tạo reservation/event/notice mới. Core invoice pointer vì vậy có thể được nhiều
checkout operation tham chiếu; unique appointmentId vẫn chỉ cho một invoice.

## Reconcile và UI

Claim theo `FOR UPDATE SKIP LOCKED`, lease owner/30s, batch tối đa 32 (worker 8),
attempts/backoff tối đa 60s; stale worker không ghi metadata thay owner lease mới.
Crash mất process giữ operation/reservation, lease hết được worker khác lấy lại.
PREPARING resume; terminal chưa finalized gọi Clinic rồi ghi finalizedAt. Không
tự xóa terminal, reset hoặc đổi trạng thái bằng SQL để ép demo thành công.

`mode=unbilled` loại HELD/INVOICED **trước count/page**; `counts.billingHeld`
đếm theo scope/filter trong cùng Repeatable Read. UI cho biết dịch vụ đang chốt
phí. Form staff/owner lưu key/body/operationId trong sessionStorage theo phiên
actor/role/iat; timeout giữ intent, 202 poll bounded rồi cho kiểm tra lại. Form
pending khóa phí; đóng form vẫn tiếp tục xử lý, không đồng nghĩa abort. Reload
khôi phục intent; kết quả failed xác định mới cho tạo key khác. Ghi thành công
nhưng reload lỗi báo đã lưu.

## Migration và giới hạn

Core `20261011000800_appointment_billing`: operation/lease metadata, invoice
snapshot và bỏ clinical FK, giữ unique/data cũ. Clinic
`20261011000900_billing_terminal`: timestamps reservation và terminal marker.
Chỉ deploy `p2_core_test/core_runtime_test`, `p2_clinic_test/p1_proof` trong phiên
P4; không sửa migration lịch sử, drop/reset dữ liệu hoặc `.env` đang dùng.

Hóa đơn cũ vẫn đọc/thu tiền ở Core, giữ IDs/items/timestamps/totals; snapshot có
thể null cho legacy. Checkout operation alias cần snapshot P4 đã có; historical
snapshot/reservation backfill và whole-model migration vẫn thuộc P7 trước cutover.
Không rollback bằng bật writer clinical cũ sau ghi mới: cần giữ/export/đối soát
dữ liệu và reverse migration đã kiểm chứng, hoặc forward-fix.

Chưa remote CI, full real browser E2E, backup/restore/live cutover, Redis/auth
surge/HA/load/benchmark. UI tests dùng API intercept; SQL/broker/race tests dùng
backend thật. P5/P6/P7 và H còn phải đạt trước bàn giao.
