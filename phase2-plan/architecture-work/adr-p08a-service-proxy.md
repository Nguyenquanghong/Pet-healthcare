# ADR-P08A — Gateway Core chuyển tiếp qua một ServiceProxy có Circuit Breaker

Ngày 24/10/2026. Trạng thái: ACCEPTED (chuẩn hóa ServiceProxy cho Gateway Core). Phần B (gộp `app.ts`) và C (gỡ code lâm sàng Pha 1) chưa làm.

## Bối cảnh

- `createCoreApp` có hai đoạn proxy viết tay (Clinic timeout 6 s, Notification 4 s), lệch nhau về header và thứ tự kiểm `writableEnded`.
- Chiều gateway → service không có Circuit Breaker. Khi Clinic treo, mỗi request `/api/appointments` giữ một kết nối Core 6 giây rồi mới 503, nên sự cố của Clinic lan sang Core.
- Downstream trả body không phải JSON bị báo thành 503 "unavailable".

## Quyết định

1. `backend/src/phase2/serviceProxy.ts`: `serviceProxy(target)` với cấu hình dạng dữ liệu (prefix, header đi xuống/lên, timeout, câu báo lỗi). Mỗi downstream có một `CircuitBreaker` của `@nipopeto/runtime` (`clinic-gateway`, `notification-gateway`).
2. Tính là lỗi dependency: lỗi transport, timeout, 502/503/504. Không tính: 4xx (trả lời nghiệp vụ), và 503 có `X-Service-Degraded` (service cố ý báo suy giảm và vẫn đang trả lời nhanh; nếu tính thì mọi route của service bị chặn chỉ vì một phần suy giảm).
3. Response 5xx của downstream vẫn đến client nguyên status, header được phép và body.
4. Mạch mở: 503 ngay, giữ câu cũ ("Clinic service unavailable. Retry the same request key."), thêm `Retry-After` (giây của cửa sổ mở) và `X-Service-Degraded: clinic|notification`. Hết cửa sổ thì cho đúng một probe đi qua.
5. Body không phải JSON → 502 `DOWNSTREAM_INVALID_RESPONSE`. Đọc body bị cắt (timeout, mất kết nối) vẫn là 503.
6. Ngưỡng cấu hình bằng env `CLINIC|NOTIFICATION_GATEWAY_BREAKER_FAILURES` (mặc định 5) và `_OPEN_MS` (mặc định 5000), ghi trong `backend/.env.example`. Đặt `FAILURES=100` gần như tắt breaker (rollback).
7. Fitness rule `gateway-uses-service-proxy`: `coreApp.ts` không gọi `fetch(` trực tiếp, và cả hai downstream dùng `serviceProxy`.

## Bằng chứng

- `backend/tests/service-proxy.test.mjs`, viết và chạy xanh trên proxy cũ trước khi đổi (3 test đặc tả: header hai chiều và header riêng tư bị chặn, 204, query DELETE, path `%2e%2e` ra ngoài prefix bị 404, downstream chết → 503 câu cũ). Sau khi đổi thêm 3 test:
  - 3 lần 503 liên tiếp → lần 4 trả 503 ngay, không gọi Clinic, có `Retry-After: 1` và `X-Service-Degraded: clinic`; mạch Notification không bị ảnh hưởng; sau cửa sổ mở, một probe thành công đóng mạch.
  - 10 lần 4xx và 4 lần 503 có `X-Service-Degraded` không mở mạch (ngưỡng 2).
  - Body HTML → 502 kèm mã, cho cả Clinic lẫn Notification.
- `notification-proxy.test.mjs` cũ vẫn PASS không đổi kỳ vọng.

## Trade-off

- Breaker là trạng thái theo process: hai replica Core mở mạch độc lập.
- 503 do Clinic tự trả khi chính nó mất Core directory vẫn được tính là lỗi. Trường hợp này Clinic đã fail nhanh (breaker riêng của nó), nên mạch gateway mở chỉ rút ngắn thêm.
- `app.ts` và `coreDomains.ts` vẫn là hai composition (phần B chờ đã chốt).
