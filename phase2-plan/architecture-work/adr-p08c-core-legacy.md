# ADR-P08c: Monolith Pha 1 nằm riêng ở `legacy/`, split mode không nạp code lâm sàng, code proof ra fixture

Ngày 6/11/2026. Trạng thái: **ACCEPTED**. đã chốt Q3, Q4, Q7, Q8, Q9 ngày 5/11; các câu còn lại theo cột đề xuất. Thực hiện ở K4 của lộ trình cải thiện kiến trúc, thiết kế ở k4-design (`k4-design-20261105.md`). ADR này nối tiếp [ADR-P08b](adr-p08b-core-structure.md) và không sửa nó.

## Bối cảnh

- Sau K3 còn 12 file Core (733 dòng) không chạy ở split mode: 11 file Pha 1 (router và repository lâm sàng, `app.ts` của monolith) và `persistence/billing.ts` của proof. Chúng nằm lẫn trong các tầng chung.
- Bốn repository dùng chung (vòng đời booking, hóa đơn, list, bootstrap) có nhánh đọc bảng appointment, medical record, medical image, notification. Ở split mode Clinic sở hữu các bảng này, nhưng Core vẫn mount router cũ. Chỉ `serviceProxy` đứng trước che đi.
- Code chỉ `proof.test.mjs` dùng nằm trong `src` của Core và Clinic: `CoreBilling`, `ClinicBilling`, nhánh `ProofAppointment` trong inbox của Clinic.
- `core-modules.json` có nhóm tạm `clinical` và 11 `dataEdges`. Rule không thấy lượt đọc qua quan hệ lồng (`include`, `select`, `where` theo field quan hệ).

## Quyết định

1. **`backend/src/legacy/` giữ monolith Pha 1** (Q1). Thư mục có tầng như phần còn lại (`routes/`, `infrastructure/persistence/`, `app.ts`, barrel `index.ts`), dời bằng `git mv`, không để shim. 11 file Pha 1 vẫn không format, ghi ở `.prettierignore` (D3).
2. **Split mode là "có Clinic URL"** (Q2). `servesClinical(settings) = !settings.clinic` ở `composition/config.ts` quyết một lần cho cả hai đuôi composition: `createCoreDomains(db, { clinical })` và `createApp(db, { clinical })` (mặc định `true`). Khi `clinical` là false:
   - không router lâm sàng, không router dashboard lâm sàng;
   - router `/api/notifications` trong process chỉ mount khi `monolith && clinical`;
   - repository dùng chung không nhận nguồn lâm sàng nào.
3. **Repository dùng chung nhận nguồn lâm sàng qua port, legacy cung cấp:**
   - `lifecycleByKind` chọn store theo `kind`: store hotel ở Core, store appointment ở legacy;
   - `PrismaInvoiceRepository` nhận `appointmentSource` tùy chọn; thiếu nguồn thì service trả 404;
   - `ClinicalListSource` cho list lâm sàng;
   - `ClinicalBootstrapSource`, `NotificationBootstrapSource` cho bootstrap. Các nguồn này trả `PrismaPromise` thô, không `async`, để `Promise.all` giữ thứ tự query cũ.
   - Mọi nguồn chạy trên `tx` của transaction gọi nó, giữ thứ tự khóa cũ.
4. **Code proof ra fixture** (Q3). `tools/phase2/fixtures/p1-proof/{coreBilling,clinicBilling,proofInbox}.ts`. `proofInbox.ts` giữ nguyên văn nhánh cũ của inbox; event directory vẫn đi qua `ClinicInbox` thật.
5. **Inbox của Clinic không còn nhánh proof** (Q4). Billing event thiếu `appointmentId` bị ném `UNSUPPORTED_EVENT` trước transaction, là lỗi permanent, vào DLQ ngay.
6. **Rule mới:**
   - `legacy-isolated` (rule 17): file Core ngoài `legacy/` đọc bảng lâm sàng thì FAIL. Rule bắt delegate Prisma (kể cả `?.` và gọi quan hệ fluent), key quan hệ lồng của model trong schema, và SQL thô có tên bảng (cả tiền tố schema, `TRUNCATE`). Rule tự kiểm vẫn thấy ít nhất 20 lượt đọc trong legacy, để không âm thầm thành rỗng.
   - `clinic-inbox`: kiểm số 17 của `arch:check`, inbox từ chối billing event thiếu `appointmentId` (không transaction, lỗi permanent).
   - `core-module-map` có nhóm `legacy` thay nhóm `clinical`. Chỉ `legacy/app.ts` được import platform; chỉ platform và legacy được import legacy; chỉ legacy đọc bảng của nhóm này.
   - `core-module-map` thấy bảng đọc qua quan hệ lồng (Q6): `include`, `select`, `where`, `_count`, API fluent. Map quan hệ sinh từ `schema.prisma`; rule dùng chung bộ đọc với `legacy-isolated`. Còn lọt: object trong biến không khai kiểu (2 chỗ, đều trong cùng context), key tính toán hoặc có nháy.
7. **`dataEdges` giữ 8 cạnh dữ liệu trong cùng DB Core, cộng `rescue → identity` lộ ra ở C10b** (Q5), mỗi cạnh có ghi chú file nào đọc. Gỡ chúng phải thêm port giữa các context và đổi query, khoảng 2 công; để sau.

## Hành vi đổi có chủ ý

- **Inbox của Clinic (Q4):** billing event không có `appointmentId` vào DLQ ngay, không qua thang retry. Trước đây nó rơi vào `findUniqueOrThrow` (P2025) và đi hết thang retry rồi mới vào DLQ. Kết cục như nhau, khác số lần thử và header. Chỉ proof sinh event dạng này.
- **Cấu hình không runtime nhưng có Clinic URL:** bootstrap không còn đọc bảng lâm sàng cũ của Core; các ô đếm lâm sàng là 0. Cấu hình này chỉ có trong test (`service-proxy.test.mjs`).
- **`GET /api/notifications` trên `createCoreDomains(db, { clinical: false })` gọi trực tiếp,** không qua `createCoreApp`: trả 404 thay vì list. Chỉ `core-composition` dựng cấu hình này.
- **Hệ quả cho D4:** nếu Core bỏ `serviceProxy`, prefix lâm sàng ở Core rơi vào 404 chung, không còn split-brain (hai nơi cùng trả lời một path).
- Ngoài các điểm trên, HTTP không đổi: golden `core-surface` giữ nguyên qua K4, `backend/openapi.json` không đổi, không migration.

## Hệ quả

**Số đo** (`tools/phase2/arch-metrics.mjs`; trước là baseline `16c7b15`, sau đo ở `850943f`, C11 ghi baseline):

| Chỉ số                                            | Trước K4          | Sau K4           |
| ------------------------------------------------- | ----------------- | ---------------- |
| S11 code không chạy ở split mode, ngoài `legacy/` | 12 file, 733 dòng | 0 file, 0 dòng   |
| S11 lượt đọc bảng lâm sàng ngoài `legacy/`        | (chưa đo)         | 0                |
| S12 code chỉ proof dùng trong `src`               | 2 file, 1 nhánh   | 0, 0             |
| S9 hàm trên 80 dòng                               | 10                | 9                |
| S15 cửa sổ 6 dòng trùng (ngoài legacy / tất cả)   | 292 / 305         | 287 / 311        |
| `core-module-map` edges / dataEdges               | 6 / 11            | 4 / 9            |
| `arch:check`                                      | 16 kiểm, 20 rule  | 17 kiểm, 21 rule |

**Đọc số cho đúng:**

- Chỉ một cạnh thật sự được gỡ: `hotel → clinical` (C5, `lifecycleByKind`; hotel không còn import code lâm sàng). Phần còn lại của mức giảm `edges` 6 → 4 và `dataEdges` 11 → 8 là nhờ **miễn** coupling của nhóm `legacy`, không phải đã gỡ coupling. Trong lúc làm (C5–C9), nhóm `clinical` có thêm 3 cạnh import (tới `billing`, `read`, `identity`), nên ngay trước C10 là 8 cạnh; C10 miễn cả 4 cạnh import và 3 cạnh dữ liệu của nhóm, còn 8 cạnh dữ liệu. C10b (Q6) cho rule thấy quan hệ lồng và lộ ra một cạnh có từ trước, `rescue → identity` (`publicRescueRepository` đọc `user` qua `Pet.owner`), nên `dataEdges` là 9. Legacy vẫn import hotel (`bookingLifecycle`), billing (`invoiceRepository`), identity (`middleware/auth`) và đọc `pet`, `bookingStatusEvent`, `invoice`. Ghi chú của nhóm trong `core-modules.json` nói rõ điều này.
- S15 ngoài legacy giảm 292 → 287, nhưng `windowsAll` tăng 305 → 311 có chủ ý: khối đếm notification chép vào legacy phải qua Prettier (C7), và Prettier xổ `emptyListData` ra khớp data mặc định của Clinic, Notification (C7b). Đích S15 ≤ 50 dời sang K6 (Q7); K4 chỉ cam kết S15 ngoài legacy không tăng.

**Còn lại, có chủ đích:**

- **Proof còn lại (Q10):** `workers/outbox.ts` (proof worker, `worker:built`), `ProofOutboxStore` và schema `phase2-core` vẫn ở `src`. `resilience.test.mjs` dùng `ProofOutboxStore`. S12 giữ định nghĩa cũ nên không đếm chúng.
- **`TERMINAL_CONFLICT`** (`messagingErrors.ts`) không còn ai ném sau Q4. Giữ lại, vì contract lỗi messaging dùng chung.
- **Contract `appointmentId` (Q9) để K6.** Bắt buộc trường này trong `packages/contracts` cần kiểm hàng `*.clinic.dlq` trên compose và VM trước.
- **`BILLING_TERMINAL_CONFLICT` của Clinic** không nằm trong danh sách permanent. Lỗi có từ trước K4, do review C4 tìm ra: xung đột terminal thật chạy hết thang retry khoảng 12,6 phút rồi mới vào DLQ. Đề xuất sửa trong commit riêng.
- `LifecycleBooking.internalNote` để tùy chọn (C5). Bắt buộc nó làm vỡ `BookingPatch` vì hai kiểu dựng từ cùng một gốc; cần tách hai kiểu.

**Cái giá:**

- Mỗi repository dùng chung có thêm một port và một tham số constructor tùy chọn. Quên truyền nguồn ở monolith thì list lâm sàng trả lỗi `LIST_RESOURCE_UNAVAILABLE` thay vì dữ liệu; test composition khóa điều này.
- Nguồn bootstrap phải trả `PrismaPromise` thô. Viết `async` sẽ đổi thứ tự query trong `Promise.all` mà không test đơn vị nào thấy; bộ so song song có mutant đúng điểm này.
- Ba commit format (C7b, C8b) có commit blame-ignore đi kèm.

## Phương án đã cân nhắc

- **Viết lại proof trên lớp thật (Q3a):** khoảng 1 công, và proof đổi nghĩa. Fixture giữ proof đúng như lúc đo.
- **Lỗi transient `BILLING_APPOINTMENT_REQUIRED` (Q4):** giữ thang retry cho một event không bao giờ hợp lệ.
- **Gỡ hết `dataEdges` (Q5):** khoảng 2 công, thêm port giữa context đang chung một DB.
- **Giữ đích S15 ≤ 50 ở K4 (Q7):** phải tách code dùng chung giữa các service ngay, khoảng 2–3 công, ngoài phạm vi cô lập legacy.
- **Shim re-export ở `backend/src/app.ts` (Q1):** không cần, harness đo không import `app.js`.

## Bằng chứng

Evidence local ở `phase2-plan/evidence/k4-gates-20261105/`.

- **Cổng:**
  - cổng Nhanh mỗi commit;
  - integration Postgres 12/12 sau mỗi commit chạm repository;
  - e2e 18/18 ở C7, C8, C9; ingress 10/10 ở C9;
  - golden `core-surface` không đổi.
- **So song song cũ/mới**, trên DB giả ghi log lúc `then`, `tx` có nhãn riêng:
  - C5: 8.746 ca, 32/32 mutant;
  - C6: 4.543 ca, 22/22 mutant;
  - C7: 9.082 ca, 64/64 mutant (C7b 70/70);
  - C8: 3×1.360 ca repository, 1.088 request dashboard, 88/88 mutant (C8b 101/101).
- **Một lỗi trong bộ so được sửa:** `normalize` từng che đảo chiều `orderBy createdAt`. Đã sửa regex và chạy lại ba bộ so cũ: 0 lệch, 4 mutant đảo chiều mới đều bị bắt.
- **Review:** `code-reviewer` (Opus) PASS ở C4, C5, C6, C7, C8, C9, C10, C10b, không BLOCKER. Lưu ý đã sửa trước commit. Ở C10b, reviewer so bộ đọc lâm sàng cũ và mới trên 1.775 đầu vào: 0 khác biệt.
