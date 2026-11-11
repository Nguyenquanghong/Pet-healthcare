# ADR-CQRS-01 — Query Clinic authoritative, cùng DB

Ngày 14/10/2026. **ACCEPTED cho Q1; code/local tests đạt, hạ tầng thật chưa kiểm chứng.**

Giữ Core/Clinic/Notification, TypeScript/Express/Prisma và quyền sở hữu dữ liệu hiện tại. Query appointment được tách qua port trong Clinic; MVP dự kiến cùng Clinic DB, không Event Sourcing hoặc DB/service thứ tư. Projection vẫn là thiết kế, chưa triển khai/bật trong lát cắt này.

Hai route `GET /api/appointments` và `/calendar` gọi port `AppointmentQueries`, implementation `AuthoritativeAppointmentQueries`. Parser/envelope dùng chung chuyển nguyên logic sang `infrastructure/queries/authoritativeLists.ts`; `lists.ts` re-export cho medical/image và caller cũ. Calendar dùng groupBy; list giữ ba thao tác ORM không search trong RepeatableRead, total lấy từ status groups. JWT và Core authorize vẫn trước query; port chỉ nhận actor đã xác minh và directory lookup/pet, không truy cập credential hay cấp quyền từ projection.

Selector đọc `CLINIC_READ_MODE` tại composition. Không đặt hoặc `authoritative` dùng source hiện tại; giá trị sai báo `INVALID_CLINIC_READ_MODE`, `shadow`/`projection` báo `CLINIC_READ_MODE_NOT_AVAILABLE` trước khi phục vụ traffic. Không lặng lẽ coi projection đã ready. Khi Q3/Q4 bổ sung implementation, cần generation/readiness guard trước cho phép mode tương ứng. `mode=unbilled` luôn authoritative trong MVP, không dùng projection cho slot/billing/command.

Medical/image/dashboard và mọi command/billing giữ nguồn và nghiệp vụ hiện tại. Chưa projected handler, revision/event mới, migration hoặc thay đổi HTTP contract. Rollback Q1 phục hồi composition/module query; không cần sửa DB.

Quyết định cho các chặng sau: [ADR-02](adr-cqrs-02.md), [ADR-03](adr-cqrs-03.md), [ADR-04](adr-cqrs-04.md); các phần đó chưa implement. [Policy](../acceptance.json) đóng băng ngưỡng trước đo, không phải kết quả PASS. Bằng chứng: Q0 (`q0-baseline.md`), Q1 (`q1-query-separation.md`), inventory (`writer-query-inventory.md`).
