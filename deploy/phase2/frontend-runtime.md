# P5 — Frontend theo màn hình trên ba service

**Cấu hình runtime đích hiện tại ở [P6 auth/resilience](resilience-runtime.md).**
Các credential/env P2–P5 bên dưới là compatibility proof lịch sử; không dùng
chúng để deploy target. `phase2:verify` hiện gồm P1–P6 và E2E thật, cần Redis
và Nginx; trên Windows chạy `npm run phase2:prepare:nginx` trước.

Frontend React/TypeScript dùng Core `/api` làm gateway. Core, Clinic & Scheduling,
Notification vẫn là ba service đã chọn; không thêm service hoặc đổi framework.
Đây là runbook thử riêng, chưa bật cutover dữ liệu/traffic đang dùng.

## Chạy lại

Từ root với Node 24 và Docker đang chạy:

```powershell
npm run phase2:up
npm run phase2:verify
npm test
npm run phase2:test:notification-ui
```

Riêng browser: build các backend bằng `npm run phase2:build`, rồi chạy
`npm run phase2:test:e2e`. Cần Chromium của Playwright đã cài. Runner tự build
frontend với `VITE_API_BASE_URL=/api` cho proxy thử; không sửa `.env` của bạn.
Không dùng suite E2E mặc định có credential/demo URL cũ để thay suite này.

Runner xác minh đúng Compose project, bind PostgreSQL 127.0.0.1:55432, ba database,
ba role và marker trước migrate deploy/fixture. Không seed/reset/truncate hoặc
xóa volume. API/process dùng port trống; proxy browser chỉ bind 127.0.0.1:5189,
không có HTTP debug/control endpoint. Browser chặn URL ngoài proxy thử.

Fixture UUID có owner/admin/customer tại quầy, 21 pets và một owner khác. API
request dùng login/hash/authorization thật. Relay dùng production adapters, chỉ
publish aggregate mới của run; Clinic/Notification consumers dùng RabbitMQ thật.
Core reconciler gọi Clinic HTTP và SQL thật. Queue phải hết ready **và** unacked
trước teardown; lỗi giữ lại và làm runner thất bại. Cleanup chỉ queue rỗng của
run, dừng process do runner tạo và giữ DB/volumes/synthetic rows.

Limiter `/auth` cũ còn tính `/me` trong quota 50/15 phút. Runner khởi động lại
đúng Core process thử giữa các ca, giữ SQL/signing keys, và cache token API helper
để không đăng nhập lại mỗi lần poll. Đây là cô lập ca kiểm thử; chưa chứng minh
limiter nhiều replica hoặc tải same-IP. Việc đó thuộc P6, không tăng quota hay
bỏ limiter trong code hiện tại.

Artifacts cục bộ nằm dưới `test-results/phase2/` và `test-results/phase2-e2e/`
(ignored). Fixture file chứa credential/token thử; không copy chúng vào evidence.
Network evidence chỉ lưu method/path/status/count, không headers hoặc body.

## Runtime và dữ liệu

- `SessionContext` chỉ giữ identity/auth. `/auth/me` lỗi tạm giữ token và có retry;
  401/404 xóa phiên. Session epoch, abort và remount query/form state ngăn response
  cũ xuất hiện sau logout/login. Mutation đang commit vẫn được backend xử lý theo
  actor gốc; nó không đưa dữ liệu vào UI phiên mới.
- Dashboard dùng `/dashboard/core` và `/dashboard/clinic` riêng. Vùng lỗi có
  loading/error/retry; unknown dùng `—`. Dữ liệu đã tải được giữ cùng thời điểm
  tải khi refresh lỗi. `asOf` là thời điểm đọc/tải vùng, không phải snapshot chung
  của cả ba database.
- Một unread query dùng chung header/sidebar/inbox, poll riêng 20 giây có jitter,
  backoff và điều kiện visible/online. Billing list poll riêng 15 giây; pending
  operation tiếp tục cơ chế P4. Không có timer hoặc bootstrap toàn cục.
- List/detail/PagedSelect đọc theo query/page/filter; search debounce 250ms,
  request cũ abort, response kiểm session/query/sequence. Selection qua trang khác
  có request detail riêng. Xóa dòng cuối tự clamp page từ totalPages của server.
- Mutation invalidate các query đang mount của domain liên quan. Notification
  lỗi không làm refresh khám/bệnh án thất bại. Lưu thành công nhưng reload lỗi
  giữ trạng thái đã lưu; retry đọc không gửi lại POST.
- Clinic DTO/authorization đọc Core hiện tại. Projection chỉ dùng search;
  selected pet trả `directory` source/projection version và `searchReady`.
  UI báo đồng bộ khi tên mới chưa searchable; không dùng projection cấp quyền.
- `/bootstrap` còn là adapter cho caller cũ. Clinic/Notification lỗi trả region
  unavailable và count unknown/null; không lấy unread từ bảng Notification Core.
  Frontend P5 đã không còn caller bootstrap.

## Triển khai/rollback

P5 không có migration mới. Hai dashboard GET và metadata list/partial bootstrap
đã thêm vào OpenAPI. Deploy Core/Clinic contract trước frontend P5. Ngân hàng,
VNPay, historical backfill, restore và live cutover chưa được kiểm bằng runbook.

Có thể quay UI về bản P4 trong thử nghiệm khi adapter vẫn khỏe; P4 restore gắn
bootstrap nên vùng lỗi có thể làm mất phiên UI. Không quay Core về clinical
writer cũ sau khi Clinic đã nhận ghi. Rollback data ownership phải theo P7 và
[billing runbook](billing-runtime.md), không drop bảng hoặc đổi traffic tự động.

[Evidence](../../phase2-plan/evidence/p5-frontend.md),
[STATUS](../../phase2-plan/STATUS.md).
