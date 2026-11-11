# Clinic & Scheduling

Express/TypeScript runtime riêng, Prisma schema/client/database riêng. Sở hữu
Appointment (khám và Spa), MedicalRecord, MedicalImage và appointment history.
Core sở hữu tài khoản/owner/pet, hotel và tài chính; Notification sở hữu inbox UI.

`src/index.ts` chạy API, `src/worker.ts` chạy outbox/inbox/directory sync.
`prisma/migrations` giữ cả proof P1 và model đầy đủ P3; không dùng proof tables
cho public appointment/medical flow. `openapi.json` mô tả 16 public operations
và private bootstrap cùng năm billing operations.

Chạy và kiểm chứng theo [runbook](../../deploy/phase2/clinic-runtime.md).
Không chạy migration với URL DB demo/đang dùng. Test P3:

```powershell
npm run phase2:up
npm run phase2:build
npm run phase2:test:clinic
```

P4 có actual reservation HTTP/inbox; Core có operation/reconciler riêng.
Xem [billing runbook](../../deploy/phase2/billing-runtime.md), kiểm bằng
`npm run phase2:test:billing`. Chưa migration dữ liệu thật/cutover P7.

## Admin Clinic activity (D1)

`GET /api/dashboard/clinic/activity?from=2030-09-21&to=2030-10-20&groupBy=day&category=all`
chỉ cho admin hiện hành, qua Core directory ở mọi request kể cả cache hit.
Chỉ nhận from/to, groupBy=day|month và category=all|clinic|spa; tối đa366 ngày.
Semantics ngày hẹn SQL DATE/trạng thái hiện tại, tỷ lệ dạng ratio hoặc null,
current/previous chung read-only RepeatableRead snapshot.

`CLINIC_ACTIVITY_MODE=source` mặc định; `cached` dùng absolute TTL5s từ snapshot,
max128 entries, một compute và tổng tối đa4 waiter/coalescer mỗi API instance.
Source tối đa2 concurrent, không queue; SQL1500ms, transaction budget2500ms.
Mode do server quyết định, độc lập `CLINIC_READ_MODE`; D1 không bật projected list.
Response no-store, metadata source/cached; quá tải/lỗi source trả503, không số0 giả.

Từ repo root, `npm run activity:test:unit`, `npm run activity:test:ui` và
`node tools/phase2/cqrs/activity/manifest.mjs` kiểm local. `activity:build` tái dùng
generated clients tương ứng đã có (schema không đổi), bỏ prebuild generate để
không tải engine; fresh checkout cần chuẩn bị client bằng quy trình generate
chuẩn, không cần migration cho D1. PostgreSQL parity riêng:
`npm run activity:test:postgres -- --help`; chỉ chạy `--context` trên trial đã
guard/seed được giao, không là lệnh khởi tạo DB. Xem [báo cáo benchmark và bằng chứng](../../phase2-plan/cqrs/clinic-activity/BENCHMARK-FINAL.md).
