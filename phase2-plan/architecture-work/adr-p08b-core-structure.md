# ADR-P08b: Core chia theo vai trò, một bảng route, bản đồ module có rule kiểm

Ngày 5/11/2026. Trạng thái: **ACCEPTED** (áp dụng cột đề xuất Q1–Q4 của thiết kế ngày 1/11; có thể điều chỉnh khi cần). Thực hiện ở K3 của lộ trình cải thiện kiến trúc, thiết kế ở k3-design (`k3-design-20261101.md`). Đề xuất gốc: P08 phần B, mở lại theo D2. Phần A (proxy) ở [ADR-P08a](adr-p08a-service-proxy.md).

## Bối cảnh

- `backend/src/phase2/` (14 file, 1.679 dòng) gom composition, gateway, API nội bộ, saga billing, relay và worker. Tên thư mục chỉ nói thời điểm viết, không nói vai trò.
- Route của Core khai ở hai nơi (`createApp` của monolith và `createCoreDomains`), `helmet`, `cors` khai hai lần. Thêm route phải nhớ sửa cả hai.
- `check-architecture.mjs` chỉ rào `domain`, `application`, `routes`. Phần `phase2/` có khoảng 60 dòng gọi `db.`/`tx.` mà không rule nào nhìn tới.
- Có 8 cạnh import ngược tầng (`lib → application`, `infrastructure → phase2`). `appointmentBilling.ts` 405 dòng trộn validate, tính tiền, HTTP client, Prisma, DTO.
- Không test không cần Docker nào chạy `createCoreDomains`: 20 file test dùng `createApp` của monolith.

## Quyết định

1. **Bố cục theo tầng, giống Clinic.** `backend/src/` có `composition/`, `gateway/`, `workers/`, `routes/` (gồm `routes/internal/`, `routes/dto/`), `domain/`, `application/`, `infrastructure/`, `middleware/`, `lib/`. Gốc chỉ còn `index.ts`, `app.ts`. Thư mục lạ hoặc file gốc lạ làm `arch:check` FAIL.
2. **Bảng tầng ở `backend/scripts/check-architecture.mjs`** (mỗi tầng chỉ import được các tầng ghi trong bảng; `routes`, `gateway` cấm Prisma; `workers` cấm `express`; `composition` lắp mọi tầng trừ `workers`). Ngoại lệ có tên duy nhất: `middleware/currentAccount.ts` `import type` Prisma.
3. **Một bảng route.** `composition/coreRoutes.ts` (`mountCoreRoutes`) là nơi duy nhất khai route của Core. `createApp` và `createCoreDomains` mount cùng danh sách, cùng thứ tự; error handler đứng ngoài. Chỉ các route tách ra service khác đứng riêng. `mountCoreRoutes` nhận cờ `clinical` để K4 tắt router lâm sàng ở split mode.
4. **Tách theo trách nhiệm:**
   - saga billing thành `domain/billing/*` (phí, thuần túy, có unit test), `application/services/appointmentInvoices.ts`, `infrastructure/http/clinicBillingRemote.ts`, repository của `AppointmentBillingOperation`;
   - `mountDirectory` thành service ủy quyền giữ đúng 6 bước của ADR-P13, route mỏng;
   - `createCoreApp`: `composition/config.ts` kiểm env một lần, `authorize-send` về `routes/internal/notificationAuthorization.ts`, `helmet`, `cors` khai một lần.
5. **Hết cạnh ngược:** DTO mapper về `routes/dto/`, contract outbox thành port `application/ports/outbox.ts`, billing service trả hóa đơn thô.
6. **Bản đồ module `tools/phase2/core-modules.json`**, rule `core-module-map`:
   - mỗi file `.ts` ngoài `generated/` thuộc đúng một trong 10 nhóm: 5 context (identity, directory, hotel, billing, rescue) và 5 nhóm phụ (kernel, dto, read, clinical, platform);
   - import chéo nhóm phải khai ở `edges` (6 cạnh), đọc bảng của nhóm khác phải khai ở `dataEdges` (11 cạnh);
   - cạnh đã khai mà không còn dùng thì FAIL, để bản đồ không mục dần.
7. **Test trên composition production:** `onProductionComposition` từ 6 lên 11 file, `legacyAppTests` từ 20 xuống 18 (Q2). Characterization `tools/phase2/core-surface.test.mjs` chạy `createCoreApp` thật ở 3 cấu hình (legacy, domains, split), 75 operation đọc từ `openapi.json`, thứ tự middleware, saga trên double. Golden ghi trên code cũ ở C1 và không đổi tới cuối K3.

## Hành vi đổi có chủ ý

- **Thứ tự mã lỗi khởi động (Q4):** `composition/config.ts` kiểm env trước khi dựng runtime, `serviceProxy`, `ClinicBillingRemote`. Chỉ khác khi sai từ 2 cấu hình trở lên; mọi ca vẫn kết thúc ở `STARTUP_FAILED`, không ca nào đổi từ chạy được sang không chạy được.
- Ngoài ra không đổi HTTP: golden `core-surface` không đổi qua C2–C12, `backend/openapi.json` không đổi. `routeLabel.ts` có thêm nhãn cho 2 route từ K2, chỉ đổi metric.

## Hệ quả

**Số đo** (`tools/phase2/arch-metrics.mjs`, baseline `16c7b15`):

| Chỉ số                                  | Trước K3          | Sau K3            |
| --------------------------------------- | ----------------- | ----------------- |
| S2 cạnh ngược tầng                      | 8                 | 0                 |
| S3 file trong `phase2/`                 | 14                | 0                 |
| S4 nơi khai route Core                  | 3                 | 1                 |
| S5 test trên monolith / trên production | 20 / 6            | 18 / 11           |
| S9 hàm dài nhất, số hàm trên 100 dòng   | 234, 7            | 135, 2            |
| S11 code không chạy ở split mode        | 12 file, 835 dòng | 12 file, 733 dòng |
| S14 file backend trên 400 dòng          | 1                 | 0                 |

`structure-ratchet` làm `arch:check` FAIL nếu bất kỳ số nào ở trên xấu đi.

**Chưa đạt, có chủ đích:**

- S9 còn 2 hàm trên 100 dòng, đều ngoài Core: `consumeEvents` 135 dòng (`packages/messaging`) và `parseEnvelope` 112 dòng (K6).
- S15 tăng 91/104 → 292/305 sau Prettier: code trùng giữa Core và Clinic lộ ra, không phải code mới. Đích ≤ 50 ở K4 cần xem lại.
- `clinical` là nhóm tạm, `dataEdges` còn 11 cạnh; K4 gỡ. Rule chưa bắt quan hệ qua `include`, `select` lồng nhau.
- Hai file `PrismaListsRepository`, `PrismaBootstrapRepository` chưa format (Q1), vì K4 viết lại chúng.

**Cái giá:**

- Đường dẫn `dist` của worker đổi (`backend/dist/src/workers/*`). Harness đo phải biết hai bố cục: bundle M, H1 cũ vẫn chạy ở `phase2/` (K9).
- Commit di chuyển làm `git blame` gãy; đã thêm vào `.git-blame-ignore-revs` (C2, C3).
- Phải giữ `core-modules.json` khi thêm file mới: file chưa gán nhóm làm `arch:check` FAIL. Đây là chủ đích.

## Phương án đã cân nhắc

- **Chia Core vật lý theo `modules/<context>/`:** khoảng 100 file đổi chỗ, và hóa đơn với hotel dùng chung transaction nên ranh giới không sạch. `core-module-map` cho phần lớn giá trị với rủi ro nhỏ hơn, lại giữ bố cục giống Clinic.
- **Giữ `phase2/`, chỉ thêm rule:** rule phải đọc theo từng file vì thư mục không nói vai trò. Không giải quyết hai bảng route.
- **Test "không runtime" riêng:** không cần, vì runtime thật chạy được với fake `$transaction` và limiter cục bộ (`backend/tests/core-composition-helper.mjs`).

## Bằng chứng

- Cổng Nhanh mỗi commit; Docker theo từng commit ở §10 của thiết kế; cổng Đủ cuối gói (bàn giao §2).
- `code-reviewer` (Opus) review C4b, C5, C6, C7, C9: PASS, không BLOCKER.
- C5: so song song cũ/mới 4.187 ca, đối chứng âm 9 mutant. C11: 4.400 ca, 20/20 mutant bị bắt.
