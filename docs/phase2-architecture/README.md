# Kiến trúc hiện hành — Pha 2 (Pet Healthcare / NIPOPETO)

Bộ tài liệu này mô tả **kiến trúc đang có trong code**: 3 service + RabbitMQ + outbox/inbox + object storage cho ảnh y tế (read model CQRS đã gỡ ngày 28/10/2026). Mỗi khẳng định đều dẫn tới file nguồn, test hoặc evidence.

Tài liệu `docs/01–18` và `docs/diagrams/*.mmd` là ảnh chụp **Pha 1 (modular monolith)**, giữ lại làm lịch sử, không viết lại. Kế hoạch và bằng chứng chi tiết nằm ở `phase2-plan/`.

## Mục lục

| #   | Tài liệu                                                  | Nội dung                                                                                                                       |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 01  | [C4 — System context](01-c4-context.md)                   | Tác nhân, hệ thống, ranh giới tin cậy                                                                                          |
| 02  | [C4 — Containers](02-c4-containers.md)                    | Process, database, broker, cache, gateway; đường gọi đồng bộ và bất đồng bộ                                                    |
| 03  | [C4 — Components: Clinic](03-c4-components-clinic.md)     | Ports/adapters, query port, authorize trì hoãn (ADR-P12), activity reader, Claim Check ảnh y tế; ghi chú projection CQRS đã gỡ |
| 04  | [Data ownership](04-data-ownership.md)                    | Entity → service → DB, tham chiếu chéo, quyền DB                                                                               |
| 05  | [Runtime flows](05-runtime-flows.md)                      | Command → outbox → relay → broker → inbox; đường đọc danh sách (authoritative, authorize trì hoãn); billing                    |
| 06  | [Deployment](06-deployment.md)                            | Compose Pha 2, cổng, credential, rate limit, môi trường đo Kaggle và VM                                                        |
| 07  | [ADR index](07-adr-index.md)                              | Mục lục mọi quyết định kiến trúc kèm trạng thái                                                                                |
| 08  | [Quality scenarios](08-quality-scenarios.md)              | Kịch bản ISO 25010 → tactic → bằng chứng (PASS/NOT_RUN)                                                                        |
| 09  | [Fitness functions](09-fitness-functions.md)              | Các kiểm kiến trúc tự động và ADR mà mỗi kiểm bảo vệ                                                                           |
| 10  | [Observability](10-observability.md)                      | Request/correlation ID, log, metric, health                                                                                    |
| 11  | [AQ status 22/10](11-aq-status-20261022.md)               | Đối chiếu lại 15 finding của Architecture Quality Review; E3 đã sửa E-a (ảnh y tế, AQ-09) và E-b (limiter rescue, AQ-01)       |
| 12  | [Được gì, mất gì 28/10](12-pattern-tradeoffs-20261028.md) | 18 pattern kiến trúc: verdict KEEP / SIMPLIFY / CANDIDATE-REMOVE, kèm số đo bridge M/H (Kaggle và VM) và "ý để trình bày"      |
| 13  | [Kịch bản demo 10 phút](13-demo-10-phut.md)               | Lệnh đã diễn tập trên project test: đặt lịch, thu hồi phiên, service dừng, Claim Check, cái giá đã đo                          |

Các mục 01–13 mô tả đầy đủ kiến trúc hiện hành, thuộc tính chất lượng, fitness functions, observability và kịch bản demo.

**Lưu ý 28/10/2026:** code CQRS projection (projector, read worker, đường đọc projected/shadow, mode `summary`/`control` của activity) đã gỡ khỏi main ở `be2267b`; bản cũ ở tag `cqrs-projection-archive-20261028`. Mục 02, 03, 05 và bảng Pha 1/Pha 2 bên dưới đã viết lại theo trạng thái sau khi gỡ; xem [phụ lục ADR-CQRS-06](../../phase2-plan/cqrs/evidence/adr-cqrs-06.md#phụ-lục-28102026-projection-đã-gỡ-khỏi-main). Mục 06 và 02 có phần object storage (Claim Check + Valet Key). Các tài liệu trong `phase2-plan/cqrs/` mô tả mã đã gỡ, đọc như lịch sử.

## Pha 1 và Pha 2

| Khía cạnh          | Pha 1 (lịch sử, `docs/01–18`)         | Pha 2 (hiện hành)                                                                                                                                                                                              |
| ------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kiểu kiến trúc     | Layered modular monolith, một backend | 3 service trong mono-repo: Core, Clinic & Scheduling, Notification                                                                                                                                             |
| Dữ liệu            | Một PostgreSQL                        | Mỗi service một database, migration, Prisma client và credential riêng; truy cập DB chéo bị chặn ([04](04-data-ownership.md))                                                                                  |
| Giao tiếp          | Gọi hàm trong process                 | HTTP nội bộ có credential theo phạm vi (directory, billing) + sự kiện qua RabbitMQ (transactional outbox, inbox idempotent, at-least-once)                                                                     |
| Đọc danh sách lịch | SQL trên bảng nguồn                   | Port `AppointmentQueries` với một cách triển khai: authoritative (SQL nguồn, snapshot RepeatableRead). Ba GET danh sách của Clinic hỏi Core một lần sau khi đọc dữ liệu (ADR-P12). Projection CQRS đã gỡ 28/10 |
| Thống kê activity  | —                                     | Reader `source` / `cached`, mặc định `source`                                                                                                                                                                  |
| Xác thực           | JWT HS (một khóa)                     | Core ký RS256; Clinic và Notification chỉ giữ public key                                                                                                                                                       |
| Bảo vệ tải         | Limiter cục bộ                        | Redis limiter dùng chung cho auth, public và ghi; GET đếm trong bộ nhớ từng instance; admission/deadline, backlog guard                                                                                        |
| Gateway            | —                                     | Nginx định tuyến theo prefix tới từng service                                                                                                                                                                  |

## Nguồn chính

- Kế hoạch và quyết định: [phase2-plan/01-architecture.md](../../phase2-plan/01-architecture.md), [02-contracts-and-consistency.md](../../phase2-plan/02-contracts-and-consistency.md), [06-functional-nonfunctional-requirements.md](../../phase2-plan/06-functional-nonfunctional-requirements.md), [decisions](../../phase2-plan/evidence/decisions.md)
- Trạng thái triển khai: [phase2-plan/STATUS.md](../../phase2-plan/STATUS.md) (P0–P7 DONE trên môi trường thử, H IN_PROGRESS, P8 TODO), CQRS STATUS (ghi chú nội bộ, không có trong repo)
- Code: [`docker-compose.phase2.yml`](../../docker-compose.phase2.yml), [`packages/`](../../packages), [`services/`](../../services), `backend/src/{composition,gateway,workers}` (`../../backend/src`)
