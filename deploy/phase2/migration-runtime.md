# P7 — Migration và cutover trên stack thử

Đây là công cụ rehearsal cho **pet-phase2-p1-test**, PostgreSQL loopback:55432.
Không nhận URL tùy ý hoặc đọc backend/.env. Chuyển dữ liệu/traffic đang dùng cần
một phạm vi riêng được người dùng chỉ định; các lệnh dưới đây không làm việc đó.

## Chạy lại từ source

Node 24/npm 11, Docker Compose, PostgreSQL 16 trong stack thử, RabbitMQ, Redis,
Nginx và Chromium cho suite E2E. Trên Windows, chuẩn bị Nginx pin 1.30.5 bằng
`npm run phase2:prepare:nginx`; trên Linux cài nginx. Chạy tuần tự:

```powershell
npm ci
npm run phase2:build
npm run phase2:up
npm run phase2:test:migration
npm run phase2:verify
# Khi checkpoint, chỉ stop đúng ba container thử, giữ data/volumes:
node tools/phase2/stop-test.mjs
```

Mỗi lượt P7 tạo source tổng hợp mới bằng composition monolith, ba database đích
mới và database restore mới. Tên database/role gắn run UUID; schema `runtime`.
Mọi role ứng dụng NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT, không sở hữu
database/bảng. Bootstrap riêng sở hữu DDL. Marker kiểm cả run/component trước
query; PUBLIC CONNECT/CREATE đã revoke, sáu kết nối service→DB khác phải bị PG từ chối.
Các DB/role/row/dump và log lỗi được giữ. Chỉ queue UUID rỗng mới được xóa sau drain
cả ready và unacknowledged; DLQ không rỗng làm suite FAIL và được giữ.

`npm run phase2:verify:clean-local` sao chép source tracked và untracked hiện tại
sang thư mục ignored mới, bỏ .git/.env/node_modules/generated/dist, chạy npm ci,
npm test, build ba service và P7. Có hash danh sách source và từng kết quả lệnh.
Đây là cài đặt mới trên cùng máy, chưa phải clone sạch trên máy khác hoặc remote CI.

## Manifest và dữ liệu

[Manifest từng field](../../phase2-plan/evidence/p7-field-manifest.json) phân loại
mọi scalar field của 18 model nguồn. Export đối chiếu cả SQL catalog, index, FK,
migration/checksum, sequence, HEAD và hash dirty source. Model/table/field mới
chưa phân loại phải dừng. IDs, decimal dạng chuỗi, DATE ngày nghiệp vụ, timestamp
UTC millisecond, array và JSON được giữ; wrapper phân biệt SQL NULL với JSON null.

Clinic nhận mọi Appointment, MedicalRecord/Image; owner ảnh lấy từ Pet nguồn;
BookingStatusEvent tách theo kind, giữ revision/reversal. Core nhận hotel history,
identity/pet/hotel/financial/outbox. Notification nhận toàn bộ metadata/read state.
Core vẫn có bảng legacy trống vì giữ migration chain, runtime không có SELECT/DML
trên bốn bảng đã chuyển; lịch sử Core có CHECK kind=hotel. Không dùng FK sang DB khác.

Snapshot invoice có sẵn được giữ. Với invoice appointment chưa có snapshot,
chỉ dựng từ source nếu updatedAt và history không muộn hơn issuedAt; trường hợp
mơ hồ dừng để review. Backfill Core operation COMMITTED/finalized cùng Clinic
INVOICED reservation và terminal, không tạo giao dịch nhận tiền. Unique source và
reservation bảo vệ checkout/undo sau chuyển. Directory seed dùng version nguồn,
không có password/salt/token; worker hydrate qua Core và bắt kịp outbox sau mở ghi.

Notification inbox seed eventId đã materialize hoặc đã xóa, cộng ID notice legacy.
Notice read đã nhập không bị replay đổi về sent; notice đã xóa không bị phục sinh.
Event trỏ notice vắng mặt **không thể tự suy ra pending hay deleted**. Export phải
nhận bằng chứng đã review theo mẫu sau; thiếu/mâu thuẫn/ID lạ đều dừng:

```json
{ "notificationEvents": { "<event UUID>": "pending", "<another event UUID>": "deleted" } }
```

Intent pending giữ trong outbox, không seed inbox, tiêu thụ một lần sau mở ghi.
Không tự mark published, xóa inbox hoặc phát lại thanh toán. PREPARING/chưa finalized
và outbox lease còn giữ phải drain trước export. Snapshot tối đa 32 MiB/100.000
row mỗi model, import row theo transaction service với timeout; chưa là công cụ
streaming cho dữ liệu lớn. Snapshot/backup/context **chứa dữ liệu bảo vệ hoặc secret**,
chỉ để trong ignored test-results/phase2, không đưa vào Git/gói bàn giao công khai.
Report chỉ có count/hash/schema/aggregate tài chính, không payload y tế hoặc credential.

## CLI thử riêng

Runner tự thực hiện đầy đủ các bước. Muốn xem từng bước, đặt confirmation rõ ràng
và dùng context/snapshot do lượt thử sinh ra. `init` tạo DB mới trống; fixture của
suite tạo dữ liệu tổng hợp trên source đó, CLI không seed DB đang dùng.

```powershell
$env:PHASE2_TEST_CONFIRM = 'pet-phase2-p1-test'
node tools/phase2/migrate-p7.mjs init test-results/phase2/new-context.json
# Sau khi source thử có dữ liệu, gateway maintenance và các writer/worker đã drain:
node tools/phase2/migrate-p7.mjs freeze test-results/phase2/new-context.json
node tools/phase2/migrate-p7.mjs backup-restore test-results/phase2/new-context.json
node tools/phase2/migrate-p7.mjs export test-results/phase2/new-context.json test-results/phase2/new-snapshot.json test-results/phase2/reviewed-evidence.json
node tools/phase2/migrate-p7.mjs dry-run test-results/phase2/new-context.json test-results/phase2/new-snapshot.json
node tools/phase2/migrate-p7.mjs import test-results/phase2/new-context.json test-results/phase2/new-snapshot.json
node tools/phase2/migrate-p7.mjs validate test-results/phase2/new-context.json test-results/phase2/new-snapshot.json
node tools/phase2/migrate-p7.mjs read-only-target test-results/phase2/new-context.json
node tools/phase2/migrate-p7.mjs state test-results/phase2/new-context.json
```

Evidence argument cuối của export có thể bỏ khi không có event mơ hồ. File output
tạo exclusive, context/snapshot chỉ dưới test-results/phase2; không overwrite.
Import journal hash trong từng DB: lỗi giữa các service giữ phần đã commit, rollback
transaction đang lỗi; chạy lại cùng snapshot kiểm hash rồi tiếp tục. Không overwrite
target khác/nonempty/drift. Disable bốn directory trigger Core chỉ trong transaction
import để giữ revision/outbox gốc, rồi bật lại; FK/check/unique vẫn có hiệu lực.
Transfer-code sequence nâng tới max của source sequence và các code đã nhập.

Backup dùng pg_dump -Fc nhất quán; pg_restore --no-owner --no-acl
--exit-on-error --single-transaction vào **DB restore mới**, không --clean/--create.
Suite export lại cả 18 model và sequence từ restore để đối chiếu chính xác.
Xem tài liệu PostgreSQL 16 về [pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html)
và [pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html).

## Ownership, gateway và rollback

Gateway rehearsal là Nginx thực, prefix/port/PID riêng, trả JSON 503 cho method ghi
khi maintenance. Operator phải dừng/drain **mọi** source writer, worker, scheduled
job và kết nối đặc quyền trước freeze; SQL fence không thay thế việc quản lý admin.
Freeze khóa exclusive mọi bảng business, đợi transaction đang ghi rồi revoke DML
và sequence USAGE của source app. Lỗi lock timeout thì dừng, không tiếp tục export.

Các thao tác import/freeze/rollback/open/pause/forward-fix giữ advisory lock nguồn
chung xuyên các transaction DB. Ledger source điều khiển LEGACY→FROZEN→IMPORTED.
Switch gateway sang đích vẫn maintenance, target app chỉ có SELECT bảng sở hữu.
Smoke đọc dùng RS256/kid và năm credential nội bộ P6; token HS256 cũ phải login lại.
Suite kiểm redaction/owner scope, phân trang, hóa đơn paid và thông báo read.

**Trước mở ghi đích:** giữ gateway maintenance, drain/dừng workers đích;
`rollback-before-open` revoke quyền ghi đích trước khi cấp lại source. Sau đó mới
đổi gateway nguồn/mở ghi. Muốn chuyển lại đích, maintenance/drain/freeze/export mới;
snapshot cũ chỉ dùng lại nếu source và sequence hoàn toàn không đổi. Source đã đổi
thì dùng snapshot mới và target mới, không ghi đè journal cũ.

**Mở ghi đích:** `open-target <context> <snapshot>` kiểm nguồn freeze và target exact;
lưu opened_at/TARGET_OPEN **trước** mọi grant DML đích. Sau đó mới start workers,
chờ catch-up/health, reload gateway mở ghi. Crash giữa grant có thể để quyền chưa
đủ, nhưng ledger đã ngăn rollback nguồn. Giữ maintenance và forward-fix các grant.

**Sau bất kỳ lần mở ghi đích:** rollback-before-open luôn bị từ chối, kể cả chưa
thấy write mới. Maintenance→drain→`pause-target`→đối soát/giữ toàn bộ dữ liệu mới→
sửa/restart binary đích→`forward-fix`→health/catch-up→mở gateway. Không restore
snapshot cũ hoặc đổi route về nguồn. Chưa có reverse migration được chứng minh.
Suite tạo invoice/medical mới rồi thực hiện đường này và kiểm dữ liệu không mất/trùng;
SQL barrier cũng kiểm pause/forward-fix tranh chấp không làm ledger khác quyền ghi.

G3/P7 là rehearsal dữ liệu tổng hợp trên schema nguồn hiện tại. Dữ liệu thực,
upgrade từ dump/schema cổ khác, đối chiếu máy khác/remote CI, HA/storage/mail/ngân hàng
thật và capacity P8 chưa được kiểm chứng. [Evidence](../../phase2-plan/evidence/p7-migration-cutover.md)
và [STATUS](../../phase2-plan/STATUS.md) ghi kết quả thực tế.
