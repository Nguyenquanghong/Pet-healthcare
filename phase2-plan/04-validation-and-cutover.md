# 04 — Kiểm chứng, cutover và báo cáo

## 1. Quy tắc môi trường

Chỉ test ghi dữ liệu trên PostgreSQL/Compose project/volume thử riêng đã xác minh; DB chứa `_test` trong tên chưa đủ bằng chứng an toàn. Kiểm tra host/port/project, marker fixture và connection identity, không in mật khẩu. Không seed/reset DB người dùng đang demo, không `down -v`, xóa volume hoặc truncate tùy tiện.

Các lệnh hiện có ở root tại lúc khảo sát:

```powershell
npm test
npm run test:integration -w backend
npm run test:e2e
```

`npm test` gồm build backend/frontend, backend unit, architecture và OpenAPI; chưa gồm toàn bộ integration/E2E. Playwright không tự dựng/reset DB; baseURL mặc định là 5173 và workers=1. Cần cấp `E2E_BASE_URL` của stack thử và kiểm tra các guard mutating tests trước chạy. Không trỏ test vào demo đang dùng chỉ vì cùng port mặc định.

Các lệnh kiểm thử theo từng miền được định nghĩa như sau:

| Lệnh đề xuất                                            | Mục đích                                                |
| ------------------------------------------------------- | ------------------------------------------------------- |
| `npm run phase2:test:contracts`                         | Wire schema + API compatibility                         |
| `npm run phase2:test:integration`                       | Ba DB, broker, transaction/race/fault tests             |
| `npm run phase2:test:e2e`                               | UI với stack thử được xác minh                          |
| `npm run phase2:migrate -- --dry-run --manifest <path>` | Kiểm kê/validation không ghi                            |
| `npm run phase2:benchmark -- --manifest <path>`         | Đo workload đã version hóa                              |
| `npm run phase2:verify`                                 | Điều phối checks không phá dữ liệu; báo rõ bước bị skip |

Không viết README như thể các script này tồn tại trước khi triển khai xong.

## 2. Ma trận test bắt buộc

| ID  | Kịch bản                                                                  | Bằng chứng đạt                                                               | Mốc      |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------- |
| T01 | Đăng nhập owner/admin/staff, credentials cũ, lỗi input                    | Contract và quyền baseline giữ đúng                                          | P0/P6    |
| T02 | Khách tại quầy kích hoạt tài khoản                                        | Giữ ownerId/pets/lịch/invoice; token một lần/hết hạn/revoke                  | P6       |
| T03 | Nhiều người cùng IP, counter nhiều replica, Redis down                    | 429 theo policy; /me không dùng quota login; degraded như ADR                | P6       |
| T04 | JWT sai issuer/audience/algorithm/role, token hết hạn, internal actor giả | Từ chối; không public `/internal`/metrics                                    | P6       |
| T05 | Owner A đổi query/id thành owner B trên list/detail/write                 | Không lộ item/count/related/internalNote                                     | P2/P3    |
| T06 | Hai replica tạo cùng slot, khám với Spa                                   | Chỉ một ghi thành công; request còn lại 409                                  | P1/P3    |
| T07 | Tạo/reschedule/status với revision cũ                                     | Conflict đúng; không mất cập nhật                                            | P3       |
| T08 | Ghi bệnh án lỗi giữa create và complete                                   | Cả record/status/outbox rollback                                             | P3       |
| T09 | Retry cùng key sau mất response, khác payload cùng key                    | Cùng resource hoặc 409; không thêm record                                    | P2/P3/P4 |
| T10 | Transaction nghiệp vụ rollback sau insert outbox                          | Không event tác dụng ở consumer                                              | P2       |
| T11 | Broker down lúc đặt lịch/hotel/thu tiền                                   | Nghiệp vụ commit + outbox pending; hồi phục nhận đủ                          | P2/P6    |
| T12 | Relay crash sau publish confirm trước mark                                | Gửi lặp nhưng chỉ một notification                                           | P2       |
| T13 | Consumer crash sau DB commit trước ACK                                    | Inbox chống trùng khi redelivery                                             | P2       |
| T14 | Poison message, retry republish crash, DLQ replay                         | Không mất event hợp lệ; không loop nóng; DLQ có lý do                        | P2       |
| T15 | Xóa notification rồi replay event cũ                                      | Không tái tạo do giữ inbox                                                   | P2       |
| T16 | Prepare invoice đồng thời undo completed                                  | Một luồng thắng; không có invoice cho lịch đã bị mở lại                      | P1/P4    |
| T17 | Commit invoice đồng thời abort operation                                  | Một terminal state; không invoice + released reservation                     | P1/P4    |
| T18 | Mất response sau invoice commit; finalize event trễ                       | Retry trả invoice cũ; HELD còn chặn undo đến finalize                        | P4       |
| T19 | Prepare trễ sau abort; Core không truy cập được lúc reconcile             | Không commit muộn; giữ pending khi chưa biết, release khi đã xác minh        | P4       |
| T20 | Cùng appointment nhiều key lập invoice                                    | Tối đa một invoice và một reservation hữu hiệu                               | P4       |
| T21 | Hotel checkout chưa thanh toán/đã thanh toán                              | Quy tắc hiện có và lịch sử tiền giữ đúng                                     | P4/P7    |
| T22 | List search/filter/count/related, page cuối sau delete                    | Semantics đúng, không lọc sau limit; stable tie-break ID                     | P3/P5    |
| T23 | Projection event sai thứ tự/lặp, backfill xen update                      | Version không lùi; query/counters theo projection nhất quán                  | P3       |
| T24 | Đổi tên pet/owner rồi đọc Clinic; Core directory down                     | Read-your-writes có version hoặc trạng thái đồng bộ; fail closed quyền       | P3/P5    |
| T25 | Notification lỗi, bootstrap region lỗi, phiên auth tạm lỗi                | Không logout/đổi unread thành 0 giả; region lỗi riêng                        | P5       |
| T26 | Logout/login người khác khi request cũ đang bay                           | Response cũ không xuất hiện trong phiên mới                                  | P5       |
| T27 | Mutation đã lưu nhưng refresh timeout, invoice 202                        | Không gửi trùng; có trạng thái chờ và tra lại                                | P5       |
| T28 | Nhiều Clinic replica và tắt một replica giữa tải                          | Request thực phân phối; kết quả ghi không trùng/mất; thống kê lỗi trung thực | P6/P8    |
| T29 | Credential service truy cập DB service khác                               | Bị DB từ chối, không chỉ convention trong code                               | P1/P7    |
| T30 | Migration rồi đối chiếu/restart/restore                                   | ID/count/hash/relations/revision/payment totals khớp                         | P7       |
| T31 | Ngày ở UTC boundary, lịch hôm nay/quá khứ, ngày tháng UI                  | Giữ Asia/Ho_Chi_Minh; so main/refactor có chủ ý                              | P3/P5    |
| T32 | Public rescue token, report retry và Notification down                    | Không lộ hồ sơ riêng; report/outbox không mất                                | P2/P7    |
| T33 | Synthetic VNPay/bank transfer/IPN gửi lặp                                 | Tiền/lịch sử không bị xác nhận hai lần; không giao dịch thật                 | P4/P7    |
| T34 | Dừng worker/API graceful, restart migration                               | Không ACK sớm; xử lý in-flight/lease; startup không chạy seed                | P6/P7    |

Unit dùng fake ports cho nghiệp vụ; integration phải dùng PostgreSQL thật cho lock/unique/atomicity và broker thật cho confirm/ACK/restart. Không để một mock HTTP trả 200 thay thế chứng minh chịu lỗi. Test concurrency cần barrier/fault hook có kiểm soát, không chỉ sleep ngẫu nhiên. Fault injection chỉ trong test, không public debug endpoint có thể kích hoạt ở môi trường thường.

## 3. Cutover có dữ liệu

### Chuẩn bị

1. Ghi manifest: source SHA + trạng thái dirty, contract version, migration IDs, DB identity, các bảng/counts/checksum, timezone, gateway config và schema đích.
2. Backup nhất quán và thử restore sang DB riêng. Có backup mà chưa restore thành công chưa đủ qua gate.
3. Dry-run phát hiện orphan, duplicate slot/source invoice, history kind sai, thiếu owner/pet/doctor và currency/time bất thường. Dừng khi phát hiện; không tự sửa lịch sử.
4. Tạo DB/role/migration đích. Script cấp quyền admin chỉ chạy trong bootstrap/migration, app runtime không có quyền superuser.

### Trình tự rehearsal đề xuất

1. Dùng bản copy dữ liệu thử; bật chế độ ngừng ghi có thông báo ở gateway cho tất cả đường ghi liên quan, chờ in-flight kết thúc và dừng workers nguồn có thể ghi. Không chỉ khóa riêng nút frontend.
2. Chụp mốc cuối nguồn. Import Clinic: appointment mọi type, medical records/images, history kind=appointment; giữ nguyên ID/timestamp/revision, local index/checks.
3. Import Notification giữ ID, status, recipient, timestamps. Thiết kế cutover event IDs/seeded inbox cho event cũ nếu có để không tái tạo thông báo khi backlog được phát lại; replay thử và kiểm unique notificationId cùng eventId.
4. Tạo reservation INVOICED cho mọi invoice appointment lịch sử, kèm invoiceId; không phát lại nghiệp vụ thu tiền. Lưu snapshot appointment cho invoice ở Core.
5. Seed directory projection tối thiểu, lấy version và catch-up. Không copy password/salt/activation token.
6. Đối chiếu count theo owner/status, sorted IDs và hash các trường nghiệp vụ; tiền theo invoice/status, lịch sử theo kind/revision, orphan/slot uniqueness và trạng thái đọc. Report không chứa nội dung y tế hoặc secret.
7. Deploy code/gateway đích trong lúc vẫn ngừng ghi; legacy Clinic/Notification writer vô hiệu. Service credentials không còn quyền đọc/ghi bảng đã chuyển. Truy vấn đọc đối chiếu và smoke auth/role/filter.
8. Nếu validation đạt, mở ghi trên stack thử; thực hiện hành trình tạo mới/hoàn tất/lập hóa đơn và tiêu thụ outbox; đối soát cuối.
9. Chỉ kết luận ready sau rehearsal đạt. Chuyển dữ liệu đang dùng thật là hành động riêng, phải có môi trường đích và phạm vi được người dùng chỉ định.

Không dùng dual-write hai DB để “giữ rollback dễ” khi chưa có giao thức đồng bộ. Bảng legacy có thể được giữ lại để đối chiếu với quyền read-only của công cụ migration, không phải đường truy cập runtime.

### Rollback

- **Trước khi mở ghi mới:** có thể chuyển code/routes về baseline và mở ghi nguồn sau kiểm tra vì chưa có thay đổi chỉ tồn tại ở DB đích. Dừng workers đích để tránh tác dụng phụ.
- **Sau khi mở ghi mới:** không chỉ đổi gateway về DB cũ hoặc restore snapshot cũ. Phải ngừng ghi, giữ toàn bộ dữ liệu mới, đối soát và chạy reverse migration đã được kiểm chứng; nếu chưa có reverse migration, chọn forward-fix trên dữ liệu đích. Ghi rõ giới hạn này trong runbook.
- Replay broker hoặc rollback code không được đảo lịch sử tiền đã nhận. Không xóa outbox/inbox/operation terminal để ép test qua.

## 4. Benchmark có thể bảo vệ

Cập nhật 14/10/2026: [protocol/NFR định lượng 07](07-benchmark-protocol.md) bổ sung
p99, completion, sample size, recovery/terminal deadline và gate generator.
[Notebook Kaggle](../benchmarks/phase2/phase2-kaggle.ipynb) dựng native stack riêng;
chưa là B0–B3 có ngân sách tương đương và chưa có kết quả Kaggle để nghiệm thu.

### Thiết kế thí nghiệm

| Biến thể                                                 | Dùng để trả lời                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| B0 — main phân trang, có bảo vệ proxy hiện có            | Baseline đúng contract và hành trình hiện tại                           |
| B1 — ba service, một replica Clinic                      | Chi phí/lợi ích của tách service với tổng tài nguyên tương đương        |
| B2 — ba service, nhiều replica Clinic, cùng tổng CPU/RAM | Tác động phân phối tiến trình trong cùng ngân sách                      |
| B3 — tăng tài nguyên riêng Clinic                        | Có mở rộng được khi cấp thêm tài nguyên không; công khai ngân sách tăng |

Sử dụng fixture cùng shape trên DB thử mới riêng cho từng case, cùng loại request/response cần thiết, cùng phiên bản workload; không reset DB đang dùng. Backend thay đổi đọc ít dữ liệu hơn không tự chứng minh tăng năng lực toàn hệ thống. Dùng seed có ngày tương đối theo mốc run và ghi mốc đó, tránh toàn bộ booking bị từ chối vì ngày quá khứ.

Tỉ lệ workload khởi đầu để hiệu chỉnh, không là dự báo thật: 10% khách mới đăng ký→tạo pet→đặt khám; 20% khách cũ login→tra cứu; 70% phiên còn hạn tra cứu/đặt khám. Bổ sung kịch bản độc lập clinic-heavy, login/register-heavy, read-heavy và common-IP. Giữ tải hotel/billing nền để đo ảnh hưởng lan sang Core.

Đo tăng dần arrival rate R, 2R, 4R tới ngưỡng; chọn R sau smoke/khả năng máy. Mỗi cấu hình warmup ít nhất 2 phút, steady ít nhất 5 phút, lặp ít nhất 3 lần nếu môi trường cho phép. Nếu buộc rút ngắn, ghi screening và không so như kết luận capacity. Tách test chính sách limiter và test capacity: không tắt bảo vệ trong build để lấy số; cấu hình fixture/IP/rate phù hợp và báo số bị 429.

Đo p50/p95/p99 theo operation và hành trình, tỷ lệ hoàn thành, RPS thành công nghiệp vụ, 4xx expected, 429 policy, 503 overload, timeout, CPU/RAM từng service, DB queries/lock/pool, hash duration, event-loop lag, outbox/queue age và notification end-to-end lag. Đếm error không chỉ nhìn HTTP 2xx: invoice 202 chỉ là accepted, chưa hoàn thành.

### Mục tiêu đề xuất để nhóm chốt ở P0

Các giá trị sau là mục tiêu trên workload/máy thử được công bố, **chưa phải số đo hoặc bảo đảm sản xuất**:

- p95 đọc <= 750 ms, ghi Clinic <= 1.500 ms, auth <= 2.000 ms ở mức tải công bố; tách thời gian chờ người dùng và thu tiền bên ngoài.
- Lỗi ngoài dự kiến < 1%; không mất giao dịch, sai quyền, trùng slot/invoice ở mọi mức tải được test.
- Notification p95 <= 5 giây khi khỏe; sau sự cố consumer 60 giây, nhận đủ tối đa300 event trong≤120s sau restart với đầu vào≤5 event/s, 0 tác dụng trùng. Điều kiện/mẫu cụ thể ở tài liệu 07, đây là mục tiêu trước đo.
- Tải khám tăng không làm p95 hotel vượt 1,2 lần baseline nền ở cùng ngân sách đã mô tả; nếu không đạt, giải thích bằng DB/CPU/dependency evidence, không che kết quả.

Mục tiêu performance có thể hiệu chỉnh một lần sau baseline bằng ADR; không đổi ngưỡng sau mỗi run để đánh PASS. Correctness I01–I12 là cứng, không được nới.

### Manifest mỗi run

Run ID, UTC timestamp và múi giờ nghiệp vụ; code SHA + dirty snapshot hash; Node/PostgreSQL/RabbitMQ/Redis version; OS/CPU/RAM/quota/replicas/pools; fixture seed/count/date; workload version/mix/rate; warmup/duration/repeats; limiter config không secret; raw result path; lỗi và exclusions. Không đính kèm .env hoặc dữ liệu cá nhân thật.

## 5. Gói bảo vệ

Demo 1: khách mới đăng ký, tạo pet, đặt khám, bác sĩ ghi bệnh án, lập invoice và nhận thông báo.

Demo 2: dừng Notification consumer, tạo lịch; lịch vẫn thành công; bật consumer và xem thông báo đúng một lần. Giải thích outbox/ACK/inbox bằng correlation ID.

Demo 3: hai request tranh cùng slot hoặc invoice-vs-undo; chỉ kết quả hợp lệ được commit, trình bày test report bên cạnh UI.

Demo 4: tải khám tăng và nhiều Clinic replica; chỉ rõ request phân phối, p95, quota và tác động hotel/Core. Không dùng screenshot metrics ngoài run đang trình bày.

Demo 5: nhiều user chung IP, frontend tra cứu không tải toàn hệ thống; trình bày chính sách auth và request count trước/sau.

Nộp sơ đồ context/container/sequence, ADR, API/event schema, bảng ownership, test report, benchmark raw+report và hướng dẫn clean setup/recovery. Ghi rõ chưa tách Identity, Spa cùng Clinic, shared PostgreSQL server nếu có, single broker và các dependencies Core còn tồn tại.
