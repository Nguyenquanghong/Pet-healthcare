# ADR-P02/P11 — Bệnh án: khóa lạc quan theo phiên bản, người lập do server quyết định

Ngày 24/10/2026. Trạng thái: ACCEPTED (Quyết định thiết kế: bắt buộc `expectedRevision` ngay; admin chọn bác sĩ, nếu không chọn thì lấy bác sĩ của lịch hẹn).

Căn cứ: đề xuất P02 , P11 .

## Bối cảnh

- Hai người cùng mở một bệnh án rồi lần lượt lưu: bản lưu sau ghi đè bản trước mà không ai biết. Nhật ký AQ-15 có ghi cả hai lần, nhưng chỉ phát hiện được khi đọc lại.
- Form gửi `doctorName` dạng chữ tự do, mặc định "Bs. Mai Nguyễn". Ai có quyền ghi cũng ký được tên người khác, và tên không gắn với tài khoản nào.
- Form sửa gửi `vaccineName || undefined`, `Number(x) || undefined`. Xóa trắng một trường thì JSON bỏ trường đó, server giữ giá trị cũ, nhưng UI vẫn báo thành công.

## Quyết định

1. **Phiên bản (P02):** cột `medical_records.revision` (NOT NULL DEFAULT 0, CHECK ≥ 0). Mỗi lần sửa thành công tăng 1.
   - `PATCH` bắt buộc `expectedRevision` trong body; `DELETE` nhận `?expectedRevision=` trên query (DELETE không có body, Core proxy chuyển nguyên URL). Thiếu hoặc sai kiểu → 422.
   - Repository khóa hàng bằng `SELECT … FOR UPDATE`, rồi so `revision`. Lệch thì ném `StaleRevision` → 409 `MEDICAL_RECORD_STALE`, body kèm `current` là bản đang lưu.
   - Thứ tự khóa: lịch hẹn (trong `medicalMutation`) trước, bệnh án sau. Hai lần lưu cùng lúc xếp hàng trên khóa hàng; lần sau thấy phiên bản đã tăng và bị từ chối thay vì ghi đè.
   - Nhật ký AQ-15 ghi thêm `record_revision` (sau thay đổi; với xóa là trước khi xóa).
2. **Người lập (P11):** cột `medical_records.doctor_id`. `doctorName` trong body bị bỏ qua; tên ký là ảnh chụp tên trong Core lúc tạo.
   - Quyền mới `medical-record.assign-doctor` (chỉ admin) trong ma trận AQ-05.
   - Người có quyền ghi nhưng không có quyền này (bác sĩ) luôn ký tên chính mình, lấy từ snapshot authorize của Core cho request. Ghi tên bác sĩ khác → 403 theo thông điệp của ma trận.
   - Admin ghi cho bác sĩ được chọn (`doctorId`). Không chọn thì lấy bác sĩ của lịch hẹn. Lịch cũng không có thì 422 `MEDICAL_RECORD_DOCTOR_REQUIRED`. Core xác nhận `doctorId` phải là tài khoản vai trò doctor, nếu không thì 422.
   - Sửa bệnh án không bao giờ đổi người lập. Nhật ký AQ-15 vẫn ghi admin là người nhập.
   - Bản ghi cũ giữ `doctor_id` NULL vì không có ánh xạ tên → tài khoản đáng tin. Import P7 đặt `doctor_id: null, revision: 0`.
3. **API:** Core thêm `GET /api/doctors` (quyền `directory.read`) cho ô chọn bác sĩ. Directory authorize/lookup trả `doctor: {id, fullName}` khi request có `doctorId`. OpenAPI Core 75 thao tác.
4. **Frontend:**
   - Admin chọn bác sĩ từ danh sách; bác sĩ chỉ thấy tên mình. Form hoàn tất lịch chọn sẵn bác sĩ của lịch hẹn.
   - Form sửa chỉ gửi các trường đã đổi so với bản đã tải, kèm `expectedRevision`. Trường tùy chọn bị xóa trắng gửi `null`.
   - Gặp 409 thì giữ bản nháp và liệt kê các trường bản mới khác bản đã mở (đánh dấu trường cả hai cùng sửa). Hai lựa chọn: "Dùng bản mới", hoặc "Áp thay đổi của tôi lên bản mới" (chỉ gộp trường người dùng đã sửa, rồi người dùng bấm lưu lại).
   - Xóa với phiên bản cũ → hộp xác nhận chuyển sang bản mới, cần xác nhận lần nữa.

## Bằng chứng

- `phase2:test:clinic` 12/12 trên hai process Clinic và Postgres thật:
  - P02: hai lần lưu tuần tự cùng phiên bản → lần hai 409 kèm `current.revision = 1`, dữ liệu lần một còn nguyên. Hai PATCH song song trên hai process, giữ khóa hàng bằng transaction cho tới khi thấy hai waiter → đúng một 200, một 409. Thiếu/âm/lẻ phiên bản → 422. DELETE phiên bản cũ → 409 và bản ghi còn. Nhật ký: `[create 0, update 1, update 2, update 3, delete 3]`.
  - Xóa trường: PATCH `null` cho vaccine, ngày tái khám, cân nặng, nhiệt độ, nhịp tim → DB lưu NULL thật.
  - P11: bác sĩ gửi `doctorName` giả → bản ghi mang tên thật trong Core; bác sĩ ghi tên bác sĩ khác → 403; admin không chọn, lịch không có bác sĩ → 422 `MEDICAL_RECORD_DOCTOR_REQUIRED`; admin chọn staff → 422; admin hoàn tất lịch có bác sĩ → bác sĩ của lịch, nhật ký ghi admin; PATCH kèm `doctorName` không đổi người lập; `GET /api/doctors` chỉ liệt kê bác sĩ, owner bị 403.
- `permission-matrix.test.mjs`: probe service-level cho `medical-record.assign-doctor`, probe Core cho `GET /api/doctors`.
- UI (mock API) `tools/phase2/ui/clinic.spec.ts`: form tạo gửi `doctorId`, không gửi `doctorName`; form sửa gửi đúng `{expectedRevision, diagnosis, vaccineName: null, weightKg: null}`; sau 409 bản nháp còn, gộp lên bản mới rồi lưu với phiên bản mới; "Dùng bản mới" bỏ bản nháp.
- `phase2:test:migration` 12/12 (P7 nhập bản ghi cũ với `revision 0`, `doctor_id NULL`).

## Trade-off

- Khi admin không gửi `doctorId` mà lịch hẹn có bác sĩ, Clinic hỏi Core (timeout 2 s, có breaker) ngay trong transaction tạo bệnh án. Frontend luôn gửi `doctorId` nên nhánh này chỉ xảy ra với client khác.
- Một PATCH không đổi trường nào (chỉ gửi `doctorName`) vẫn tăng phiên bản và ghi một dòng nhật ký.
- Đường Pha 1 của Core (Core tự phục vụ bệnh án khi chạy không có Clinic, chỉ dùng trong test) không có khóa và không có `doctorId` (P02 §142, xem P08). Test AQ-07 ghi rõ ngoại lệ này và sẽ báo khi ngoại lệ không còn cần.
- Chữ ký là ảnh chụp tên lúc tạo: bác sĩ đổi tên sau đó thì bệnh án cũ vẫn mang tên cũ.
