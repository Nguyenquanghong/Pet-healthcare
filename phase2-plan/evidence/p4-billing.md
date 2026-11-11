# P4 — Billing liên dịch vụ: bằng chứng triển khai

11/10/2026; main/add596e4488e3cac2584115874c2f65a97af7047.,
commit/push/merge, reset, live DB write hoặc cutover. 18 SHA256 ban đầu giữ nguyên.
[Runbook](../../deploy/phase2/billing-runtime.md), [test history](test-results.md).

## Phần đã triển khai

- Core runtime operation/fees canonical/hash/actor/type/key, active-source unique,
  commit/abort cùng operation lock; actual invoice/items/source snapshot và cả
  billing + notification outbox atomic. P1 proof client/model giữ riêng.
- Actual Clinic prepare/source/status/finalize/release, service credential + actor
  RS256; khóa appointment chung với lifecycle/medical, active reservation unique.
  Terminal evidence đọc Core read-only; Core lỗi/404 không release. Inbox giữ
  terminal marker chống delayed prepare sau abort và rollback khi state xung đột.
- Core public compatibility 201/200, 202/Location khi unknown/deadline và GET
  operation theo original actor/role. Spa fixed price, staff fees và hotel baseline
  giữ nguyên; checkout invoice đã có không tạo invoice/notice/reservation khác.
- Billing worker leased/retry/reconnect, resume PREPARING và đối soát terminal,
  hoạt động qua HTTP khi broker down. `unbilled` filter local trước count/page,
  billingHeld count cho UI; frontend pending/key/body qua timeout/reload, khóa phí,
  check trạng thái, failed mở lại và saved/reload-failed distinction.
- Public 67 operations, internal Core/Clinic contracts, billing event appointmentId,
  frontend types, guarded suite và CI workflow cập nhật. Nginx baseline đã proxy
  mọi `/api/` nên operations đi cùng Core; không sửa file proxy local ban đầu.

Files chính: backend/src/phase2/appointmentBilling.ts, billingApi.ts,
billingWorker.ts; services/clinic/src/runtimeBilling.ts, billingApi.ts, inbox.ts;
frontend/src/services/useInvoiceOperation.ts và hai màn billing. Migrations Core
008 / Clinic 009 chỉ áp DB thử. Invoice clinical FK bỏ, scalar unique và dữ liệu
cũ giữ lại; snapshots/timestamps/IDs/financial data không tự rewrite.

## Kiểm chứng P4

`npm run phase2:test:billing` trong wrapper cuối đạt **12/12, 0 skip**, ~38,6s. Real PG,
broker, HTTP; hai built Core + hai Clinic process, hai built reconciler và built
Clinic/Notification consumers. Không dùng mock SQL để chứng minh khóa/atomicity.

1. Tám create qua hai Core/Clinic replicas cùng key: một invoice/reservation;
   canonical hash/key mismatch và scope; hai key một nguồn chỉ một invoice.
   GET operation không lộ cho owner khác hay actor staff sau bị hạ quyền.
2. Owner Spa giá backend, key mới checkout trả cùng invoice; source chưa completed,
   owner khác, tự gửi giá, fractional/oversized revision bị từ chối. VND 9.999.999.999
   hợp lệ, không hạ giới hạn theo proof int32.
3. Prepare–undo hai phía thắng với SQL barrier và **pg_stat_activity Lock waiter**
   trên actual appointment. Không invoice cho source được mở lại.
4. Commit–abort hai phía thắng dưới actual operation lock; terminal không hồi sinh,
   trusted finalize/release nhất quán, fault callback rollback toàn transaction.
5. Abort trước/during late prepare; terminal tombstone; Core timeout/404/PREPARING
   giữ HELD, caller không được tự gửi state; trái-state event rollback inbox.
6. Durable trước prepare / sau HELD được hai reconciler resume; expired dead-worker
   lease được reclaim, một invoice và INVOICED, metadata lease được thả.
7. **Kill built Core thật** sau Clinic HELD, mất prepare response trả 202/Location,
   pending GET và worker recovery; retry original key trả original invoice.
8. Actual outbox CHECK fault rollback invoice + billing/notification outbox, operation
   còn pending, HELD giữ; bỏ đúng constraint test rồi retry chỉ một invoice.
9. Core operation SQL lock giữ commit: request deadline trả 202 trước commit,
   unlock cho work đang bay commit, cùng key resolve một invoice.
10. Legacy paid invoice không cần Core clinical FK vẫn đọc đúng ID/items/date/total;
    synthetic transfer report/pay và IPN lặp không thu trùng, không gọi gateway.
11. HTTP body invoice thực bị bỏ sau commit, replica retry trả ID cũ; snapshot không
    đổi khi source/pet fixture đổi, onsite/cash retry chỉ một payment event.
12. Broker stop vẫn invoice/outbox commit + HELD chặn undo; unbilled total/page 0 và
    billingHeld 1; built consumer recovery INVOICED. Invoice notice đi Core outbox
    qua broker tới Notification; replay event giữ một inbox/notification.

Chromium **9/9** (~18,3s), 3 P4 + 3 Clinic + 3 Notification, built frontend,
mọi API intercept: staff 202/freeze/reload/poll không POST lại, definitive abort
tạo key mới, owner mất response giữ key/body qua reload và saved/refresh-failed.
Đây chưa là full real multi-service browser journey (P5).

Wrapper cuối `npm run phase2:verify` **exit 0**: builds, contracts 7/7,
boundaries/writer audit và 44/44 integration groups P1–P4, 0 skip. `npm test`
exit 0: build, unit 81/81, architecture 93 files, public OpenAPI 67 operations.
Chi tiết hồi quy ghi ở test-results; CI remote chưa chạy. Lỗi đầu có TypeScript narrowing,
ES target/ApiError property, fixture history action và UI selector, đã sửa trong
scope, không bỏ test hay nới invoice/undo invariants.

Teardown P2/P3/P4 chờ broker báo cả ready và unacknowledged bằng 0 trước khi
dừng consumer. Kiểm tra này chỉ đọc thống kê RabbitMQ trong project thử đã guard.
Queue/message từ lần teardown P2 lỗi được giữ để đối chiếu; không ACK/purge ép
thành công và không bỏ assertion queue rỗng.

## Chưa kiểm chứng

Full historical clinical/snapshot/reservation import, backup restore, live cutover,
remote CI, real browser journey, shared limiter/auth surge/replica proxy/HA/load và
benchmark. Historical invoice snapshot có thể null; P7 phải backfill trước split
cutover. Hotel/cash/transfer/IPN được hồi quy trên synthetic data, không chứng minh
gateway thanh toán thật. Network/keys/metrics/advisories còn P6, H chưa đạt.

Bước tiếp theo P5: đọc theo từng màn/region, session isolation, Notification lỗi
không logout, bỏ polling global, page query/debounce/cancel, E2E thực cho toàn bộ
hành trình và network evidence. Không bàn giao cho người khác trước H.
