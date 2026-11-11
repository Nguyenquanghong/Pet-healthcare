# ADR-CQRS-05 — Cache aggregate với invalidation cùng transaction nguồn

Ngày17/10/2026. Candidate Q6; chưa ACCEPTED_FOR_DEPLOYMENT. Default authoritative; không đổi budget, policy hoặc CQRS consistency contract.

## Vấn đề và quyết định

Native v5 bị cancellation ở counts/calendar. Sàng lọc SQL (`q6-query-shapes-20261017.md`) cho thấy đổi JOIN/EXISTS không giảm đủ công việc quét100k rows. Thay vì cache toàn response hoặc bỏ ACL, cache riêng kết quả aggregate đã kiểm nguồn, trong memory của một ServingAppointmentQueries/database instance. Tối đa128 entries, idle TTL5s (hit chỉ gia hạn sau kiểm epoch); không cache DTO, token, auth decision, lỗi, unbilled hoặc command. TTL chỉ quản lý bộ nhớ/entry ít dùng, không phải cơ chế đảm bảo đúng dữ liệu.

Một migration additive tạo `AppointmentQueryEpoch` gồm ba scope và revision bigint độc lập. Database trigger tăng revision trong cùng transaction với mutation:

| Scope      | Writer làm đổi epoch                                                      |
| ---------- | ------------------------------------------------------------------------- |
| source-acl | INSERT/DELETE/TRUNCATE Appointment; UPDATE thực sự đổi id/owner_id/pet_id |
| projection | INSERT/UPDATE/DELETE/TRUNCATE AppointmentReadRow, mọi field/generation    |
| directory  | INSERT/UPDATE/DELETE/TRUNCATE DirectoryProjection, mọi field              |

Statement triggers cho bulk operations; source UPDATE dùng row trigger với OLD/NEW comparison. Bao phủ runtime, projector, rebuild/import và direct SQL hợp lệ, không phụ thuộc writer nhớ gọi helper. Revision không dùng statusRevision, outbox ID, notification hoặc timestamp. Rollback cả data lẫn epoch. Không reset epochs khi rebuild/activate; bigint overflow hoặc guard thiếu khiến mutation fail closed, cần operator sửa trên trial trước khi deploy.

## Điều kiện hit và quyền

Projected serving bắt đầu transaction READ ONLY/RepeatableRead. Control/generation, freshness và token check vẫn chạy trước reader. Aggregate cache đọc đủ ba epoch trong chính snapshot đó, xác minh read-only/isolation; thiếu bảng/row, revision không hợp lệ hoặc lỗi DB không được dùng entry cũ. Key gồm actor role/id, cả ba revision, SQL shape và bindings (gồm generation, scope và mọi filter). Giá trị trả ra được clone; cache không dùng chung giữa DB/client instances.

Cache miss chạy nguyên SQL JOIN Appointment nguồn rồi mới group/count. Cache hit tái sử dụng aggregate của cùng tập dữ liệu/ACL: bất kỳ thay đổi ảnh hưởng predicate hoặc grouping nào đều phải thay ít nhất một epoch trong cùng commit. Không có mutation liên quan giữa hai snapshot cùng epoch thì kết quả aggregate vẫn bằng truy vấn JOIN nguồn ở snapshot hiện tại. Source ACL epoch là bằng chứng từ authority, không phải projection tự cấp quyền. Request bắt đầu trước một ACL commit giữ snapshot cũ như semantics RepeatableRead đã có; request sau commit đọc epoch mới và không hit entry cũ.

Miss cùng key được gộp sau khi từng caller đọc/kiểm epoch của snapshot riêng. Miss khác key tính lần lượt trong một serving instance để tránh nhiều full scan tranh CPU lúc cache trống; tối đa4 waiter, chờ admission tối đa200ms bên trong deadline transaction hiện tại. Không tăng DB pool, statement200ms, maxWait50ms hoặc deadline1250ms/RYW500ms. Quá hạn/lỗi không cache và đi fallback nguyên query; không queue vô hạn, không retry SQL hoặc trả entry epoch cũ khi busy.

Projected snapshot đặt LOCAL `max_parallel_workers_per_gather=1`, cùng force_custom_plan hiện có. Một worker riêng lẻ từng chưa ổn định ở sàng lọc trước; chỉ phối hợp với cache/idle TTL/coalescing mới đạt hai lượt360/360 trong phép thử2CPU hiện tại. Không suy từ phép đo đó rằng tăng worker luôn sai hoặc Q6 native đã PASS; giữ cả dữ liệu candidate chưa đạt.

Đây là phần bổ sung có giới hạn cho yêu cầu JOIN/EXISTS mỗi aggregate ở [ADR03](adr-cqrs-03.md): chỉ được bỏ thực thi lại aggregate khi có bằng chứng epoch đầy đủ; không bỏ JOIN ở SQL miss. Items vẫn JOIN nguồn trước paging trong mọi request. Core auth/owner scope, directory request-local, redaction và limiter vẫn thực thi mỗi request. Header/token/fallback không đổi; lỗi guard đi qua fallback toàn query với budget hiện tại. Không dùng kết quả cache trong write transaction, tránh lưu revision chưa commit rồi tái dùng sau rollback.

## Lock, triển khai và rollback

Cập nhật sau native v6 FAIL,17–18/10: candidate thêm admission **trước** transaction ở `ServingAppointmentQueries`. Một projected transaction/reader, FIFO tối đa4 waiter, chờ trong phần deadline request còn lại. Mỗi waiter chưa giữ connection/snapshot; sau được nhận mới đọc control/generation/token/freshness/epoch và source ACL trong snapshot mới. Giữ slot đến khi Prisma transaction resolve/reject, gồm commit/rollback; nhả trước fallback hoặc RYW poll tiếp theo. Forced-source unbilled không đi qua gate projection, vẫn dùng admission fallback2 như cũ. Deadline projected1250ms/RYW500ms tính cả hàng chờ; trừ wait trước cấu hình transaction, maxWait50ms/statement200ms không tăng. Mốc admission200ms của candidate offline17/10 đã gây fallback ở trial18/10: nó giới hạn chờ cả snapshot như một câu SQL. Bản hiện tại dùng deadline request sẵn có, không cộng budget mới hay nới timeout SQL.

Trong serving instance, gate bảo đảm chỉ một caller vào aggregate cache, nên các request không còn chờ cache miss đồng thời trong nhiều transaction. Guard coalescing/serialization của cache vẫn giữ cho các caller nội bộ/kiểm thử dùng cache trực tiếp; không chia sẻ instance cache giữa các serving reader hoặc database. Admission serialize cả projected reads đã cache, gồm page/directory work: có rủi ro head-of-line blocking và giảm throughput dưới tải. Queue đầy/hết hạn đi fallback hiện có, không trả cached snapshot cũ hoặc retry SQL. Offline17/10 (`q6-admission-offline-20261017.md`) và PostgreSQL18/10 (`q6-admission-postgres-20261018.md`) ghi các lượt FAIL/PASS; native candidate mới vẫn cần kiểm.

Freshness background đặt LOCAL `max_parallel_workers_per_gather=0` cho full registry/read-row audit, hạn chế số process cạnh tranh CPU lúc foreground cold query. Không giảm phạm vi audit, không cache diff/heartbeat, không đổi broker probe/cadence2s/statement750ms/transaction1500ms/lag5000ms/age6000ms. Giảm parallel fan-out có thể làm audit chậm hơn trên workload khác; timeout/failure vẫn xóa evidence, cần đo PCN/mixed writes trước nghiệm thu.

Telemetry thêm `projection-admission`, `projection-setup` và các event admission/cache theo allowlist. Event thành công/hit/miss/wait chỉ lấy mẫu đầu mỗi operation/event, vẫn giới hạn512+terminal; không có actor/epoch/key/SQL/params. Dùng để phân biệt giai đoạn và thấy một hit/miss, không coi đây là đầy đủ cache-hit ratio hoặc thống kê pool wait.

Ba scope dùng ba row riêng để không buộc directory/source/projector tranh cùng một row. Trigger UPDATE giữ lock epoch đến commit; source status/note/date mutation không đổi ACL không lấy source-acl lock. Có thêm serialization cho source create/delete/reassignment và projection/directory writes: phải tính vào write latency/CPU ở Q6 O/A/B; local read gain không đóng gate đó. Giữ lock protocol source→registry và projector registry→control→MVCC source; cache read chỉ SELECT, không giữ write lock.

Trigger function SECURITY DEFINER, `search_path=pg_catalog`, tên bảng được qualify từ TG_TABLE_SCHEMA; projector không cần UPDATE epoch. Role runtime/operator có quyền schema vẫn thuộc trust boundary cũ. Không cấp quyền công khai mới. Dừng/drain writers khi apply migration ở môi trường được giao; rollout chưa được giao. Restore DB hoặc thay database target cần restart process để bỏ memory cache, như thay client/database hiện tại.

Rollback đọc về authoritative; không drop bảng/trigger trong lúc còn process có cache. Có thể rollback code cache sau drain/restart, giữ migration additive. Không ghi projection ngược vào source, không tăng quota/pool/timeout, không Q7.

## Cập nhật v8 — 18/10/2026

Full attempt v7 (`q6-v7-full-attempt-20261018.md`) vẫn cancellation khi cache lạnh. Candidate v8 và evidence (`q6-bounded-aggregate-20261018.md`) bổ sung chia aggregate rộng theo khoảng khóa generation/appointmentId, tối đa50.000 vị trí read row/phần, trong cùng snapshot READ ONLY/RepeatableRead. Boundary lookup gồm tombstone để dùng primary key; aggregate vẫn loại deletedAt và kiểm source ACL đầy đủ. Khoảng rời nhau `(lower, upper]`, cuối không upper, không giả định phân bố UUID. Không trả hoặc cache một phần nếu phần sau lỗi/hết deadline.

List admin/staff không search/scope riêng và calendar chia sẻ aggregate status/date/type +billingHeld. Date/category được áp vào các nhóm chính xác, status/statusGroup vẫn chỉ tác động total/paging theo contract. Cache key chứa actor, generation, SQL và ba epoch; filters dẫn xuất từ nhóm không tạo quyết định quyền mới. Search rộng giữ predicate riêng và chia khoảng; owner/ownerId/petId/id giữ truy vấn riêng. Items luôn JOIN nguồn, unbilled authoritative. Mọi cache hit vẫn kiểm epoch trong snapshot hiện tại, kể cả sau ACL commit.

Giới hạn FIFO **hiện tại là8 waiter**, thay4 của candidate v7 mô tả phía trên. V8 queue4 đạt598/600 khi dịch thời điểm freshness; hai request bị từ chối vì queue đầy. Tăng queue8 cho phép chúng chờ trong deadline cũ, vẫn một active projected transaction/reader, không giữ connection/snapshot khi chờ. Không tăng SQL200ms/maxWait50ms/request1250ms/RYW500ms/pool/rate. Guard nội bộ cache4waiter/200ms không đổi. Không làm nóng aggregate trước cold test.

Đổi lại, chia query tăng round trips; aggregate toàn bộ ngày có thể giữ nhiều nhóm hơn query tháng; serialize và8waiter vẫn có rủi ro head-of-line. 600/600 cold +720/720 release local chưa chứng minh native capacity hoặc tổng CPU/write overhead. Collector v2 ghi đủ các phần aggregate, không coi thời gian từng EXPLAIN là end-to-end. Không thêm migration ở v8; schema/epoch triggers giữ nguyên. Native smoke/full/equal-budget vẫn bắt buộc; default authoritative, chưa chấp thuận deployment.

## Candidate v9 — thử nghiệm ngày19/10 và cấu hình cuối ngày20/10

Các đoạn ngày19/10 dưới đây ghi lại candidate trung gian25k/queue8. Cấu hình cuối40k/source/serial/queue16 nằm ở đoạn ngày20/10; evidence v9 (`q6-range-indexes-20261020.md`) giữ kết quả cả các phương án không đạt.

Cập nhật candidate v9 ngày19/10: native v8 (`q6-v8-smoke-result-20261019.md`) còn cancellation khi cache lạnh. Giảm range từ50k xuống25k **kết hợp** hai covering index không unique ở migration `20261019000100_appointment_aggregate_range_indexes`: source `(id) INCLUDE(owner_id,pet_id)` và read row `(generation,appointmentId) INCLUDE(ownerId,petId,status,billingHeld,appointmentDate,type) WHERE deletedAt IS NULL`. Prisma schema ghi chú vì chưa biểu diễn được INCLUDE/partial predicate. Không INCLUDE serviceName/notes, không đổi source ACL predicate hoặc command semantics. Boundary vẫn dùng primary key bao gồm tombstone; aggregate loại tombstone và JOIN nguồn như trước.

Chỉ giảm range mà thiếu index đã FAIL592/600 ở trial do admission pressure. Kết hợp index đạt600/600 trên trial hiện có; không suy ra native hoặc bulk-write capacity. Index tăng dung lượng, WAL và chi phí source/projector writes; lợi ích index-only scan phụ thuộc visibility map, còn việc chọn plan phụ thuộc thống kê. Phải giữ bằng chứng stress khi vừa ghi nhiều dữ liệu, không bỏ qua FAIL hoặc giả định VACUUM luôn có sẵn. Migrations chỉ apply trên trial đã kiểm marker, không live deployment. Giữ queue8, SQL200ms, request1250ms/RYW500ms, pool/rate và full freshness audit. Rollback đọc về authoritative có thể giữ index additive; gỡ index chỉ trong maintenance được giao sau drain.

V9 tiếp tục đổi boundary lookup sang primary key `appointments.id`: mọi hàng đóng góp aggregate đều INNER JOIN với một source ID, nên phân hoạch source IDs thành các khoảng rời nhau vẫn bao phủ đúng mọi hàng đóng góp. Source thiếu projection hoặc projection đã xóa có thể chiếm một vị trí duyệt nhưng không thêm count; projection thừa/nguồn đã xóa không thể đóng góp do JOIN. Boundary chỉ là metadata nội bộ, không cấp quyền; từng SQL vẫn kiểm owner/pet và mọi filter, tất cả trong cùng RepeatableRead. Cách này tránh duyệt lại heap read model vừa rebuild khi visibility map còn trống. Bảng nguồn vừa ghi hàng loạt vẫn là trường hợp cần đo riêng; không giả định index luôn index-only.

Telemetry thêm ba stage cố định cho boundary/aggregate đầu/aggregate tiếp theo, không chứa ID dữ liệu hoặc SQL. Deadline được kiểm lại sau boundary lookup trước khi bắt đầu aggregate. Wrapper Python nhận collector version1/2 và giữ đủ các phần plan. Các thay đổi này không sửa gate benchmark; Q6 vẫn cần native smoke/full/equal-budget và write overhead trước nghiệm thu.

Điều chỉnh candidate ngày20/10: cấu hình cuối đang kiểm dùng **40k source IDs/range, LOCAL max_parallel_workers_per_gather=0 và16 waiter trước transaction**. Sàng lọc trên read rows vừa dựng cho thấy40k giảm số round trips và tổng chi phí so25k; serial giảm fan-out CPU với freshness. Bản40k/serial/queue8 đạt598/600, hai lỗi còn lại đều admission reject ngay khi queue đầy, không phải SQL timeout. Queue16 cho request còn deadline được chờ; vẫn một active transaction, không thêm connection, giữ SQL200ms/maxWait50ms/request1250ms/RYW500ms/rate. Không coi đây là tăng capacity đã được chứng minh: hàng chờ dài hơn có thể tăng tail latency, mọi waiter hết hạn phải bị loại trước mở snapshot. Unit kiểm đủ16 waiter không giữ DB connection, FIFO, từ chối waiter17, giữ slot tới commit/rollback và hủy đúng deadline.

Unit bounds/key/epoch/failed SQL/read-only; PostgreSQL parity đầy đủ, đổi owner/pet/xóa/tạo nguồn, projection billing/date/tombstone, directory rename, rollback và concurrent commit; restricted projector role; HTTP Core revocation/redaction/token/freshness; tải ABBA với cache khởi đầu rỗng và freshness nền. Sau đó mới native smoke query-heavy/PCN; full matrix và equal-budget/write overhead vẫn bắt buộc để nghiệm thu Q6.
