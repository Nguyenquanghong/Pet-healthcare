# Trạng thái triển khai Pha 2 (Pet Healthcare / NIPOPETO)

Tài liệu này tổng hợp trạng thái hiện tại của kiến trúc 3 service (**Core**, **Clinic & Scheduling**, **Notification**) để các thành viên trong nhóm đối chiếu khi tiếp nhận, kiểm thử và phát triển tiếp.

---

## 1. Tổng quan các chặng kỹ thuật (P0–P8 & Mốc bàn giao H)

| Chặng  | Phạm vi                                                                                                                          | Trạng thái             | Bằng chứng chính                                                                                                                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0** | Khảo sát baseline, inventory API/transaction, môi trường kiểm thử độc lập                                                        | **DONE**               | [baseline.md](evidence/baseline.md), [transaction-inventory.md](evidence/transaction-inventory.md), [test-environment.md](evidence/test-environment.md) |
| **P1** | Dựng monorepo workspace, tách DB/role riêng, outbox/inbox qua RabbitMQ, PoC billing race & unique slot                           | **DONE**               | [decisions.md](evidence/decisions.md), [test-results.md](evidence/test-results.md)                                                                      |
| **P2** | Tách hoàn chỉnh **Notification Service** (API + worker + DB riêng, retry qua delay queue, DLQ, replay idempotent)                | **DONE**               | [p2-notification.md](evidence/p2-notification.md), [p2-api-and-writer-inventory.md](evidence/p2-api-and-writer-inventory.md)                            |
| **P3** | Tách hoàn chỉnh **Clinic & Scheduling Service** (lịch khám/Spa, bệnh án, ảnh y tế Claim Check + Valet Key, phân trang)           | **DONE**               | [p3-clinic.md](evidence/p3-clinic.md), [p3-api-and-transaction-inventory.md](evidence/p3-api-and-transaction-inventory.md)                              |
| **P4** | Giao thức hóa đơn liên dịch vụ (**Billing Saga**: prepare / commit / release, xử lý tranh chấp prepare-vs-undo, commit-vs-abort) | **DONE**               | [p4-billing.md](evidence/p4-billing.md)                                                                                                                 |
| **P5** | Cập nhật Frontend theo màn hình, tách bootstrap session/dashboard, xử lý trạng thái pending/saved/degraded                       | **DONE**               | [p5-frontend.md](evidence/p5-frontend.md), [p5-api-and-transaction-inventory.md](evidence/p5-api-and-transaction-inventory.md)                          |
| **P6** | Xác thực JWT RS256, token nội bộ theo phạm vi, Redis rate-limit, Circuit Breaker tại Gateway Core, chạy nhiều replica Clinic     | **DONE**               | [p6-auth-resilience.md](evidence/p6-auth-resilience.md), [p6-api-and-runtime-inventory.md](evidence/p6-api-and-runtime-inventory.md)                    |
| **P7** | Di trú dữ liệu (migration dry-run / export / import / verify 18 model, 234 trường) và diễn tập cutover/rollback trên stack thử   | **DONE**               | [p7-migration-cutover.md](evidence/p7-migration-cutover.md), [p7-api-and-transaction-inventory.md](evidence/p7-api-and-transaction-inventory.md)        |
| **H**  | Đóng gói bàn giao và phân chia công việc cho các thành viên nhóm                                                                 | **READY FOR TEAM**     | [HANDOFF.md](HANDOFF.md), [RECEIVER-START.md](RECEIVER-START.md), [POST-H-TASKS.md](POST-H-TASKS.md), [handoff-report.md](evidence/handoff-report.md)   |
| **P8** | Kiểm chứng chéo trên máy từng thành viên, hoàn thiện kiểm thử/benchmark và chuẩn bị báo cáo bảo vệ                               | **IN PROGRESS (Nhóm)** | [POST-H-TASKS.md](POST-H-TASKS.md), [04-validation-and-cutover.md](04-validation-and-cutover.md)                                                        |

---

## 2. Các hạng mục tối ưu & hoàn thiện kiến trúc đã tích hợp

1. **Phân quyền & Bảo mật đường đọc/ghi**:
   - Một ma trận quyền (`policy-as-code`) dùng chung cho mọi service ([ADR-AQ05](architecture-work/adr-aq05-permission-matrix.md)).
   - Clinic khai báo phạm vi kiểm quyền trực tiếp theo từng route ([ADR-P04](architecture-work/adr-p04-clinic-route-scope.md)) và gộp kiểm quyền danh sách về 1 lời gọi sang Core sau khi lấy trang dữ liệu ([ADR-P12](architecture-work/adr-p12-deferred-list-authorization.md)).
   - Thu hồi phiên đăng nhập đi qua queue ưu tiên riêng (`identity.sessions-revoked`), không bị nghẽn bởi hàng đợi thông báo ([ADR-P03](architecture-work/adr-p03-messaging-retry.md)).
2. **Tính đúng đắn dưới tải đồng thời (Concurrency & Consistency)**:
   - Vòng đời đặt lịch chuẩn hóa tại một bảng trạng thái trong `@nipopeto/contracts` ([ADR-P01](architecture-work/adr-p01-booking-lifecycle.md)).
   - Bệnh án có khóa lạc quan theo `revision` (`409 MEDICAL_RECORD_STALE`) và người lập do server xác định từ JWT ([ADR-P02/P11](architecture-work/adr-p02-p11-medical-record.md)).
   - Lịch khám/Spa kiểm soát sức chứa theo khung giờ và tài nguyên tại PostgreSQL ([ADR-P10](architecture-work/adr-p10-resource-scheduling.md)), lưu trú khách sạn kiểm soát sức chứa theo loại phòng mỗi đêm ([ADR-AQ10](architecture-work/adr-aq10-hotel-capacity.md)).
3. **Lưu trữ ảnh y tế & Đường đọc danh sách**:
   - Ảnh y tế tách khỏi PostgreSQL sang Object Storage (S3/MinIO) theo mẫu **Claim Check + Valet Key**, kèm thời hạn lưu giữ và nhật ký kiểm toán ([ADR-AQ09-R](architecture-work/adr-aq09-image-retention.md)).
   - Đã thực nghiệm và đối chứng hiệu năng CQRS cho danh sách lịch hẹn ([FINAL-CQRS-20261023.md](cqrs/FINAL-CQRS-20261023.md), [ADR-CQRS-06](cqrs/evidence/adr-cqrs-06.md)): giữ đọc trực tiếp từ bảng nguồn có covering index và tổng hợp hoạt động khám theo snapshot/cache ([BENCHMARK-FINAL.md](cqrs/clinic-activity/BENCHMARK-FINAL.md)).
4. **Cấu trúc mã nguồn & Fitness Functions (`npm run arch:check`)**:
   - Gateway Core chuyển tiếp qua `ServiceProxy` có Circuit Breaker ([ADR-P08A](architecture-work/adr-p08a-service-proxy.md)), cấu trúc module rõ ràng ([ADR-P08b](architecture-work/adr-p08b-core-structure.md)) và cô lập mã monolith Pha 1 vào `legacy/` ([ADR-P08c](architecture-work/adr-p08c-core-legacy.md)).
   - 17 kiểm tra kiến trúc tự động (`npm run arch:check`) bảo vệ ranh giới module, hợp đồng OpenAPI, kiểu dữ liệu frontend sinh tự động ([ADR-AQ07](architecture-work/adr-aq07-generated-api-types.md)), liên kết tài liệu và chỉ số cảnh báo Prometheus ([10-observability.md](../docs/phase2-architecture/10-observability.md)).

---

## 3. Đo sức chịu tải và nhân rộng (K9): đã có số đo đầu tiên

- **Vì sao:** lý do chính để tách service là nhân riêng phần nóng (Clinic, worker thông báo) khi tải tăng, nhưng việc này chưa từng được đo. Lần đo VM trước chỉ có 100 người dùng và server dùng khoảng 8–9% CPU.
- **Đã đo (12/11):** lượt `full` của `bridge-m-h-vm-v2` trên VM, 34 member, từ 100 đến 800 người dùng, bảng 2×2 (1 hoặc 2 Core × 1 hoặc 2 Clinic) và khối 6.000 thông báo đột biến (1 so với 2 `notification-worker`). Cả 34 member hợp lệ, 0 lỗi trên 3,76 triệu request; số liệu được hai agent tính lại độc lập từ dữ liệu thô và khớp harness. Mã sản phẩm đo là `b02350d` (cộng một dòng script kiểm thử trong `package.json`). Chi tiết, bảng số và giới hạn: [báo cáo bridge](bridge/README-20261028.md), mục "Kết quả VM v2".
- **Kết quả chính:**
  - **Chưa bậc nào bão hòa tới 800 người dùng:** p95 đọc cao nhất 148 ms (ngưỡng QS-10 là 750 ms), 0 lỗi. Chưa biết điểm gãy.
  - **Core là chỗ xếp hàng đầu tiên.** Ở 800 người dùng, nhân Core hạ p95 đọc 58% (H3x2/H3 0,420), nhân Clinic không có lợi (H3cl2/H3 1,204). Chỉ số chính chốt trước (throughput) không đủ nhạy ở tải closed-loop này nên harness ghi mã E; kết luận trên dựa vào chỉ số phụ (p95 đọc, CPU, pool).
  - **Giá của bản tách tăng theo tải:** p95 đọc H3/M từ 3,7× ở 100 người dùng lên 26,5× ở 800; CPU mỗi request 3,8–4,3× ở mọi bậc ([ADR-P14](architecture-work/adr-p14-keep-service-split.md) mục 2).
  - **Chặng gateway, Core, Clinic (H3c/H3, 100 người dùng):** p95 đọc 1,175, CPU mỗi request 1,134, là cận trên của giá ở compose. Điều kiện mở lại D4 (đi qua Core hay đi thẳng) đã xảy ra; **chờ nhóm chốt** ([ADR-P14](architecture-work/adr-p14-keep-service-split.md) mục 4.1).
  - **Đột biến 6.000 thông báo:** không mất event; hai worker xả nhanh hơn khoảng 37% (không phải 50%); thông báo thường sinh trong lúc xả bị xếp sau, p95 từ khoảng 245 ms lên 5–9 s, rồi trở lại bình thường.
- **Khi trình bày, nói kèm:** một phiên VM, hai cặp mỗi tỷ lệ (so sánh mô tả, không phải nghiệm thu công suất); chưa tách được tác động của pool kết nối khỏi tác động của thêm một event loop (khối pool chưa chạy vì không bậc nào bão hòa); 11 trong 34 member có vài dòng lịch hẹn trong DB mà client không ghi nhận phản hồi, chưa rõ nguyên nhân; số VM không so với số Kaggle.
- **Việc kế tiếp:** chốt lại D4; nếu cần biết điểm gãy thì thêm bậc (1.200 và 1.600 người dùng) hoặc tải open-loop; chạy khối pool để tách pool khỏi event loop; kiểm limiter IP ở tải cao.

---

## 4. Hướng dẫn tiếp theo cho các thành viên nhóm

- Đọc [RECEIVER-START.md](RECEIVER-START.md) để dựng môi trường thử độc lập và chạy bộ lệnh kiểm chứng tương ứng với vai trò của mình.
- Xem [POST-H-TASKS.md](POST-H-TASKS.md) để nhận phần việc cụ thể của từng thành viên (**Clinic**, **Notification/UI**, **Core**).
- Tra cứu toàn bộ sơ đồ kiến trúc và kịch bản demo 10 phút tại [`docs/phase2-architecture/README.md`](../docs/phase2-architecture/README.md).
