# 02 — Hợp đồng và nhất quán dữ liệu

Đây là đặc tả triển khai. Payload/schema bên dưới chưa tồn tại trong runtime. P0 phải đối chiếu OpenAPI và client thực tế; mọi thay đổi public contract được cập nhật cùng frontend, OpenAPI và tests.

## 1. Invariant bắt buộc

| ID  | Điều phải luôn đúng                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------- |
| I01 | Owner không xem/sửa dữ liệu owner khác; staff/doctor chỉ có quyền baseline cho phép; không lộ internalNote |
| I02 | Không có hai appointment đang hiệu lực cùng pet/ngày/giờ, kể cả khám với Spa và hai replica                |
| I03 | Tạo bệnh án gắn lịch và hoàn tất lịch cùng transaction; thất bại thì cả hai rollback                       |
| I04 | Một appointment có tối đa một invoice; không xuất hóa đơn cho nguồn chưa đủ điều kiện                      |
| I05 | Invoice đã commit hoặc đang được giữ quyền tạo thì thao tác undo xung đột không thể hoàn tất               |
| I06 | Ghi nghiệp vụ và outbox atomic; consumer tạo dữ liệu và inbox atomic                                       |
| I07 | Retry cùng operation không nhân đôi tác dụng; key cũ với payload khác bị 409                               |
| I08 | Lỗi gửi thông báo không làm mất một transaction nghiệp vụ đã commit                                        |
| I09 | Giữ ID, trạng thái đọc, tiền, ngày giờ, lịch sử revision và liên kết dữ liệu khi migration                 |
| I10 | Core/Clinic/Notification không query trực tiếp DB của nhau trong runtime                                   |
| I11 | Pagination/filter/count chạy trước cắt trang; total không lấy từ độ dài preview                            |
| I12 | Timeout không tự đồng nghĩa ghi thất bại; trạng thái chưa rõ được tra lại bằng operation ID                |

## 2. HTTP công khai

Giữ URL và JSON của các operation cũ, trừ thay đổi additive đã ghi rõ. Collection giữ `{ items, pagination, counts, related }`, page từ 1, mặc định 20, tối đa 100. Giữ sort có ID cuối, filter/status semantics, 422 cho query sai, 401/403/404 theo contract hiện có. History theo từng đơn đang là mảng thì vẫn là mảng.

| API                                                | Thiết kế đích                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/api/appointments/**`                             | Clinic, gồm list/calendar/create/reschedule/cancel/status/history/undo/reminder                    |
| `/api/medical-records/**`                          | Clinic, gồm ảnh; query động/static không được tranh route                                          |
| `/api/notifications/**`                            | Notification; list, send, read-all, read, delete                                                   |
| `GET /api/notifications/unread-count`              | Mới: `{ unread: number, asOf: ISO8601 }`; lỗi trả status lỗi, không `{ unread: 0 }` giả            |
| `GET /api/dashboard/core`, `/api/dashboard/clinic` | Mới: totals và preview giới hạn theo scope; UI tải riêng                                           |
| `GET /api/bootstrap?view=...`                      | Adapter tạm; giữ contract khi còn client sử dụng, có timeout và availability cho phần remote       |
| `POST /api/invoices`, `/api/invoices/checkout`     | Core; giữ response thành công cũ; nguồn appointment đi qua billing protocol                        |
| `GET /api/operations/:id`                          | Mới, Core: chỉ actor được phép; trạng thái pending/succeeded/failed, invoiceId hoặc mã lỗi an toàn |

`/operations/:id` phải được bổ sung vào route map/Nginx. Khi create invoice chưa xác định được kết quả trong request deadline, trả `202 { operationId, status: "pending" }` và Location trỏ operation. Đây là thay đổi public contract có chủ ý; frontend phải chờ/tra kết quả, không hiển thị đã có invoice hoặc tự POST operation mới. Lỗi nghiệp vụ xác định trước commit vẫn trả 4xx. Request thành công thông thường giữ mã/body baseline.

Notification gửi thủ công vào chính Notification DB: kiểm quyền staff và người nhận qua Core, dedup, trả 201 sau commit; không chờ broker. Reminder/rescue tạo outbox ở service nguồn: giữ status phù hợp client nhưng message phải diễn đạt đã tiếp nhận yêu cầu thông báo, không tuyên bố người dùng đã nhận khi mới enqueue.

## 3. Idempotency cho ghi mới

Thêm `Idempotency-Key` cho tạo appointment, bệnh án, gửi thông báo thủ công và tạo invoice/checkout. Giữ cơ chế HotelBookingRequest đang có. UI tạo key một lần cho một ý định người dùng, dùng lại sau timeout, đổi key khi người dùng tạo ý định mới. Không chia sẻ key xuyên tài khoản.

`RequestDedup` tối thiểu: actorId, operationType, key, requestHash, resourceId, responseStatus, responsePayload hoặc con trỏ response, createdAt. Unique `(actorId, operationType, key)`; requestHash từ payload canonical sau validation. Lưu dedup cùng transaction nghiệp vụ; request đồng thời phải đợi hoặc đọc kết quả đã commit, không có bản ghi pending mồ côi do commit tách rời. Giao thức invoice dài hạn dùng Operation riêng bên dưới.

Trong pha 2 giữ dedup suốt thời gian thử nghiệm, chưa tự purge. Nếu sau này đặt TTL, tài liệu phải nêu cửa sổ chống trùng. Không lưu token/password hoặc toàn bộ bệnh án nhạy cảm trong log dedup. Không coi idempotency là thay thế unique appointment slot.

## 4. API nội bộ và quyền

Tên endpoint dưới đây là đề xuất phải đưa vào internal OpenAPI, không công khai qua Nginx.

| Endpoint đề xuất                                           | Owner  | Mục đích                                                                                |
| ---------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| `POST /internal/directory/authorize`                       | Core   | Kiểm actor, quyền owner/pet/staff, trả tối thiểu snapshot và version; batch có giới hạn |
| `POST /internal/directory/lookup`                          | Core   | Lấy related theo danh sách ID đã xác định; không xuất credential/internal notes         |
| `GET /internal/directory/export?cursor=...`                | Core   | Backfill projection theo trang, version; chỉ tài khoản migration/consumer được phép     |
| `PUT /internal/billing-reservations/:operationId`          | Clinic | Prepare idempotent quyền lập invoice trên appointment đủ điều kiện                      |
| `POST /internal/billing-reservations/:operationId/commit`  | Clinic | Finalize từ operation Core đã COMMITTED; event là đường chính, endpoint để đối soát     |
| `POST /internal/billing-reservations/:operationId/release` | Clinic | Chỉ release operation Core đã ABORTED bền vững                                          |
| `GET /internal/billing-operations/:operationId`            | Core   | Đối soát read-only, không gọi Clinic ngược trong request này                            |

Service authentication riêng; token browser không tự có quyền gọi export/commit/release. Timeout outbound cấu hình, có tổng deadline; không retry POST ghi khi chưa có idempotency. Kiểm payload/signature/schema và permission ở service đích dù mạng nội bộ. Correlation ID hợp lệ được chuyển tiếp nhưng không được dùng làm authentication.

## 5. Query, directory projection và quyền sở hữu pet

Clinic cần search theo tên pet/owner mà hiện được join từ Core. Tạo `DirectoryProjection` tối thiểu trong Clinic (loại/id/sourceVersion/display fields/ownerId/deletedAt). Core phát upsert event cùng transaction đổi hồ sơ. Clinic chỉ áp version mới hơn; tombstone không bị event cũ phục hồi. Backfill từ snapshot/cursor rồi catch-up sự kiện, không quét toàn bộ User trong mỗi request.

Thêm revision đơn điệu vào các bản ghi directory nguồn bằng migration mới; mọi đường cập nhật liên quan (profile, pet, activation đổi email, staff nếu có) tăng revision và ghi outbox cùng transaction. Backfill gán revision ban đầu xác định; không dùng `updatedAt` thay revision vì có thể trùng. Chỉ phát các trường thuộc schema công khai nội bộ được chọn, không serialize cả User. Consumer phải subscribe/giữ backlog trước khi export snapshot, rồi áp catch-up theo revision; không có khoảng trống giữa snapshot và bắt đầu nhận event.

Search/count/pagination chạy trên projection trong Clinic DB trước limit. Related chỉ các hàng của trang. Nội dung hiển thị có eventual consistency; thêm metadata `directoryAsOf`/trạng thái stale nếu cần, không đổi nghĩa `pagination.total`. Khi UI vừa sửa pet/owner và cần thấy tên mới, lấy version từ response write và đợi projection đạt version trong thời hạn cấu hình; chưa đạt thì báo đang đồng bộ và reload, không báo ghi thất bại. Không cache response người này trả cho người khác.

Projection phục vụ tìm kiếm, không là nguồn xác nhận quyền. Baseline chưa cung cấp nghiệp vụ chuyển chủ; không tự thêm trong pha 2. Giữ ownerId liên kết lịch/bệnh án như baseline, kiểm actor và bản ghi gốc còn hợp lệ qua Core cho các truy cập cần nó. Đặc biệt ảnh y tế chỉ có petId phải có scope đã xác minh trước trả dữ liệu, total/count cũng không được làm lộ dữ liệu không thuộc scope. Core lỗi thì request cần xác minh trả lỗi tạm thời, không hạ quyền kiểm tra.

Nếu code mới lúc P0 có thêm delete/transfer, phải thiết kế tombstone, authorization epoch và xử lý vòng đời trước cutover. Không tự xóa lịch sử hóa đơn/bệnh án theo FK cascade cũ. Các loại thao tác chưa tồn tại không phải tính năng mới bắt buộc chỉ vì đã bỏ FK liên service.

`mode=unbilled` của appointment truy vấn ngay trong Clinic dựa vào billing reservation: loại cả HELD và INVOICED trước pagination. HELD là đang lập hóa đơn, cần chỉ báo riêng trên UI; ABORTED+RELEASED mới trở lại danh sách. Không gọi Core một lần cho mỗi hàng rồi lọc trang. Hóa đơn Core giữ snapshot lịch sử nguồn; phần UI cần trạng thái hiện tại gọi Clinic theo batch với lỗi riêng.

## 6. Event envelope

Tạo contract mới tại `packages/contracts/events/v1/`; không giả vờ tương thích JSON schema `contracts/notifications/v1` từ nhánh thử nghiệm cũ. Dùng schema validation ở publisher boundary và consumer.

```json
{
  "schemaVersion": 1,
  "eventId": "c828bd04-3076-4c3f-9b25-d29ca5f028ce",
  "eventType": "notification.requested.v1",
  "producer": "clinic",
  "aggregateType": "appointment",
  "aggregateId": "appointment-example",
  "aggregateVersion": 3,
  "occurredAt": "2026-10-11T03:00:00.000Z",
  "correlationId": "request-example",
  "payload": {
    "notificationId": "notification-example",
    "recipientOwnerId": "owner-example",
    "recipientRole": "owner",
    "type": "appointment_reminder",
    "title": "Nhắc lịch khám",
    "message": "Bạn có lịch hẹn tại phòng khám.",
    "actionUrl": "/owner/appointments",
    "relatedPetId": "pet-example",
    "relatedAppointmentId": "appointment-example"
  }
}
```

Ví dụ là dữ liệu giả. Chốt giới hạn message/config, đề xuất 32 KiB cho event nhỏ; không nhét ảnh/base64, mật khẩu, JWT hay nội dung bệnh án chi tiết vào broker. ID notification được tạo từ producer và ổn định khi retry. Một nghiệp vụ có thể phát nhiều event tới nhiều người nhận với eventId/notificationId riêng.

| Event                          | Producer     | Consumer     | Tác dụng                                                       |
| ------------------------------ | ------------ | ------------ | -------------------------------------------------------------- |
| `notification.requested.v1`    | Core, Clinic | Notification | Tạo thông báo theo ID, bao gồm invoice/payment/rescue/reminder |
| `directory.owner-upserted.v1`  | Core         | Clinic       | Projection thông tin owner cho search/related                  |
| `directory.pet-upserted.v1`    | Core         | Clinic       | Projection pet và sourceVersion                                |
| `directory.staff-upserted.v1`  | Core         | Clinic       | Chỉ dữ liệu hiển thị cần cho doctor/audit, không credential    |
| `billing.invoice-issued.v1`    | Core         | Clinic       | Finalize reservation, liên kết invoiceId/source snapshot       |
| `billing.operation-aborted.v1` | Core         | Clinic       | Release đúng operation không thể commit nữa                    |

Không yêu cầu tự động nhắc tiêm định kỳ nếu baseline chỉ có reminder thủ công. `aggregateVersion` phải có ý nghĩa đơn điệu trong từng aggregate; không dùng timestamp làm giải pháp chống thứ tự sai. Notification có thể hiển thị theo occurredAt + ID, không yêu cầu thứ tự delivery toàn cục; directory và billing dùng version/state để từ chối event cũ.

## 7. Outbox, inbox và RabbitMQ

Outbox trong mỗi producer: id/eventId unique, aggregate/type/version, payload, createdAt, publishedAt, attempts, nextAttemptAt, leaseOwner, leaseUntil, lastErrorCode. Index phục vụ pending/nextAttemptAt. Nghiệp vụ lưu outbox cùng transaction DB; API trả sau commit, không đợi network broker.

Relay claim batch bằng khóa hàng `FOR UPDATE SKIP LOCKED`, đặt lease rồi commit transaction ngắn; publish ngoài transaction. Chỉ chủ lease hiện hành được cập nhật publishedAt; lease hết hạn cho phép worker khác gửi lại. Broker persistent message, durable exchange/queue và publisher confirms; xử lý message unroutable (`mandatory`/return) như chưa publish thành công. Không đánh dấu đã gửi chỉ vì client library nhận buffer. Khi crash sau confirm trước marking, gửi lại là bình thường.

Mỗi consumer có queue riêng, manual ACK sau DB commit. Inbox unique `(consumerName,eventId)` cùng transaction tạo notification/update projection. Duplicate ACK an toàn; nếu xóa notification rồi replay event cũ thì inbox vẫn ngăn tái tạo. Lỗi DB/network transient retry có backoff, không vòng requeue nóng; quá lần đưa DLQ. Schema/version không hợp lệ vào DLQ với lý do an toàn.

Với retry/DLQ do ứng dụng republish: chỉ ACK message gốc sau confirm rằng bản retry/DLQ được broker nhận. Crash có thể trùng nhưng không được mất. Nếu dùng broker DLX phải kiểm chứng cấu hình/version và khả năng giao lại trong topology thực, không mặc định mọi dead-letter đều đảm bảo bền vững. Script replay giữ nguyên eventId, rate limit và audit; không replay toàn queue mù quáng.

Một broker local không phải HA. Chứng minh restart có volume phục hồi và consumer catch-up; không tuyên bố chịu mất host. Publisher confirm xác nhận broker, consumer ACK xác nhận xử lý: hai cơ chế khác nhau.

## 8. Giao thức hóa đơn appointment

### 8.1 Dữ liệu và state machine

Core `BillingOperation`: operationId, actorId, idempotencyKey, requestHash, appointmentId, expectedRevision, payload chốt phí đã validate, state, invoiceId, timestamps. State chỉ đi `PREPARING → COMMITTED` hoặc `PREPARING → ABORTED`; không hồi sinh ABORTED. Unique idempotency theo actor/type; không cho nhiều operation đang PREPARING cho cùng appointment. Invoice vẫn có unique appointmentId.

Clinic `BillingReservation`: operationId unique, appointmentId, revisionAtPrepare, source snapshot, invoiceId, state. State `HELD → INVOICED` hoặc `HELD → RELEASED`; một appointment chỉ có một reservation HELD/INVOICED. Retry cùng operation phải trả snapshot cũ dù revision sau prepare đã đổi vì ghi audit. RELEASED không được prepare lại cùng operation.

Mọi mutation appointment xung đột (undo/cancel/reschedule/status và các thao tác làm thay đổi tính hợp lệ nguồn) kiểm reservation dưới cùng khóa hàng appointment. Không xóa/đổi bệnh án hay thông tin nguồn làm vô hiệu hóa invoice đã chốt; giữ quy tắc baseline, thêm guard khi cần và test rõ.

### 8.2 Luồng chuẩn

```mermaid
sequenceDiagram
  participant UI
  participant Core
  participant Clinic
  participant MQ as Broker
  UI->>Core: POST invoice + Idempotency-Key
  Core->>Core: Transaction tạo BillingOperation PREPARING
  Core->>Clinic: prepare(operationId, appointmentId, revision, actor)
  Clinic->>Clinic: Lock appointment, kiểm completed/quyền, lưu HELD
  Clinic-->>Core: Snapshot nguồn + reservation
  Core->>Core: Lock operation PREPARING; tạo invoice + COMMITTED + outbox
  Core-->>UI: Invoice đã commit
  Core->>MQ: invoice-issued qua outbox relay
  MQ->>Clinic: Finalize idempotent thành INVOICED
```

Core không giữ transaction SQL trong lúc gọi Clinic. Clinic prepare không gọi ngược Core: request đã có service credential và actor context được xác minh, Clinic kiểm quyền theo dữ liệu nguồn. Mutation và reservation có một thứ tự lock nhất quán.

Nếu không có expectedRevision trong public input cũ, Core có thể lấy snapshot/revision Clinic rồi prepare đúng version; nếu thay đổi giữa hai bước phải retry có kiểm soát hoặc trả conflict. Không bỏ revision guard. Giá và quyền chốt phí vẫn do backend xác định; tự checkout Spa giữ bảng giá hiện tại; khám do staff chốt như baseline.

### 8.3 Crash, cancel và reconcile

| Điểm lỗi                             | Trạng thái bền vững              | Xử lý                                                                    |
| ------------------------------------ | -------------------------------- | ------------------------------------------------------------------------ |
| Trước prepare                        | Core PREPARING, Clinic chưa HELD | Retry cùng ID                                                            |
| Sau HELD, trước Core commit          | PREPARING + HELD                 | Reconciler resume hoặc CAS Core sang ABORTED rồi release                 |
| Core commit nhưng mất HTTP response  | COMMITTED + invoice              | Retry/get operation trả invoice cũ, không tạo mới                        |
| Event finalize chưa tới              | COMMITTED + HELD                 | Vẫn chặn undo; relay/reconciler đưa về INVOICED                          |
| Release message tới sau finalize     | COMMITTED/INVOICED               | Từ chối release trái state; báo invariant violation nếu dữ liệu bất nhất |
| Prepare cũ tới sau khi Core đã abort | ABORTED, Clinic có thể mới HELD  | Reconcile đọc Core ABORTED rồi release; không commit được invoice        |

Abort transaction khóa cùng BillingOperation với transaction tạo invoice. Worker commit chỉ thành công nếu còn PREPARING; worker abort chỉ thành công nếu còn PREPARING. Nếu commit thắng, abort trả COMMITTED và không release. Nếu abort thắng, mọi late commit phải thất bại. Release Clinic chỉ thực hiện sau khi Core đã bền vững ABORTED, bằng sự kiện tin cậy hoặc đối soát read-only; timeout/404 chưa đủ bằng chứng để release. Giữ operation terminal đủ lâu cho replay, không xóa ABORTED ngay.

Reconciler có lease tránh nhiều worker tranh nhau, retry bounded và audit. Không có transaction phân tán hay cam kết exactly-once delivery; các trạng thái cùng unique constraints tạo tác dụng idempotent. Unknown/pending lâu phải hiển thị rõ và có thao tác tra lại, không sửa tay trạng thái trong DB để demo.

Hotel billing/checkout vẫn ở Core và giữ transaction/lock hiện có. Không biến nó thành giao dịch phân tán không cần thiết.

## 9. Tương thích và chuyển dữ liệu

Mỗi service sở hữu schema/migration từ khi cutover. Không sửa lại nội dung migration lịch sử đã áp dụng. Lập bảng nguồn→đích cho từng model, field, index, FK, history kind và timestamp. Bỏ FK xuyên DB chỉ sau khi có validation/authorization tương đương, không bỏ unique/check còn hợp lệ nội bộ.

Trong giai đoạn chuyển, legacy tables chỉ còn là bản lưu read-only sau mốc cutover; runtime không có dual writer. Script migration là công cụ có quyền đặc biệt dùng riêng cho dữ liệu thử đã xác nhận, không import vào application. Kế hoạch cutover và rollback chi tiết ở file 04.
