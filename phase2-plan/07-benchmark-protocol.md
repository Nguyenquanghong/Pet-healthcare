# 07 — NFR định lượng và phép đo Kaggle

Cập nhật 14/10/2026 theo yêu cầu định lượng NFR trước khi xây notebook. Đây là
**tiêu chí nghiệm thu đề xuất được chốt trước lượt đo**, chưa phải kết quả đạt.
Giữ các invariant, ranh giới và gate dữ liệu ở tài liệu 01–04. Policy máy đọc:
[acceptance.json](../benchmarks/phase2/kaggle/acceptance.json), version
`phase2-nfr-20261014-v1`; report ghi SHA256 policy, không thay ngưỡng trong một matrix.

## 1. Tiêu chí theo từng NFR

| NFR                     | Chỉ số, mức đạt và mẫu tối thiểu                                                                                                                                                                                                                                                     | Phương pháp/bằng chứng                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01 — nhất quán          | 0 mất giao dịch đã trả success; 0 active slot trùng; 0 invoice trùng source; 0 bệnh án hoặc completion ghi một nửa. Mỗi race cốt lõi chạy ≥100 cặp đồng thời, bao phủ hai thứ tự thắng.                                                                                              | Đối soát ID/count/unique trên DB riêng sau tải; race có barrier bằng suite P1/P3/P4. Kaggle không thay thế test fault trong transaction.                                                              |
| 02 — phục hồi           | Consumer dừng 60s; tối đa 300 event hợp lệ, đầu vào ≤5 event/s. Sau restart, 100% nhận đủ trong ≤120s, 0 tác dụng trùng, 0 event hợp lệ nằm DLQ; chạy ≥3 lần. Nghiệp vụ trả success trong outage không được mất.                                                                     | Ghi thời điểm dừng/restart, expected/observed, pending và ready/unacked/DLQ. Kaggle hiện kiểm owner notice + outbox; chưa thu ready/unacked/DLQ nên chỉ PASS trong phạm vi đó.                        |
| 03 — hóa đơn            | 0 late commit sau ABORTED; 0 release HELD chỉ vì timeout; 0 invoice mới khi replay key; key đổi payload trả 409. Khi khỏe, request start→terminal p95 ≤10s, mọi operation trong mẫu terminal ≤30s; ≥100 operation và ≥3 lượt.                                                        | Không coi HTTP 202 là hoàn thành. Đối soát Core invoice/operation với Clinic INVOICED. Kaggle có healthy checkout/replay, race commit–abort/undo dùng P4.                                             |
| 04 — riêng tư           | 0 truy cập trái phép trong ma trận owner/staff/admin; mỗi list/detail/write/count/related có ca owner khác; 100% token sai/hết hạn bị từ chối; 0 secret/nội dung y tế trong artifact công khai.                                                                                      | API/JWT matrix + scan artifact. JWT TTL hiện có và giới hạn revocation theo contract; không thêm yêu cầu thu hồi tức thì ngoài scope.                                                                 |
| 05 — DB ownership       | Đúng 3 DB, 3 credential/client/migration riêng; cả 6 hướng CONNECT chéo phải bị từ chối. 0 SQL cross-service trong runtime.                                                                                                                                                          | Native Kaggle kiểm 6 hướng thực trước tạo workload; P7 kiểm thêm runtime ít quyền. Native fixture dùng role owner cho migrate/runtime, chưa chứng minh least privilege production.                    |
| 06 — scale              | ≥2 Clinic qua Nginx; trong ≥100 request ổn định mỗi replica nhận ≥10%; khi dừng 1 replica, 0 vi phạm NFR01. B2 giữ nguyên tổng CPU/RAM và pool; B3 công bố phần tăng, mục tiêu throughput hợp lệ ≥1,3×B1 ở điểm còn đạt NFR07.                                                       | Đếm instance header; resource quotas phải được cưỡng chế/ghi nhận. Kaggle hiện chỉ topology 1/2 Clinic, pool tăng theo replica, chưa đạt gate B2/B3. Không giả định throughput tuyến tính.            |
| 07 — latency/completion | Mỗi operation: read p95≤750ms/p99≤1.500ms; Clinic write p95≤1.500ms/p99≤3.000ms; auth p95≤2.000ms/p99≤4.000ms. Success/scheduled ≥99%; unexpected/scheduled <1%; ≥1.000 success/operation/lượt, ≥3 lượt. Healthy notification request start→owner notice p95≤5s, ≥100 event/lượt ×3. | Percentile nearest-rank; latency thành công và toàn bộ HTTP báo riêng. Backoff/drop/429 không được loại khỏi mẫu số completion. Mẫu ít ghi INSUFFICIENT_SAMPLES; ngưỡng p99 mới là mục tiêu trước đo. |
| 08 — isolation/overload | Hotel background ≥1 RPS trong ≥300s, ≥3 lượt: p95 có Clinic load / p95 nền ≤1,2. Mọi 429/503 phải được phân loại; không success giả. Hash concurrency=2, pending≤16; API pool≤4/replica trong cấu hình Kaggle này.                                                                   | Baseline và interference cùng fixture shape/ngân sách/tải hotel. Notebook hiện chưa điều phối hai dòng tải đồng thời; giữ UNVERIFIED. Chạy login-policy chung IP riêng, không tắt limiter để PASS.    |
| 09 — observability      | ≥99% scrape đúng hạn mỗi 2s; 100% process exit bất thường làm lượt đo lỗi; 0 secret trong public report. Trace ID hiện diện ở các request/event được chọn.                                                                                                                           | CPU/RSS từng API/worker/PG/Redis/Rabbit và generator; metrics API + pool/lock/outbox/queue/pending. Dữ liệu chưa thu phải ghi UNVERIFIED, không suy CPU API đại diện toàn stack.                      |
| 10 — compatibility      | 100% contract/regression bắt buộc đạt, 0 skip không giải thích; 0 response phiên cũ xuất hiện sau logout/login. Collection mặc định 20, tối đa 100; kiểm ngày tại UTC boundary.                                                                                                      | OpenAPI + 18 E2E + ma trận API theo snapshot hiện tại. Benchmark không chứng minh UI đúng.                                                                                                            |
| 11 — bảo toàn/restore   | 100% row/ID/hash/quan hệ/tổng tiền theo manifest khớp; 0 orphan. Restore rehearsal ≤600s trên dataset tham chiếu ≤100.000 row/model, báo dump size/hardware. RPO của cutover có write freeze =0 giao dịch đã commit bị mất.                                                          | P7 backup→restore→reconciliation và ledger. 600s là mục tiêu rehearsal mới, không là RTO/RPO/SLA production đã đo. Dataset lớn hơn phải có phép đo riêng.                                             |
| 12 — tái hiện           | 3/3 service build/start từ source+lockfile; ≥1 người/máy độc lập chạy các check bắt buộc, 0 lỗi/skip bị che; 100% report có source/policy/version/config/raw artifacts.                                                                                                              | H chỉ DONE sau tiếp nhận độc lập. Kaggle cùng người vận hành là môi trường khác, không tự coi đã bàn giao người nhận.                                                                                 |

## 2. Dataset và workload

Dataset `multi-owner-v1`, smoke 8 owner; deep 40 owner, 840 pet, 4.800 lịch sử
appointment, 1.200 bệnh án, 1.200 hotel booking và 1.200 unpaid invoice. Dữ liệu
tổng hợp, không payment thật; public report chỉ counts. Mỗi case có PG cluster,
DB/role, Redis namespace, Rabbit node và UUID mới; không reset/reuse DB đang dùng.
Anchor date ghi vào manifest; các case cùng shape, không cùng UUID hay timestamp.

Notebook hiện có read (6 operation phân đều), clinic_write, mixed (80% read,
20% create bằng seed cố định), login_policy và hotel_background. Đây là profile
chẩn đoán được định nghĩa rõ; **chưa** là workload hành trình 10% đăng ký→pet→khám,
20% login→read, 70% phiên có sẵn trong tài liệu 04. Profile này còn phải bổ sung
trước khi kết luận capacity toàn hệ thống.

Chế độ tự động chạy Smoke trước rồi 18 lượt sâu (read20/mixed30/write10RPS,
1/2 Clinic ×3 lượt, warmup120s/steady300s), cần ít nhất2,1giờ cộng setup. Chế độ
stress tùy chọn bổ sung20/40/80RPS với steady60s, vẫn là SCREENING.
Open-loop cho phép operator đặt arrival rate R/2R/4R, tối đa200RPS,
128 in-flight và 100.000 arrival/segment. Generator không đợi response để lên lịch
arrival kế tiếp; hết slot ghi generator_drop, không âm thầm xếp hàng vô hạn.
Retry-After làm actor tương ứng tạm ngừng gửi, arrival bị chặn ghi client_backoff.
Không retry POST thất bại bằng key mới. Timeout có thể đã commit → REVIEW_REQUIRED.

## 3. Điều kiện một phép đo hợp lệ

- Warmup ≥120s, steady ≥300s, ≥3 **lượt thực sự hoàn tất** cho cùng profile/rate/
  topology. Kiểm từng lượt; không lấy trung bình để giấu một lượt lỗi.
- Generator drop ≤0,1%, scheduler lag p95≤50ms; vượt ngưỡng thì INVALID_GENERATOR,
  không kết luận giới hạn server từ số RPS đã phát được.
- Đủ số mẫu theo NFR07, success≥99%, các percentile đạt; 429 nhanh không phải
  latency success. Báo số scheduled/sent/success/backoff/drop/429/503/timeout.
- Correctness/reconciliation đạt; process teardown sạch. FAIL vẫn được lưu, không
  tự chạy lại để thay nhãn. Warmup và steady cùng quota; không reset limiter.
- Source archive/manifest hash, policy hash, Node/PG/Rabbit/Redis/Nginx/Python,
  hardware/CPU affinity/cgroup limits, topology/pool/fixture và nguyên nhân thiếu
  telemetry phải có trong report. Kaggle native cùng host chỉ đo loopback.

Trạng thái tách biệt: `COMPLETE` = đã chạy xong; `SCREENING` = thiếu thời lượng;
`INSUFFICIENT_SAMPLES` = thiếu mẫu; `PASS_IN_SCOPE` = đúng tiêu chí đã đo;
`NOT_ACCEPTED` = matrix chưa đủ/không đạt. `capacity_accepted=false` cho notebook
hiện tại vì chưa B0/B2/B3 có ngân sách và toàn bộ workload/telemetry yêu cầu.

## 4. Quy trình sử dụng

Đọc [hướng dẫn Kaggle](../benchmarks/phase2/kaggle/README.md), mặc định clone Git
từ nhánh/commit đã push đủ file mới; archive/receipt là tùy chọn cho snapshot local.
Chạy Smoke, kiểm migration/auth/worker/đối soát, rồi
Deep theo từng batch vừa thời lượng phiên. Ghi nguồn lực thực tế; không dùng GPU
cho phép đo HTTP/DB. Không yêu cầu thông tin đăng nhập hệ thống đang dùng.

Ngày 14/10 chỉ xây notebook/công cụ và kiểm ở môi trường local được ghi trong
STATUS; **chưa chạy trên tài khoản Kaggle**, chưa có số đo để kết luận các mục
tiêu mới đạt. Những phép đo bổ sung ở trên là backlog công khai của P8.
