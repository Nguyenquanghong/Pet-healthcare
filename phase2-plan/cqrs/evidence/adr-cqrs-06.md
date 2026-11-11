# ADR-CQRS-06 — CQRS áp dụng có chọn lọc: danh sách đọc nguồn, projection mặc định tắt

Ngày 23/10/2026. Trạng thái: ACCEPTED (user đồng ý hướng ngày 23/10). Bước 1 của "Chốt CQRS". Đo bản cuối so với O: xem [FINAL-CQRS-20261023](../FINAL-CQRS-20261023.md#đo-bản-cuối-so-với-o-kaggle). **Cập nhật 28/10/2026:** code projection đã gỡ khỏi main (`be2267b`), bản cũ ở tag `cqrs-projection-archive-20261028`; xem [phụ lục](#phụ-lục-28102026-projection-đã-gỡ-khỏi-main).

## Bối cảnh

- K2v2 query-heavy (đo hợp lệ, 3 block): projection (B) chậm hơn đọc nguồn (A) khoảng 25% (B/A median 1,25; gate ≤ 0,80 FAIL). CPU và throughput PASS.
- K3v2 PCN: A chậm hơn O khoảng 1,5× ở mọi endpoint, CPU app A/O 1,11. Đọc lại sau đo cuối: block duy nhất chạy O→A→B nên độ trễ bị thổi phồng bởi hiệu ứng thứ tự; phần CPU vẫn là chi phí thật của phần ghi CQRS. K2v2 B/A đứng ở mọi vòng xoay, nên quyết định không đổi.
- Thí nghiệm local slot admission không đổi primary (B/A 1,07–1,08). Nguyên nhân gốc: projection vẫn JOIN bảng nguồn để kiểm ACL.

## Quyết định

Danh sách lịch hẹn đọc trực tiếp bảng nguồn (đánh giá bằng đo đạc, bị loại). Read model chỉ còn dùng cho tổng hợp khi bật. Công tắc `CLINIC_READ_PROJECTION` (`off` mặc định, `on`):

| Hành vi                                                                             | `off`                                                                                | `on`      |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------- |
| Transaction ghi lịch hẹn                                                            | không ghi `ClinicReadRevision`, không tạo event `clinic.appointment-read-changed.v1` | như trước |
| Read token đọc-sau-ghi                                                              | không phát version (`{}`)                                                            | như trước |
| `readWorker`                                                                        | thoát ngay với `CLINIC_READ_PROJECTION_OFF`                                          | chạy      |
| `CLINIC_READ_MODE=projection` hoặc `shadow`                                         | từ chối khi khởi động (`CLINIC_READ_PROJECTION_REQUIRED`)                            | cho phép  |
| `CLINIC_ACTIVITY_MODE=summary` hoặc `control`, `CLINIC_ACTIVITY_SUMMARY_EVIDENCE=1` | từ chối khi khởi động                                                                | cho phép  |
| `CLINIC_ACTIVITY_MODE=source` hoặc `cached`                                         | cho phép (cache dùng `AppointmentQueryEpoch`, trigger DB, không cần projector)       | cho phép  |

Giá trị khác `off`/`on` làm khởi động thất bại (`INVALID_CLINIC_READ_PROJECTION`). Toàn bộ code CQRS được giữ nguyên để bật lại.

## Bật lại sau một thời gian tắt

Khi tắt, không có version hay event nào được ghi, nên registry và projection cũ lỗi thời. Quy trình: dừng API ghi, chạy rebuild (backfill registry bằng `INSERT ... ON CONFLICT DO NOTHING`, copy, verify, activate) rồi mới bật `on` cho API và khởi động worker. Bật `on` trước khi backfill làm lần ghi đầu tiên lên lịch hẹn cũ thất bại (`READ_REVISION_MISSING_RUN_GUARDED_INITIALIZATION`). Bộ cấu hình A/B của benchmark truyền `on` tường minh.

## Kiểm chứng

Unit `read-projection-switch.test.mjs` (mặc định, cú pháp giá trị, fail fast, no-op khi `off`, ghi revision và event khi `on`); `phase2:test:clinic` khẳng định không có registry và không có event read-changed khi `off`; các suite CQRS và activity đặt `on` tường minh.

## Phụ lục 28/10/2026: projection đã gỡ khỏi main

**Cập nhật trạng thái:** quyết định ở trên (danh sách đọc nguồn trực tiếp, projection tắt mặc định) vẫn đúng. Riêng câu "Toàn bộ code CQRS được giữ nguyên để bật lại" **không còn đúng trên main**: commit `be2267b` (28/10/2026, đã chốt) đã gỡ code projection. Các đoạn trên mô tả hệ thống ở thời điểm 23/10 và được giữ nguyên làm lịch sử; bảng công tắc `CLINIC_READ_PROJECTION` không còn áp dụng. Công tắc này không còn trong `services/clinic`, chỉ còn trong harness benchmark Kaggle (`benchmarks/phase2/kaggle/*`) và test của harness đó.

### Vì sao gỡ

- Đã **đo và thấy chậm**: K2v2 query-heavy B/A median 1,25 (gate ≤ 0,80 FAIL); phần CPU ghi của CQRS là chi phí thật (K3v2, CPU app A/O 1,11). Q6 v9 smoke cũng chưa chứng minh được lợi ích: danh sách chính B/A chỉ −4,0% và B/O +18,1% (INCONCLUSIVE, đánh giá (`q6-effectiveness-20261020.md`)). Phép đo bản cuối F so với O ([FINAL-CQRS-20261023](../FINAL-CQRS-20261023.md#đo-bản-cuối-so-với-o-kaggle)) so cả bản đã tắt projection với baseline O, không phải bằng chứng ủng hộ projection (kết quả theo policy là `FAIL_CORRECTNESS`, lỗi ở baseline O).
- Đã **tắt mặc định từ `46adce9`** (23/10), tức là mã chạy được nhưng không phục vụ request nào. Giữ mã tắt nghĩa là vẫn trả chi phí bảo trì và làm ứng dụng "vụn" thêm: khoảng 1.200 dòng nguồn Clinic, 8 model, 10 migration, queue `clinicRead`, event `clinic.appointment-read-changed.v1`, các header `x-clinic-read-*`, phần frontend `clinicReadState`, 92 file trong `tools/phase2/cqrs` và 16 script `cqrs:*` / `activity:*`.
- Trong rà soát kiến trúc 28/10 (bảng được/mất, [docs/phase2-architecture/12](../../../docs/phase2-architecture/12-pattern-tradeoffs-20261028.md)) pattern này được xếp CANDIDATE-REMOVE: quyết định theo dữ liệu đo, không phải theo cảm tính.

### Đã gỡ (`be2267b`, 142 file, xóa 8.270 dòng)

- Clinic: read revision, read token, freshness, rebuild, diagnostics, read worker và projector, các list query projected/shadow/serving cùng aggregate cache, các mode `summary`/`control` của activity. Lần ghi không còn theo dõi read revision.
- Queue `clinicRead`, event `clinic.appointment-read-changed.v1`, header `x-clinic-read-*` ở gateway của Core và trong cả hai OpenAPI, phần read-token ở frontend.
- Các harness projection, rebuild, fault, summary trong `tools/phase2/cqrs` cùng script npm tương ứng; ba spec E2E của projection.
- Đường danh sách authoritative **không đổi**.

### Giữ lại

- Dashboard activity ở mode `source` (mỗi request đếm bảng lịch hẹn) và `cached` (các bộ lọc giống nhau dùng chung một bản chụp nguồn tối đa 5 giây, trong process). Ở mã hiện tại `cached` không còn đọc `AppointmentQueryEpoch`, khác với mô tả cũ trong bảng công tắc ở trên.
- Mọi migration Prisma và model, để database giữ nguyên lịch sử.
- Các ADR (`adr-cqrs-01` đến `adr-cqrs-06`), báo cáo [FINAL-CQRS-20261023](../FINAL-CQRS-20261023.md) và evidence Q0–Q6.

### Mã cũ nằm ở đâu

- Tag có chú thích **`cqrs-projection-archive-20261028`**, trỏ tới `31a7429` (commit cuối cùng còn đủ code projection). Tag lưu trữ lịch sử phục vụ đối chiếu khi cần.
- Xem một file: `git show cqrs-projection-archive-20261028:services/clinic/src/appointmentProjector.ts`. Lấy lại cả thư mục: `git checkout cqrs-projection-archive-20261028 -- tools/phase2/cqrs`.
- Bật lại projection nghĩa là khôi phục từ tag rồi tự đối chiếu với các thay đổi sau `31a7429` (B+D, gỡ code chết). Quy trình rebuild ở mục "Bật lại sau một thời gian tắt" phía trên chưa được thử lại sau lần gỡ này.
- Các evidence Q0–Q6 trong thư mục này vẫn trỏ tới mã đó: link tới file đã gỡ được đổi thành đường dẫn dạng code kèm "đã gỡ khỏi main ở `be2267b`, còn trong tag `cqrs-projection-archive-20261028`". Link tới `test-results/` đã mất ở sự cố 28/10 10:23 được đánh dấu "bằng chứng gốc đã mất 28/10/2026" (xem [STATUS](../../STATUS.md)).

### Việc còn mở (cần đã chốt một migration tiến)

Gỡ code nhưng giữ migration nên database vẫn mang những thứ code không còn dùng. `code-reviewer` nêu bốn cảnh báo:

1. **Trigger `read_rebuild_fence`** (migration `20261015000300`–`0500`) vẫn chạy trước mỗi lần ghi. Nếu còn `ReadRebuildRun.frozen=true` thì mọi lần ghi lỗi `CLINIC_READ_REBUILD_FROZEN`, và công cụ gỡ trạng thái này đã bị xóa.
2. **Trigger `appointment_query_source_membership`** vẫn tăng epoch `source-acl` trên mỗi INSERT appointment (mọi lần ghi phải chờ khóa của cùng một dòng), trong khi không còn ai đọc epoch đó (ngoài client Prisma sinh tự động, không có file `.ts`/`.mjs` nào trong `services/clinic/src` và `tools/phase2` nhắc tới `AppointmentQueryEpoch`).
3. **Dòng outbox còn tồn** loại `clinic.appointment-read-changed.v1` (nếu có) sẽ bị retry vô hạn mỗi 60 s, vì Clinic không còn contract cho loại này. Queue `*.clinic-read-v1` cũ cũng còn sót trên broker.
4. **`tools/phase2/p7-cutover.mjs:16,20-22`** vẫn grant `ClinicReadRevision` và `lockAnchor` mà không còn ai dùng.

Phương án đã đề xuất (bàn giao 28/10 §7.3, hạng mục A, **chờ đã chốt, chưa làm**): migration drop hai trigger; đánh dấu các dòng outbox loại `clinic.appointment-read-changed.v1` là đã publish (giữ dấu vết, không xóa); bỏ grant trong `p7-cutover.mjs`; sửa comment cũ ở `relay.ts`. Các bảng giữ lại. Sau migration cần chạy lại hồi quy đầy đủ trước khi đo H1 trên VM.

Nhỏ: `apiClient` không còn gửi lại GET đang chạy dở khi có mutation, nên danh sách có thể cũ tối đa một chu kỳ poll (5 s).
