# P7 — Di chuyển dữ liệu và diễn tập cutover

Ngày 12/10/2026. Làm tuần tự trên main/add596e4488e3cac2584115874c2f65a97af7047. Dữ liệu tổng hợp trên database P7 mới của project
pet-phase2-p1-test; DB/config/traffic đang dùng và 18 file local ban đầu được giữ.
Kết quả cuối và lịch sử FAIL nằm trong [test history](test-results.md).

## Code chạy được

- [Environment/guard](../../tools/phase2/p7-environment.mjs): context gắn UUID,
  marker, host/project cố định; mỗi component một DB và role không sở hữu bảng.
- [Manifest/transport](../../tools/phase2/p7-manifest.mjs),
  [migration](../../tools/phase2/p7-migration.mjs) và
  [CLI](../../tools/phase2/migrate-p7.mjs): export/dry-run/import/validate,
  checksum/catalog, transaction và journal resume từng service.
- [Cutover ledger](../../tools/phase2/p7-cutover.mjs): fence nguồn, quyền bảng đích,
  advisory lock chung, rollback trước mở ghi và forward-fix sau mở ghi.
- [Suite thực](../../tools/phase2/p7-rehearsal.test.mjs): monolith source + ba API
  đích, bốn worker, PostgreSQL/RabbitMQ/Redis và gateway Nginx riêng; không mock.
- [Cài lại riêng](../../tools/phase2/clean-local.mjs): copy source dirty có hash,
  npm ci, npm test, build ba service và P7; không ghi đè client/dist gốc.
- [Runbook](../../deploy/phase2/migration-runtime.md),
  [field manifest](p7-field-manifest.json), [reconciliation](p7-reconciliation.json).

## Quyền sở hữu và đối chiếu

| Model nguồn                                        | Đích/đối chiếu                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| User, OwnerActivation, Pet                         | Core; ID, hash/salt, activation metadata, directory revision giữ nguyên; credential chỉ ở Core      |
| Appointment                                        | Clinic; mọi 10 loại khám/Spa, owner/pet/doctor, date/time/status/revision và note                   |
| MedicalRecord                                      | Clinic; liên kết lịch khám completed, decimal, ngày tái khám, internal note/redaction               |
| MedicalImage                                       | Clinic; giữ URL/MIME/timestamp, thêm owner từ Pet nguồn                                             |
| HotelBooking, HotelBookingRequest, DailyCareNote   | Core; ngày/số đêm/tiền/service keys/request key và private care note                                |
| BookingStatusEvent                                 | appointment→Clinic, hotel→Core; giữ actor snapshot/revision/reversesId và timestamp                 |
| RescueReport                                       | Core; giữ finder/location và pet liên quan                                                          |
| Invoice, InvoiceItem, PaymentAttempt, PaymentEvent | Core; ID/code/tiền/status/history/timestamp/JSON giữ nguyên; sequence tránh trùng code              |
| OutboxEvent                                        | Core nguồn monolith; giữ cả published/pending, eventId/envelope/retry metadata, không phát lại tiền |
| AppointmentBillingOperation                        | Core; không cho PREPARING/unfinalized đi qua, preserve terminal hoặc thêm historical operation      |
| Notification                                       | Notification; full metadata và read state; seeded inbox chặn replay notice đã đọc/xóa               |

Mỗi field nguồn phải xuất hiện đúng theo DMMF và catalog DB. Full sorted key hash
và content hash so sánh mọi giá trị, không chỉ count. SQL NULL và JSON null khác
nhau; decimal không đi qua floating point. FK/check/unique hoạt động trong import.
Source schema là monolith hiện tại **sau các migration additive P0–P4**, không
khẳng định đã upgrade mọi dump/schema cổ hoặc đã đọc dữ liệu đang dùng.

Core đích giữ bảng clinical/notification legacy trống để không sửa/xóa migration
lịch sử; app role bị revoke cả SELECT và DML. Clinic/Notification runtime cũng
không có quyền trên proof-only tables. Không có FK giữa database; sáu cross-service
CONNECT thật bị PostgreSQL từ chối. Bootstrap admin chỉ thuộc tooling/migration.

Hai invoice clinical lịch sử có INVOICED reservation + terminal và immutable
sourceSnapshot. Null snapshot chỉ backfill khi timestamps/history chứng minh
source chưa thay sau issuedAt; trường hợp không xác định bị chặn để review. Spa
checkout trả invoice cũ, undo bị 409, invoice paid/cash/payment history được giữ.
Không gọi gateway thanh toán/mail thật hoặc đảo tiền để kiểm thử.

Notification thiếu notice cần evidence pending/deleted đã review, không suy từ
publishedAt. Inbox seed actual eventId đã materialize/deleted, giữ trạng thái read;
pending được broker đưa tới đích một lần. Sau xóa notice read ở đích, replay không
phục sinh. Directory seed và catch-up giữ sourceVersion, hydrate qua Core hiện tại.

## 11 nhóm nghiệm thu

1. Source tổng hợp đủ model/field và credentials monolith cũ; role không superuser/owner.
2. Nginx maintenance chặn ghi; SQL freeze đợi transaction đang ghi bằng barrier quan sát Lock waiter, rồi source DML bị từ chối.
3. pg_dump custom archive và pg_restore vào DB mới; export restore khớp mọi row/hash/sequence.
4. Dry-run chặn checksum/unknown field/type/date, orphan, duplicate slot, tiền/item/payment, history, ambiguity/collision/eventId và snapshot lịch sử stale; nguồn drift không qua preflight; CLI export với evidence và dry-run chạy thật.
5. Fault giữa import Clinic rollback toàn service; Core commit/journal được giữ, resume cùng snapshot và rerun exact; giữ reversals, snapshot, reservation, JSON null và sequence.
6. Target đọc trong maintenance: token cũ 401, login mới, scope/redaction/paging/invoice paid/notice read; Core không đọc bảng chuyển; target chưa có DML; sáu cross DB denied.
7. Rollback trước mở ghi cấp lại duy nhất source; re-freeze/import cùng snapshot chỉ khi nguồn/sequence không đổi.
8. Mở target: old Spa invoice/undo/activation giữ contract; đăng ký→pet→khám→bệnh án→invoice→notification mới chạy qua API thật.
9. Replay qua RabbitMQ không trùng/phục sinh, pending intent một lần, directory mới đúng version.
10. Sau write mới: durable rollback reject, maintenance/drain/pause/restart/forward-fix giữ medical và invoice 450.000 VND, slot và reservation còn đúng.
11. Pause/forward-fix đồng thời đợi cùng SQL advisory barrier, ledger khớp quyền ghi, source vẫn bị khóa.

Các invariant I01–I12 và crash/race chi tiết còn được hồi quy bởi P1–P6 và real
E2E trong aggregate. P7 không thay thế các kiểm thử protocol prepare/commit/abort/undo.
Các child lifetimes được assert exit 0 kể cả khi thoát sớm; không restart/skip để
che native crash. Failure queue và dữ liệu các lượt FAIL đều được giữ.

## Giới hạn

Snapshot in-memory tối đa 32 MiB/100.000 row mỗi model, chưa đo dữ liệu lớn. Thử
restore source và giữ dữ liệu mới qua restart/forward-fix; chưa reverse migration,
PITR hoặc backup/restore đích sau write mới. Sau từng mở ghi, luôn forward-fix;
không restore snapshot cũ/chuyển gateway nguồn. Gateway/jobs/admin đặc quyền phải
được operator quản lý/drain; SQL grants chỉ fence runtime role đã chỉ định.

Cài đặt lại cùng máy đã kiểm chứng, remote CI và máy người nhận chưa chạy. Native
Windows process loss ở P6 trước đây chưa rõ nguyên nhân; các lượt P7 sạch/PASS
không chứng minh đã sửa nguyên nhân. Chưa live cutover, HA/storage/ngân hàng/mail
thật hoặc benchmark/capacity P8. Gói H chỉ chuẩn bị cho review/tái hiện, không ghi
hai thành viên đã tiếp nhận.
