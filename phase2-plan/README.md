# Pha 2 — Bộ tài liệu thiết kế, kiểm chứng và bàn giao nhóm

Bộ tài liệu này định nghĩa kiến trúc, hợp đồng giao tiếp (API/event), quy trình kiểm chứng và hướng dẫn bàn giao nhóm cho hệ thống **Pet Healthcare (NIPOPETO) Pha 2**. Tiến độ thực thi và bằng chứng kiểm thử tổng hợp nằm tại [STATUS.md](STATUS.md).

## 1. Phạm vi kiến trúc Pha 2

Hệ thống gồm ba service nghiệp vụ độc lập: **Core**, **Clinic & Scheduling**, và **Notification**:

- Giữ nền tảng React / TypeScript / Express / Prisma / PostgreSQL; mỗi service sở hữu schema và database/role riêng biệt.
- Bổ sung **RabbitMQ** (outbox → topic exchange → inbox, retry qua delay queue → DLQ, queue ưu tiên riêng cho thu hồi phiên) và **Redis** (shared rate-limiting).
- **Clinic** sở hữu lịch khám, lịch Spa, bệnh án, ảnh y tế (Claim Check + Valet Key qua S3/MinIO) và tổng hợp hoạt động khám.
- **Core** sở hữu tài khoản, hồ sơ chủ nuôi/thú cưng, lưu trú khách sạn (Hotel), hóa đơn/thanh toán (Billing saga) và đóng vai trò API Gateway chuyển tiếp sang Clinic/Notification qua `ServiceProxy` có Circuit Breaker.
- **Notification** sở hữu hộp thư thông báo, mẫu thông báo theo loại sự kiện, xử lý bất đồng bộ qua consumer/inbox/DLQ.

## 2. Thứ tự đọc dành cho thành viên nhóm

| Tài liệu                                                                                   | Mục đích                                                                                                            |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| [RECEIVER-START.md](RECEIVER-START.md)                                                     | **Điểm bắt đầu khi nhận code**: chuẩn bị môi trường, lệnh dựng stack thử và chạy bộ test xác minh theo từng vai trò |
| [HANDOFF.md](HANDOFF.md)                                                                   | Checklist bàn giao mốc H, gói bàn giao tối thiểu và quy tắc làm việc nhóm sau khi tách service                      |
| [POST-H-TASKS.md](POST-H-TASKS.md)                                                         | Bảng phân công công việc đầu tiên sau mốc H cho từng thành viên (Clinic, Notification/UI, Core)                     |
| [01-architecture.md](01-architecture.md)                                                   | Ranh giới 3 service, quyền sở hữu dữ liệu, sơ đồ kiến trúc, ADR và cấu trúc monorepo                                |
| [02-contracts-and-consistency.md](02-contracts-and-consistency.md)                         | Hợp đồng API công khai/nội bộ, event schema, outbox/inbox, giao thức hóa đơn (prepare/commit/release) và phân quyền |
| [03-delivery-plan.md](03-delivery-plan.md)                                                 | Lộ trình triển khai P0–P7, mốc bàn giao H và kế hoạch kiểm chứng P8 cùng nhóm                                       |
| [04-validation-and-cutover.md](04-validation-and-cutover.md)                               | Ma trận kiểm thử, diễn tập di trú dữ liệu (migration/cutover/rollback) và kịch bản demo bảo vệ                      |
| [06-functional-nonfunctional-requirements.md](06-functional-nonfunctional-requirements.md) | Yêu cầu chức năng (FR) và phi chức năng (NFR), tiêu chí nghiệm thu và ánh xạ vào test tự động                       |
| [07-benchmark-protocol.md](07-benchmark-protocol.md)                                       | Ngưỡng định lượng NFR01–NFR12 và giao thức đo tải đối chứng                                                         |
| [STATUS.md](STATUS.md)                                                                     | Bảng trạng thái triển khai chi tiết và lịch sử bằng chứng P0–P7                                                     |
| [SOURCES.md](SOURCES.md)                                                                   | Nguồn tham chiếu kỹ thuật và phạm vi kiểm chứng                                                                     |

## 3. Liên kết nhanh tới tài liệu kiến trúc & vận hành liên quan

- **Kiến trúc hiện hành chi tiết (C4, Data Ownership, Runtime Flows, Deployment, ADR Index, Observability, Demo 10 phút)**: [`../docs/phase2-architecture/README.md`](../docs/phase2-architecture/README.md)
- **Runbook chạy và kiểm thử từng miền trên Docker**: [`../deploy/phase2/README.md`](../deploy/phase2/README.md)
- **Tổng quan sơ đồ hệ thống**: [`../kien-truc.md`](../kien-truc.md)
- **Danh mục quyết định kiến trúc (ADR)**: [`../docs/phase2-architecture/07-adr-index.md`](../docs/phase2-architecture/07-adr-index.md) và thư mục [`architecture-work/`](architecture-work)

## 4. Quy tắc phối hợp trong nhóm

- Mỗi thành viên làm việc trên nhánh riêng theo phạm vi sở hữu trong [POST-H-TASKS.md](POST-H-TASKS.md).
- Không tự ý thay đổi contract/schema/event xuyên service (`packages/contracts`), xóa migration hoặc sửa shared lockfile/`docker-compose*.yml` khi chưa qua bước review tích hợp.
- Trước khi tạo PR hoặc bàn giao kết quả, chạy `npm run arch:check` và các suite kiểm thử thuộc phạm vi phụ trách theo hướng dẫn trong [RECEIVER-START.md](RECEIVER-START.md).
