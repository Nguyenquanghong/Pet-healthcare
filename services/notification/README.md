# Notification workspace — P2

API/worker có database và Prisma client riêng. P2 đã kiểm chứng trên stack thử;
chưa chuyển traffic/dữ liệu đang dùng và chưa đạt mốc bàn giao H.

- `GET /api/notifications`: `items/pagination/counts/related`, filter `q/id/status/category`, page 1, mặc định 20, tối đa 100, thứ tự createdAt/id ổn định.
  `category` là tab hộp thư trong `@nipopeto/contracts` (`notificationCategories`): appointments, hotel, medical, billing, rescue, promo. `booking_status_updated` thuộc hotel khi có `relatedBookingId`, ngược lại thuộc appointments. `counts` có `category:<tab>` cho tab khác 0 và `category:all`; số đếm tab không phụ thuộc tab đang chọn.
- `GET /api/notifications/unread-count`: `{ unread, asOf }`; lỗi DB trả 503.
- `PATCH /api/notifications/read-all`, `PATCH /api/notifications/:id/read`, `DELETE /api/notifications/:id`.
- `POST /api/notifications/send`: staff/admin/doctor, body `{recipientOwnerId,title,message}`, header `Idempotency-Key` bắt buộc. Trả 201 sau transaction; key khác content trả 409. Kiểm actor/recipient hiện tại qua Core trước ghi mới; Core lỗi trả 503, không tạo dedup mồ côi. Retry đã commit trả response cũ, kể cả thông báo đã xóa.

Owner chỉ thấy hộp thư của `sub`; staff/doctor/admin dùng hộp thư admin như main.
Query không thay scope. Inbox tồn tại sau delete; replay không hồi sinh thông báo.
Inbox/effect và manual send/dedup đều commit cùng transaction. Dedup chưa có TTL.

API cần `DATABASE_URL` chỉ DB Notification, `PORT` mặc định 5102,
`JWT_PUBLIC_KEY` PEM RSA >=2048 bit, `JWT_ISSUER`, `JWT_AUDIENCE`;
manual send cần `CORE_SERVICE_URL` là origin Core và `NOTIFICATION_SERVICE_TOKEN`
credential riêng dài 32–512 ký tự. Chỉ verify RS256 có exp/issuer/audience/role.
Không cấp private key hoặc HMAC signing secret cho Notification. Core có chế độ
RS256 tương thích; xem [runbook](../../deploy/phase2/notification-runtime.md).
API bind localhost; container/proxy binding và network exposure thuộc P6/P7.
Thiếu cả auth config vẫn có health cho P1, protected API trả 503; cấu hình dở dang
làm startup thất bại. Readiness kiểm Notification/InboxEvent/RequestDedup.

Worker dùng `DATABASE_URL`, `BROKER_URL`, `BROKER_PREFIX` (mặc định `nipopeto.v1`),
không cần khóa ký/token actor. `npm run worker:built -w @nipopeto/notification`.
Durable queues, ACK sau commit, retry/DLQ/selected replay theo runbook P1. ID do
producer tạo; metadata/status/timestamps giữ nguyên, không FK DB khác.

Build rồi dùng `npm run phase2:up`, `npm run phase2:verify` và
`npm run phase2:test:notification-ui` (cần build frontend và Chromium Playwright).
Guard kiểm host/port/project/DB/role/marker trước migrations/writes. Giữ rows/volume;
không dùng seed/reset/down-v. UI tests intercept mọi API; HTTP/PG/broker tests dùng
runtime thật. OpenAPI riêng mô tả sáu paths đã có.

Export/dry-run/import/verify legacy fixture có checksum và resume, giữ ID/read/time,
không overwrite collision. Đây là rehearsal riêng, chưa là migration dữ liệu thật
hoặc quy trình backup/restore P7. [Evidence](../../phase2-plan/evidence/p2-notification.md).
