# ADR-F7 — Mỗi consumer liệt kê từng event nó áp dụng; kết cục billing tường minh

Ngày 24/10/2026. Trạng thái: ACCEPTED (chuẩn hóa danh mục event consumer). Commit `525f8b9`.

## Bối cảnh

- F7 : inbox Clinic so `eventType === 'billing.invoice-issued.v1'`, mọi event `billing.*` khác bị coi là hủy (`ABORTED`, giải phóng chỗ giữ).
- Consumer trong `@nipopeto/messaging` nhận cả họ `billing.*` và `directory.*` theo tiền tố. Thêm một event mới, ví dụ `billing.invoice-voided.v1`, vào `eventTypes` thì Clinic sẽ âm thầm giải phóng reservation của một hóa đơn còn hiệu lực.

## Quyết định

1. `packages/contracts` có `consumedEvents`: danh sách từng event của mỗi consumer (`notification`, `clinic`, `clinic-read-v1`) và hàm `consumes(consumer, type)`. `ConsumerName` của messaging lấy từ đây; consumer kiểm `consumes(...)` thay cho so tiền tố.
2. Clinic có `services/clinic/src/billingEvents.ts`: mỗi event billing ánh xạ tới một kết cục (`terminal` COMMITTED/ABORTED, `reservation` INVOICED/RELEASED). Inbox từ chối (`UNSUPPORTED_EVENT`, đi DLQ) event billing không có ánh xạ, thay vì coi là hủy.
3. Fitness rule `event-consumers-explicit` trong `check-architecture-rules.mjs`:
   - mọi type khai báo có ít nhất một consumer;
   - mọi type của một consumer đã khai báo và được bind vào queue của consumer đó;
   - mọi event billing Clinic tiêu thụ có kết cục, và ngược lại.
   - Có negative fixture cho từng điều.
4. Binding broker (`directory.#`, `billing.#`) giữ nguyên: đó là định tuyến. Quyết định áp dụng hay không nằm ở danh sách consumer.

## Bằng chứng

- Contracts 18/18 (thêm `consumers.test.mjs`: mọi type có consumer, `consumes` không nhận theo tiền tố).
- Mutation: xóa `billing.operation-aborted.v1` khỏi `dist/billingEvents.js` → rule FAIL; khôi phục → PASS.
- Hồi quy PASS: billing (cả hai kết cục trên Postgres + broker thật), clinic, notification, integration, clinic-relay, core-relay, resilience, notification-runtime, arch:check, cqrs unit.

## Trade-off

- Đây chưa phải danh mục event đầy đủ của P07 (schema payload, producer, binding sinh từ một bảng). Ba nơi vẫn phải sửa khi thêm event: `eventTypes`, `consumedEvents`, binding. Rule mới bắt mọi chỗ quên.
