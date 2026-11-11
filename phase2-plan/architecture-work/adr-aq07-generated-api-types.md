# ADR-AQ07 — OpenAPI là nguồn duy nhất cho kiểu dữ liệu API của frontend

Ngày 23/10/2026. Trạng thái: ACCEPTED. User duyệt bước 1–3 và bỏ bước 4 (kiểm dữ liệu lúc chạy ở frontend).

## Bối cảnh

- Frontend tự viết tay kiểu dữ liệu API: 14 file trong `frontend/src/types`, và `request<T>()` chỉ ép kiểu.
- Hệ quả: backend đổi contract thì frontend vẫn build PASS, lỗi chỉ lộ ra trên màn hình. Ví dụ thật: khi làm Claim Check, `imageUrl` đổi thành `url` và ảnh mất ở chế độ Pha 1.
- Đây là phần còn lại của AQ-07 ("Contract, validation và giá có nhiều nguồn").

## Quyết định

1. `tools/phase2/generate-api-types.mjs` sinh `frontend/src/types/generated/api.ts` từ `backend/openapi.json`.
   - Đây là contract của gateway cho cả Core và Clinic. Bốn schema chỉ có ở Clinic đều là route nội bộ.
   - Không thêm dependency: đoạn OpenAPI 3.0 mà repo dùng ánh xạ thẳng sang TypeScript.
2. Các module kiểu của UI là alias của kiểu sinh ra, ví dụ `type Pet = ApiSchemas["Pet"]`.
   - Enum cũng lấy từ đó (`AppointmentStatus = Appointment["status"]`).
   - Body request ở store dùng schema input của contract.
   - Chỉ còn helper giao diện là tự viết: danh sách loại spa, nhãn hiển thị, các `NotificationType` mà UI tô màu riêng.
3. Khi lấy kiểu từ contract, lỗi nằm ở contract chứ không ở UI: OpenAPI mô tả sai phản hồi thật.

   - Thiếu các trường serializer luôn gửi.
   - `InvoiceItem.unitPrice`/`amount` ghi `string`, trong khi serializer gửi number.
   - Trường luôn có mặt lại ghi optional.
   - Enum của DB chỉ ghi `string`.
   - Cột nullable không ghi `nullable`.

   Cả hai spec nay mô tả đúng serializer. Bộ validator chặt `tools/phase2/openapi-validate.mjs` kiểm phản hồi thật của mọi route đọc chính, cho owner và admin, trên stack thật.

4. Chỉ một sửa đổi nhỏ ở UI mà `tsc` buộc phải làm: nhãn chăm sóc rơi về giá trị gốc khi gặp giá trị lạ, vì API để `eatingStatus`/`mood` là chuỗi tự do.
5. Sáu file mock từ trước khi có backend (`frontend/src/data/{pets,owners,appointments,hotelBookings,medicalRecords,notifications}.ts`) không được import ở đâu và mâu thuẫn với contract, nên đã xóa.

## Fitness function

Check thứ 9 của `arch:check` (`tools/phase2/api-types.test.mjs`) kiểm:

- File kiểu đã commit phải đúng bằng output của generator từ spec hiện tại. Đã thử: sửa spec mà không sinh lại thì FAIL.
- Các kiểu DTO của UI là alias của kiểu sinh ra.
- Negative fixture cho generator và validator.

## Bằng chứng

- Frontend `tsc` từ 114 lỗi (trước khi sửa contract) xuống 0; build PASS.
- notification-runtime 13/13: phản hồi thật khớp contract theo validator chặt.
- Backend unit 91/91, contracts 12/12, OpenAPI 74 thao tác, UI 18/18, activity UI 6/6, E2E 18/18, rescue-qr 5/5, `arch:check` 9/9.

## Trade-off

- Không kiểm dữ liệu lúc chạy ở frontend (bước 4 bị loại): server gửi sai contract thì UI vẫn nhận. Lớp bảo vệ là test đối chiếu phản hồi thật với contract ở backend.
- Contract là nguồn duy nhất, nên mỗi lần đổi spec phải chạy lại generator; check 9 bắt chỗ quên.
- Spec của Clinic là bản riêng của service. Các schema dùng chung đã được đồng bộ với spec gateway, nhưng vẫn còn vài khác biệt nhỏ có từ trước (mô tả, `maxLength`). Chưa có rule bắt hai spec phải giống hệt.
