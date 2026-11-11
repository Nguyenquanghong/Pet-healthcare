# ADR-P10 — Lịch hẹn theo tài nguyên: khung giờ, sức chứa theo slot, chống trùng pet và bác sĩ

Ngày 24/10/2026. Trạng thái: ACCEPTED (đã chốt luật ngày 23/10, xem tài liệu thiết kế §1). Căn cứ: P10 . Commit `4a870b7`.

## Bối cảnh

- Lịch hẹn chỉ là một mốc ngày + `HH:MM`, không có thời lượng hay tài nguyên. Ràng buộc duy nhất: cùng pet không trùng **đúng** ngày giờ.
- Qua API đặt được lúc `03:17`; hai pet cùng bác sĩ cùng lúc; cùng pet khám `09:00` và Spa `09:15`; 20 lịch Spa cùng `09:00`; Spa lúc `11:00` dù frontend không cho chọn.
- Khung giờ Spa chỉ nằm ở frontend (`SPA_TIME_SLOTS`).

## Quyết định

1. **Luật (đã chọn):** khám 08:00–17:30, bước 30 phút, 30 phút một lượt (phẫu thuật 120); 2 chỗ mỗi slot cho nhóm khám. Spa giữ 5 khung 09:00, 10:30, 13:30, 15:00, 16:30, mỗi lượt 90 phút, 2 chỗ mỗi slot dùng chung cho 3 loại Spa. DB chặn bác sĩ trùng giờ khi lịch có `doctorId`.
2. **Policy as data:** bảng `appointment_resource_groups` (sức chứa, giờ mở/đóng + bước, hoặc danh sách khung cố định) và `appointment_type_policies` (nhóm, thời lượng) do migration seed. Service đọc qua port `slotPolicy`; domain `scheduling.ts` có Value Object `TimeRange` và Specification `checkSlot` (422 `APPOINTMENT_OUTSIDE_HOURS`, `APPOINTMENT_SLOT_MISALIGNED`).
3. **DB là chốt chặn cho luật cần đồng thời**, trên lưới 30 phút, bằng trigger:
   - `appointment_schedule_times` (BEFORE) tính `starts_at`, `ends_at` từ ngày, giờ, loại theo giờ Việt Nam, cho mọi đường ghi.
   - `appointment_schedule_sync` (AFTER, SECURITY DEFINER) giữ ba bảng: `appointment_slot_usage` (đếm theo nhóm và slot, `CHECK booked <= capacity` như AQ-10), `appointment_pet_slots` và `appointment_doctor_slots` (khóa chính theo pet/bác sĩ và slot). Vi phạm thành 409 `APPOINTMENT_SLOT_FULL`, `APPOINTMENT_PET_OVERLAP`, `APPOINTMENT_DOCTOR_BUSY`.
   - Trạng thái chiếm chỗ lấy từ bảng vòng đời P01; rule `lifecycle-from-table` kiểm cả hai hàm trigger.
4. **Không dùng exclusion constraint + `btree_gist`** như đề xuất gốc: DB test của Clinic có hàng chục schema của các harness; extension chỉ cài được vào một schema, các schema khác sẽ thiếu operator class. Bảng slot do trigger quản lý cho cùng bảo đảm mà không cần extension.
5. **Lịch sử:** lịch có trước migration (và lịch P7 nhập) có `schedule_checked = false`: vẫn được đếm vào sức chứa (slot đã quá sức chứa thì lấy số hiện có làm sức chứa, như AQ-10) nhưng không vào bảng pet/bác sĩ, vì dữ liệu cũ có thể đã chồng giờ. Đổi giờ một lịch cũ thì lịch đó được kiểm. P7 tắt trigger khi nhập, đánh dấu lịch nhập là lịch cũ, rồi gọi `appointment_schedule_rebuild()`.
6. **Query Object** `GET /api/appointments/availability?type=&date=[&doctorId=]`: các khung giờ trong ngày, số chỗ còn (nhỏ nhất trên các slot 30 phút lượt khám chiếm), `past`, `available`. `doctorId` chỉ cho staff (`booking.manage`). Chỉ là gợi ý; lúc tạo lịch vẫn kiểm lại.
7. **Frontend:** `SlotPicker` thay `SPA_TIME_SLOTS` và ô nhập giờ tự do ở 4 form (đặt khám, đặt Spa, đổi lịch của chủ nuôi, tiếp nhận tại quầy). Slot hết chỗ, đã qua hoặc bác sĩ bận hiện nhưng bị khóa.
8. Runtime P7 chỉ có SELECT trên 5 bảng mới; trigger SECURITY DEFINER ghi.

## Bằng chứng

- Migration thử trên một schema tạm trước khi nối mã: đầy slot, chồng giờ pet và bác sĩ, hủy trả chỗ, đổi giờ chuyển slot, `rebuild` khớp số đếm tăng dần. Phát hiện và sửa: trigger AFTER `UPDATE OF starts_at` không chạy khi `starts_at` do trigger BEFORE đổi, nên danh sách cột phải có `appointment_date, appointment_time`.
- `phase2:test:clinic` 13/13, test P10 mới trên hai process Clinic và Postgres thật:
  - `03:00`, `17:30`, phẫu thuật `16:00` → 422 `APPOINTMENT_OUTSIDE_HOURS`; `09:10` và Spa `11:00` → 422 `APPOINTMENT_SLOT_MISALIGNED`.
  - 10 lịch đồng thời vào một slot có 3 chỗ → đúng 3 × 201, 7 × 409 `APPOINTMENT_SLOT_FULL`; bộ đếm 3/3. Ghi thẳng vào DB, bỏ qua service, cũng bị chặn.
  - Availability báo slot hết chỗ; hủy một lịch thì còn 1 chỗ và pet khác đặt được. Đổi lịch vào slot đầy → 409, lịch giữ giờ cũ.
  - Cùng pet: Spa 10:30 rồi khám 11:00 → 409 `APPOINTMENT_PET_OVERLAP`; 12:00 được. Cùng bác sĩ 14:00 → 409 `APPOINTMENT_DOCTOR_BUSY`; 14:30 được (khoảng nửa mở). Owner hỏi lịch bận của bác sĩ → 403; staff thấy `14:00`, `14:30` bận.
  - Spa liệt kê đúng 5 khung, 90 phút, chỗ dùng chung giữa 3 loại Spa.
- UI: form đặt khám hiện slot của server, slot hết chỗ bị khóa, giờ đã chọn được gửi đi.
- Hồi quy trước commit (24/10): `npm test`, phase2:build, frontend build, contracts 23/23 (số thao tác Clinic 26 → 27), boundaries, arch:check 10/10, notification-writers, source 10/10, OpenAPI 76, cqrs unit 89/89, clinic 13/13, integration 12/12, notification 6/6, notification-runtime 14/14, billing 12/12, clinic-relay 8/8, core-relay 4/4, request-performance 12/12, resilience 18/18, migration 12/12 (P7 nhập lịch cũ), UI 23/23, E2E 18/18.
- E2E lần đầu 15/18: helper `appointment()` đặt Spa lúc `10:00`, không thuộc khung Spa → 422. Đổi mặc định sang `10:30` (cả `e2e/activity.spec.ts`). notification-runtime lần đầu 13/14 ở test sức chứa hotel AQ-10, không liên quan P10: khoảng đọc tới `day(6)`, dư một đêm sau ngày trả phòng, nên dòng 0 còn sót của lần chạy cũ làm so sánh lệch. Sửa riêng ở commit `6002b31`.

## Trade-off

- DB test dùng lâu dài giữ lịch của mọi lần chạy, nên các suite không kiểm sức chứa nâng sức chứa lên 1000 (`tools/phase2/appointment-capacity.mjs`, giống fixture AQ-10). Test sức chứa tự đặt giá trị trên một ngày riêng.
- Lịch cũ không được kiểm chồng giờ với lịch mới (chỉ tính vào sức chứa). Muốn ép toàn bộ thì phải xử lý dữ liệu cũ trước, không bao giờ trên DB chính.
- Lịch hôm nay đặt vào một giờ đã qua vẫn được nhận (luật cũ chỉ cấm ngày đã qua); availability đánh dấu `past` để giao diện không đề xuất.
- Mô tả gói Spa ở frontend vẫn ghi 60/90/120 phút (thời gian chăm sóc), trong khi chỗ giữ là 90 phút cho mọi gói. Ghi chú cấu hình có muốn Spa trọn gói giữ 120 phút không.
- Chưa có API cho admin đổi sức chứa hay giờ mở cửa; đổi bằng DB. Index cũ `appointments_active_pet_slot_key` vẫn giữ.
- Các harness CQRS/activity đã đóng băng (chạy từ bản nguồn ghim) ghi hàng loạt lịch ở giờ tùy ý; chạy lại ở local sau P10 cần nâng sức chứa và dùng giờ đúng lưới.
