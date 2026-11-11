# ADR-AQ01 — Báo cứu hộ: giới hạn nhiều tầng và gộp báo trùng

Ngày 23/10/2026. Trạng thái: ACCEPTED (user duyệt đề xuất của agent).

## Bối cảnh

- `POST /api/public/pets/:token/rescue-reports` không cần đăng nhập, và mỗi báo cáo tạo một thông báo cho chủ pet. Token nằm trên QR in công khai.
- E-b (22/10) đã thêm hai giới hạn trong 15 phút: 20 lần mỗi IP và 5 lần mỗi token. Còn hai lỗ:

  - Spam đều tay vẫn tạo tới 480 thông báo mỗi ngày cho một pet.
  - Người báo bấm gửi lại, hoặc client tự retry, tạo hai báo cáo và hai thông báo.

  Mục Verification của AQ-01 có yêu cầu "report burst/dedup policy".

## Quyết định

1. **Thêm giới hạn theo ngày:** 20 lần mỗi token trong 24 giờ (`RESCUE_REPORT_TOKEN_DAILY_LIMIT`), cùng nhóm `public-rescue` trong `packages/runtime/src/http.ts`. Vượt giới hạn trả 429 kèm `Retry-After`. Hai giới hạn 15 phút giữ nguyên.
2. **Gộp báo trùng:** cùng pet và cùng số điện thoại người báo (đã bỏ khoảng trắng hai đầu) trong 10 phút (`RESCUE_DEDUP_MS`) được tính là một báo cáo.
   - Không thêm dòng mới, không gửi thêm thông báo.
   - Vẫn trả 201, với message "Report already received; the owner was notified."; contract `Message` không đổi.
3. **Tính nguyên tử:** trong unit of work, Core khóa dòng pet (`SELECT … FOR UPDATE`) trước khi kiểm báo trùng và ghi. Nhờ đó các báo cáo của cùng một pet chạy tuần tự, kể cả khi Core chạy nhiều replica. Không cần unique index, vì báo cáo của người khác vẫn hợp lệ.

## Bằng chứng

- Test unit `backend/tests/public-rescue.test.mjs`: gộp trong 10 phút; người báo khác là báo cáo mới; quá 10 phút là báo cáo mới; lần nào cũng lấy khóa trước khi kiểm.
- Test unit `packages/runtime/tests/rescue-limit.test.mjs`: hết giới hạn ngày thì 429, pet khác vẫn còn hạn mức riêng; danh sách bucket của policy được kiểm.
- `phase2:test:notification-runtime`, trên Core, Notification và Postgres thật qua gateway:
  - 3 lần gửi lại song song đều trả "already received". Trong DB còn đúng 1 dòng cho mỗi số điện thoại và 2 event `pet_rescue_report` trong outbox.
  - Test khóa xác định: unit of work thứ hai không lấy được khóa cho tới khi unit thứ nhất commit, và sau đó thấy báo cáo của unit thứ nhất.
  - Mutation: bỏ `FOR UPDATE` trong `dist` thì test khóa FAIL. Riêng test HTTP song song vẫn PASS khi không có khóa, vì request được xử lý gần như tuần tự, nên test khóa xác định là bằng chứng chính.

## Trade-off

- Gộp theo số điện thoại không chặn được kẻ spam đổi số; phần đó do giới hạn theo token (15 phút và 24 giờ) chặn.
- Khóa dòng pet làm các báo cáo của cùng pet chạy tuần tự. Lưu lượng báo cáo của một pet rất thấp, nên đây không phải nút cổ chai.
- Báo cáo bị gộp không lưu vị trí mới. Người báo muốn cập nhật vị trí trong 10 phút đó thì chủ pet liên hệ qua số điện thoại đã có trong thông báo đầu.
