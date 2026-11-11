# ADR-P03 — Retry qua delay queue, không chặn hàng đợi; thu hồi phiên có queue riêng

Ngày 24/10/2026. Trạng thái: ACCEPTED (tuần 3–4 theo kế hoạch đã chốt 23/10). Căn cứ: P03 . Commit `37a1ea1`.

**Ghi chú cấu hình:** tổng thời gian retry (§9 của P03). Hệ thống dùng mặc định `[1s, 5s, 30s, 2m, 10m]` (khoảng 12,6 phút) vì phiên làm việc tự động không hỏi được. Đổi bằng env `BROKER_RETRY_DELAYS_MS`, không cần sửa mã.

## Bối cảnh

- `consumeEvents` ngủ 1 s rồi 2 s **trong handler** trước khi publish lại, trong lúc giữ slot `prefetch(1)` duy nhất. Lần lỗi thứ 3 thì vào DLQ, không phân biệt loại lỗi.
- `identity.sessions-revoked.v1` dùng chung queue với `notification.requested.v1`.

## Đo trước khi sửa (Go/No-go, bước 1)

`node --import tsx tools/phase2/messaging-retry.probe.mjs <label>`, chạy trên project test, cấu hình retry mặc định. Kết quả ở `test-results/phase2/p03-baseline/result.json` và `p03-after/result.json`. Hai file này đã mất khi `test-results/` bị xóa ngày 28/10. Ngày 29/10 đã chạy lại "after" trên `f13766f` (`dirty` chỉ vì hai README và khác biệt CRLF), lưu ở `benchmarks/phase2/Results/p03-after-20261029/result.json` (sha256 `c2b7f49b…`). Số liệu khớp bảng dưới: 1 event áp dụng sau 6,1 s, DLQ 0; 50 event xong sau 36,8 s, DLQ 0; thu hồi phiên đứng một mình 31–37 ms, sau 500 thông báo 18–28 ms, sau 1 message luôn lỗi 20 ms.

| Kịch bản                                  | Trước                                                  | Sau                                        |
| ----------------------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| 1 event directory, Core trả 503 trong 5 s | **DLQ sau 3,2 s**, không được áp dụng (3 lần gọi Core) | Áp dụng sau 6,2 s, DLQ 0                   |
| 50 event directory, Core 503 trong 10 s   | Xong sau 11,1 s, DLQ 0                                 | Xong sau 37 s, DLQ 0 (4 lần gọi mỗi event) |
| Thu hồi phiên, đứng một mình              | 20–37 ms                                               | 24–33 ms                                   |
| Thu hồi phiên sau 500 thông báo           | **4,4–5,8 s**                                          | 19–30 ms                                   |
| Thu hồi phiên sau 1 message luôn lỗi      | 1,2 s                                                  | 22 ms                                      |
| 20 thông báo sau 1 message luôn lỗi       | 1,3 s                                                  | 0,24 s                                     |

Go: cả hai điều kiện của §10 đều đúng. Ghi chú: với 50 event, bản cũ không vào DLQ vì chính việc ngủ trong handler làm queue chậm lại (1 message/giây). Event lỗi về cuối queue và đến lượt lại khi Core đã lên. Trường hợp hay gặp hơn là một thay đổi danh bạ đúng lúc Core restart, và trường hợp đó mất event.

## Quyết định

1. **Delay queue (phương án A của P03).** Lỗi ở lần thứ n đi vào `<queue>.retry.<ms>ms`. Queue này có `x-message-ttl` cố định, dead-letter qua default exchange về `<queue>`, và không ai consume. Handler không ngủ: message kế tiếp chạy ngay. Tên queue chứa thời gian vì TTL của queue không đổi được; đổi thang retry thì tạo queue mới.
2. **Thang retry:** `defaultRetryDelaysMs = [1000, 5000, 30000, 120000, 600000]`. Env `BROKER_RETRY_DELAYS_MS` chỉ nhận tối đa 6 bậc, mỗi bậc từ 1 ms đến 1 giờ, tăng dần; sai thì consumer không khởi động. Mỗi consumer tự khai báo các queue retry của thang nó dùng. `retryBaseMs` của test được giữ làm alias `[b, 2b]`, tức 3 lần như cũ.
3. **Phân loại lỗi:** `TransientError`, `PermanentError`, `permanentOn(codes, also)`.
   - Lỗi vĩnh viễn vào DLQ ngay lần đầu. Clinic: `UNSUPPORTED_EVENT`, `TERMINAL_CONFLICT`, `PrismaClientValidationError`. Notification: `UNSUPPORTED_EVENT` và lỗi validation của Prisma. Envelope sai hoặc loại event không nhận vẫn vào DLQ trước khi `apply`, như cũ.
   - **Khác đề xuất gốc:** lỗi không nhận ra được coi là _transient_, không phải permanent. Nếu retry nhầm một lỗi vĩnh viễn, cái giá là vài lần áp dụng idempotent trong 12,6 phút, và queue không bị chặn nữa. Nếu đưa nhầm một lỗi tạm thời vào DLQ, phải replay tay. Danh sách lỗi transient của Prisma, fetch và hệ điều hành lại khó liệt kê đủ.
   - `DirectorySync` ném `TransientError` khi Core không trả lời hoặc chưa có bản mới.
   - Projector đọc (CQRS, đang tắt) dùng phân loại mặc định.
4. **Header:** `p2-attempt`, `p2-error-code` (chỉ mã UPPER_CASE như `P2002`, `ECONNREFUSED`, `DIRECTORY_SYNC_UNAVAILABLE`; còn lại ghi `PROCESSING_FAILED`, không bao giờ chép thông điệp tự do), `p2-failure` (`transient` hoặc `permanent`).
5. **Giữ nguyên:** chỉ ack bản gốc sau khi bản retry được confirm. Queue retry thiếu → `UNROUTABLE` → đóng channel, bản gốc được giao lại. `replayEvent` đặt `p2-attempt = 0`.
6. **Queue identity:** `topology().identity`; `identity.sessions-revoked.v1` bind vào đó. `declareTopology` gỡ binding cũ trên queue notification (gỡ binding đã không còn thì không báo lỗi). Worker Notification mở hai consumer trên hai channel, dùng chung `NotificationInbox`; một channel đóng thì nối lại cả hai.
7. **Chuyển tiếp:** contracts có `drainingEvents = { notification: ['identity.sessions-revoked.v1'] }`. `consumes()` nhận loại đang rút để message thu hồi còn trong queue cũ vẫn được áp dụng. Inbox dùng chung tên `notification-v1` nên giao trùng qua hai queue vẫn chỉ có một tác dụng. Gỡ mục này khi queue notification ở mọi môi trường không còn message thu hồi.
8. **Fitness rule `event-consumers-explicit`:**
   - loại đang rút phải có consumer khác nhận;
   - queue cũ không còn bind loại đó.
   - `bindings()` không còn đọc nhầm `unbindQueue(` thành binding (regex có `\b`).
   - Có thêm negative fixture.

## Bằng chứng

- Unit `packages/messaging/tests/retry.test.mjs` 4/4 (thang, env sai, phân loại, mã header), chạy trong `npm test` qua `phase2:test:runtime`. Contracts 24/24 (test loại đang rút).
- `phase2:test:integration` 15/15, 3 test mới trên broker thật:
  - Một message luôn lỗi transient và 20 message sau nó, thang `[500]`: cả 20 xong trước lần thử thứ 2 của message lỗi, và hai lần thử cách nhau ≥ 450 ms. DLQ có `p2-attempt=2`, `p2-failure=transient`, mã `PROOF_DEPENDENCY_DOWN`.
  - Lỗi transient 3 lần rồi thành công với 4 bậc: áp dụng, DLQ rỗng. `TERMINAL_CONFLICT`: vào DLQ sau 1 lần gọi, `p2-failure=permanent`.
  - Broker kiểu cũ (thu hồi bind vào queue notification) có một message thu hồi đang chờ. `declareTopology` chạy 2 lần, rồi thu hồi mới đi vào queue identity. Cả hai được áp dụng, DLQ rỗng.
  - Test crash cũ (`afterRepublishConfirm`) giờ chờ bản sao quay về từ queue retry 25 ms thay vì đếm ngay.
- Hồi quy PASS: `npm test`, phase2:build, boundaries, arch:check 10/10, notification-writers, cqrs unit 89/89, notification 6/6, notification-runtime 14/14 (AQ-05 thu hồi phiên), clinic 13/13, billing 12/12, clinic-relay 8/8, core-relay 4/4, request-performance 12/12, resilience 18/18, migration 12/12, UI 23/23, E2E 18/18.
- Teardown của 10 suite lấy danh sách queue của lần chạy từ broker (`brokerQueues`, `topologyQueues` trong `test-project.mjs`). Sau toàn bộ hồi quy, broker test không còn queue retry hay identity nào.

## Trade-off

- Khi dependency dừng lâu, bắt kịp chậm hơn: 50 event sau 10 s dừng xong ở giây thứ 37 (bậc 30 s), trước đây là giây thứ 11. Vẫn trong mục tiêu "≤ 1 phút sau khi Core trở lại" của P03.
- Thứ tự message có thể đổi: message retry quay lại sau message mới hơn. Điều này an toàn theo thiết kế sẵn có: directory có `sourceVersion`, thu hồi dùng `GREATEST`, billing kiểm trạng thái kết thúc, thông báo không cần thứ tự.
- Không dùng delayed retry gốc của quorum queue (RabbitMQ 4.3+): image đang pin 4.1 và queue hiện là classic. Đó là hướng nâng cấp.
- Bước 6 làm ở commit `74de063`:
  - `/metrics` của Clinic và Notification có thêm `retry_ready`; Notification tính cả queue identity vào `queue_ready` và `dlq_ready`.
  - `replay-event.mjs <queue> --all [--max N]` phát lại DLQ theo thứ tự, tối đa 50 event/giây, dừng ở message hỏng hoặc `eventId` đã phát lại.
  - Test: integration 16/16 (thêm test `--all`); resilience kiểm `retry_ready` là số đếm, không phải -1.
  - Billing có một lần FAIL vì worker Clinic thoát trước khi sẵn sàng ngay sau khi broker khởi động lại, rồi PASS ở cả 2 lần chạy lại. Helper giờ ghi mã thoát (`dc6fc2c`).
- Broker dùng chung vẫn giữ các queue retry đã khai báo. Đổi thang retry để lại queue cũ (trống) cần xóa tay.
