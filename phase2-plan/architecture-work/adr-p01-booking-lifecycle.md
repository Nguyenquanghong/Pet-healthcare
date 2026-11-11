# ADR-P01 — Vòng đời đặt lịch là một bảng trong contracts (bản gọn)

Ngày 24/10/2026. Trạng thái: ACCEPTED, bản gọn (Quyết định thiết kế: tuần 2 làm "P01 bản gọn + P10"). Căn cứ: P01 .

## Bối cảnh

- Quy tắc "trạng thái nào sang trạng thái nào, ai được làm, dữ liệu liên kết nào chặn" được viết tay ở hai service (Core cho cả lịch hẹn lẫn hotel, Clinic cho lịch hẹn), thêm ở `completeAppointment`, job hết hạn hotel và các truy vấn/SQL "đang chiếm chỗ".
- Hai bảng lịch hẹn của Core và Clinic đang giống nhau, nhưng không gì giữ chúng giống nhau. Tập "chiếm chỗ" trong SQL được giữ đồng bộ bằng comment.

## Quyết định

1. **State machine dạng bảng** ở `packages/contracts/src/bookingLifecycle.ts` (không dùng State pattern dạng class: 13 trạng thái của 2 loại booking sẽ thành 13 class mà SQL và test không dùng lại được). Bảng gồm: danh sách trạng thái, `occupying`, chuyển trạng thái thủ công (đích, quyền, guard), chuyển trạng thái hệ thống (`medical-completed`, `pending-expired`), hoàn tác, hủy và đổi lịch của chủ nuôi, nhãn dùng trong thông báo.
2. **Guard có tên** (`no-medical-record`, `no-active-invoice`, `no-care-note`, `final-invoice-paid`). Bảng chỉ khai guard nào áp dụng; service hiện thực guard trong transaction (Strategy theo tên). Clinic chỉ kiểm được hai guard đầu, và từ chối khởi động nếu bảng lịch hẹn nêu guard khác (fail fast).
3. Bảng được chép **nguyên** từ mã cũ, kể cả ngoại lệ: trả thú cưng cần hóa đơn cuối đã thu và cho phép hóa đơn/nhật ký chăm sóc; mở lại lưu trú đã trả chỉ chặn khi có bệnh án.
4. Hai `BookingLifecycleService` hỏi bảng (`manualTransition`, `undoRule`, `cancelRule`, `rescheduleRule`, `statusLabel`); thông điệp lỗi và thứ tự kiểm giữ nguyên. `completeAppointment` (Clinic) và job hết hạn (Core) dùng `system`; `hasSlot` (Clinic) và `hasOverlappingStay` (Core) dùng `occupying`.
5. **Fitness function:**
   - `lifecycle-from-table` (trong `check-architecture-rules.mjs`): hai service vòng đời không chứa literal trạng thái (trừ tên action của status event); mọi trạng thái có nhãn; mọi predicate `status (NOT) IN (...)` trong SQL định nghĩa `appointments_active_pet_slot_key`, `hotel_bookings_pet_active_stay_excl`, `hotel_room_nights_sync` khớp `occupying` (hoặc phần bù khi `NOT IN`). Có negative fixture.
   - `permissions-from-matrix` coi quyền nêu trong bảng là đã kiểm khi service gọi `authorize(actor, rule.permission)`.
   - `tools/phase2/lifecycle-matrix.test.mjs` sinh từ bảng, nằm trong `arch:check` (10 kiểm).

## Bằng chứng

- Test đặc tả `lifecycle-matrix.test.mjs` viết trước, chạy trên **service cũ** (chưa đọc bảng): 9/9 PASS. Với mọi `(loại, từ, đến)`, Core (lịch hẹn, hotel) và Clinic (lịch hẹn) chấp nhận đúng các bước bảng cho phép; mỗi guard bị vi phạm chặn đúng các bước bảng nêu và không chặn bước khác; hoàn tác theo vai trò (staff/doctor không mở lại được); hủy và đổi lịch của chủ nuôi, kể cả chủ khác bị 403.
- Mutation trên bảng (bản build): bỏ `confirmed → no_show` → 2 FAIL (Core và Clinic); thêm guard hóa đơn cho mở lại lưu trú → 1 FAIL (Core hotel). Khôi phục → PASS.
- Sau khi service đọc bảng: matrix 9/9, contracts 23/23 (thêm 5 test nhất quán của bảng), unit backend 100/100, arch:check 10/10.

## Bước 6–7: `allowedActions` (24/10, commit `62953f0`)

Làm theo §9 của đề xuất: chưa có câu trả lời về nhãn thì vẫn làm đến bước 6. Phần nút của bước 7 cũng làm luôn; nhãn để nguyên.

- **Hàm `allowedActions(kind, status, role, owns)`** trong contracts đọc bảng và ma trận quyền. Kết quả gồm:
  - `transition` và `undo` mà vai trò được làm;
  - `step` `medical-completed`: bước hệ thống, nay ghi quyền `medical-record.write` trong bảng; lưu bệnh án là hoàn tất lượt khám;
  - `cancel` và `reschedule`: chỉ cho chủ của booking.
- Guard theo dữ liệu (bệnh án, hóa đơn, nhật ký) không được tính, để danh sách khỏi tốn thêm query. Server vẫn trả 409 kèm lý do.
- **DTO:** `appointmentDto` (Clinic, Core) và `hotelBookingDto` (Core) nhận người xem (`role`, `sub`) thay cờ owner. OpenAPI hai bên có schema `BookingAction` (`oneOf` đúng 3 dạng) và trường bắt buộc `allowedActions`; kiểu frontend được sinh lại.
- **Frontend:** `utils/bookingActions.ts` `hasAction()` thay các phép so `status` và `userRole` ở trang lịch hẹn admin, hotel admin, danh sách lịch của chủ nuôi và trang hotel của chủ nuôi. Hai thay đổi người dùng thấy được:
  - staff không còn thấy nút "Tạo bệnh án" (vốn bị 403 vì không có quyền ghi bệnh án);
  - "Mở lại dịch vụ" chỉ admin thấy, như trước nhưng nay do server quyết định.
  - Nút nhắc lịch, link hóa đơn và nhật ký lưu trú vẫn theo trạng thái, vì đó không phải bước vòng đời.
- **Test:**
  - contracts 25/25: mọi vai trò và trạng thái; mọi bước thủ công đều có vai trò thấy được.
  - Clinic 14/14, chạy trên process thật: đi hết lượt khám bằng đúng các bước server liệt kê, mỗi bước đều được nhận; bác sĩ thấy `medical-completed`, staff thì không; có bệnh án thì mở lại bị 409.
  - UI 24/24, có spec mới. Mutation đưa "Tạo bệnh án" về điều kiện theo `status` thì spec FAIL.
  - Validator strict từ chối action sai dạng. Test AQ-10 kiểm owner hotel chỉ có `cancel`.
  - Hồi quy: `npm test`, arch:check 10/10, integration, notification, notification-runtime, billing, relay, request-performance, resilience, migration, E2E 18/18.
- **Chi phí:** 100 nghìn lần gọi mất 37–66 ms (khoảng 0,4 µs mỗi dòng), không đáng kể so với một trang 20 dòng.

## Chưa làm (phần còn lại của P01)

- Thống nhất bộ nhãn hiển thị ở frontend (4 bảng nhãn): **cần đã chọn** (§9 của đề xuất có bộ mặc định). Nhãn trong thông báo giữ nguyên chữ cũ.
- Code lâm sàng Pha 1 của Core (`medicalRepository.completeAppointment`, truy vấn danh sách) chưa đổi; xem P08 phần C.

## Trade-off

- Danh sách và dashboard vẫn có nhóm trạng thái riêng (`statusGroup`, preview). Đó là cách hiển thị, không phải quy tắc chuyển trạng thái, nên rule không chặn.
- Thêm guard mới cần sửa bảng và phần hiện thực guard của service liên quan; Clinic báo lỗi lúc khởi động nếu thiếu.
