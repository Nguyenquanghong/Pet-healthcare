# P5 — Frontend/bootstrap: bằng chứng triển khai

11/10/2026; main/add596e4488e3cac2584115874c2f65a97af7047. Làm tuần tự một
agent, không commit/push/merge, seed/reset, live DB write hoặc cutover. 18 file
local ban đầu được kiểm lại SHA256. [Runbook](../../deploy/phase2/frontend-runtime.md).

## Code

SessionContext sở hữu identity; business reads chuyển về query theo màn. Epoch,
token/query/sequence guard và AbortController bảo vệ session và response cũ.
Dashboard Core/Clinic độc lập, Notification count dùng chung; có unknown, retry
và timestamp cho dữ liệu cũ. Registry chỉ reload query đang mount theo domain,
không global bootstrap/poll/cache business arrays. Poll còn ở unread, billing
list và operation pending với phạm vi cụ thể.

PagedSelect có detail query được fence/abort; lựa chọn qua page 2 không bị ép về
pet đầu. Các màn đặt khám/Spa/hotel không dùng preview dashboard để kết luận hết
pet. Medical đọc selected pet từ Core hiện tại và search sync metadata Clinic.
Saved/reload-failed tách khỏi rejected write. Form bệnh án inline từ lịch khám
đã bổ sung Idempotency-Key, giữ intent khi response mất.

Review `139e4dd` chỉ dùng `git show`; không merge nhánh. Giữ app.ts và nginx/
compose local của người dùng; Core composition là entrypoint P2–P4 có opt-in
Clinic. [API/transaction delta](p5-api-and-transaction-inventory.md).

## Kiểm chứng

Aggregate cuối `npm run phase2:verify` **exit 0**: workspace builds, contracts
8/8, boundaries/writer audit, 44 integration groups (0 skip) và 18/18 E2E thật
(~2 phút), gồm teardown thành công. `npm test` exit 0: builds, 81/81 unit,
architecture 94 files, OpenAPI 69 operations. UI mock 9/9 (~19s) ghi riêng.
[Test history](test-results.md) giữ cả FAIL và lệnh/results thực tế.
Browser suite mới có 18 ca, worker Playwright chạy tuần tự:

| Phạm vi         | Cách kiểm                                                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Đăng ký         | Actual server từ chối email trùng; error và success feedback sống qua session remount; đăng ký mới trả token và đi vào màn pets                                                                                                                        |
| Khám/bệnh án    | Owner UI đặt → staff UI xác nhận/check-in → inline record, completion; mất response sau actual commit rồi retry cùng key/body, owner redaction và owner khác bị 403                                                                                    |
| Spa/billing     | Owner UI đặt → lifecycle actual API → owner checkout → Clinic reservation/Core invoice → staff UI cash → owner thấy paid, một invoice                                                                                                                  |
| Hotel           | Owner UI đặt → actual status/care note → detail UI → owner tự chốt bị 403 → staff UI lập invoice → trả pet trước paid bị 409 → cash rồi detail checked_out                                                                                             |
| Activation      | Staff UI cấp fragment link → owner UI đặt mật khẩu → single use → login giữ ownerId/pet/clinical history                                                                                                                                               |
| Rescue          | Public UI chỉ đọc profile cho phép → actual report/outbox → Notification inbox → owner UI đọc notice                                                                                                                                                   |
| Pagination/date | 21 pets, page-two selection/detail, debounce và server filtering; delete dòng cuối trên page 2 Notification; browser UTC boundary/Vietnam date và calendar month                                                                                       |
| T25             | Dừng API Notification do harness sở hữu: token giữ, unread unknown, đặt Spa vẫn ghi; bootstrap partial null; abort transport riêng Core/Clinic dashboard rồi retry actual response; auth/me tạm lỗi                                                    |
| T26             | Giữ response thật của list/detail phiên cũ đang bay, logout/login owner khác rồi thả response; UI mới không có pet cũ                                                                                                                                  |
| T24/T27         | Pause directory relay, rename Core và thấy tên hiện tại + sync message, resume/search catch-up; actual write/reload transport failure chỉ retry GET; real OutboxEvent CHECK fault ép 202 rồi same operation hoàn tất, không thêm checkout POST/invoice |

Backend/business response không bị mock. Các ca transport fault abort request
hoặc mất body sau `route.fetch()` của response thật. SQL CHECK chỉ nhắm appointment
UUID thử, có finally drop; Notification page fixture và delete chỉ thuộc owner
UUID thử. API Notification stop/restart và Core lifecycle chỉ dùng handle runner
tạo. PostgreSQL/broker không bị reset; retained P4 failure queue không bị drain.

CI workflow và wrapper đã nối suite; chưa chạy remote CI. Limiter auth cũ bị phát
hiện khi helper login nhiều lần: 429 thật được ghi FAIL. Runner cache token API
helper và fresh Core giữa ca, không đổi quota/hash iterations để đánh PASS.
Shared limiter/same-IP surge còn P6. Ba container thử đã stop sau khi guard project,
đều Exited (0). Queue lỗi P4 kiểm read-only vẫn ready=1/unacked=0; không ACK/purge.

## Network evidence

Baseline giữ artifact build P4 trước sửa frontend. Bản đó bake `localhost:5000`;
chỉ đổi API base trong artifact thử sang `/api`, ghi SHA256 trước/sau trong
[before JSON](p5-network-before.json). Không sửa `.env`. Đo cùng hard-navigation
dashboard và admin appointments: sau initial network idle chờ 12 giây/vùng,
login/setup ngoài capture, browser chỉ gọi proxy ba backend thật.

Before có 8 browser API calls (dashboard 3, appointments 5), gồm 3 request nền.
[After JSON](p5-network-after.json) có 7 calls (dashboard 4, appointments 3),
request nền 0 và bootstrap 0 trong cửa sổ đo. Tổng giảm 12,5%; riêng appointments
giảm từ 5 xuống 3. Mọi response capture cuối đều HTTP 200.
Dashboard initial tăng từ 2 lên 4 để lấy regions/count độc lập; không che phần
tăng này. Unread vẫn có polling riêng 20 giây; cửa sổ 12 giây không đo chu kỳ đó.
Đây là số request trong hai flow cụ thể, không phải benchmark throughput/latency,
load nhiều người hoặc chứng minh mọi màn đều giảm request. Artifact P4 nằm trong
thư mục ignored cục bộ; clone sạch dùng baseline đã quan sát trong before JSON,
không tuyên bố CI dựng lại đúng bản frontend dirty P4 đó.

## Giới hạn

P5 không có migration mới; chỉ deploy migrations P0–P4 trên schema thử đã guard.
Historical backfill/snapshot/reservation, backup restore/live cutover, auth surge/
Redis/shared quota, replica proxy/HA, network/keys/metrics/advisories và benchmark
còn P6–P8. Không gọi mail, ngân hàng hoặc gateway thanh toán thật. H chưa đạt.
