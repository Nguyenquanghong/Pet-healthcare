# ADR-AQ10 — Hotel: sức chứa theo loại phòng mỗi đêm, do database giữ bất biến

Ngày 23/10/2026. Trạng thái: ACCEPTED (user duyệt đề xuất: booking `pending` giữ chỗ; sức chứa mặc định đổi được).

## Bối cảnh

- `roomType` (standard, deluxe, vip) trước đây chỉ dùng để tính giá.
- Exclusion constraint (`e23426e`) chặn một pet có hai lần lưu trú chồng ngày. Nhưng cùng một đêm vẫn nhận được không giới hạn pet vào một loại phòng.
- Review gốc (AQ-10, Option B) đề xuất "model room/inventory và trạng thái giữ chỗ, admission transaction/constraint theo capacity". Verification của nó yêu cầu test sức chứa đồng thời trên DB thật.

## Quyết định

1. **Đặt chỗ (reservation):** booking ở trạng thái `pending`, `confirmed` hoặc `in_stay` chiếm một phòng ở mỗi đêm của khoảng `[check_in, check_out)`. Đây là cùng điều kiện với exclusion constraint.
2. **Bảng đếm theo đêm:** `hotel_room_nights(room_type, night, booked, capacity)` với `CHECK (booked >= 0 AND booked <= capacity)`.
   - Chỉ trigger `hotel_room_nights_sync` (AFTER INSERT/DELETE/UPDATE OF status, room_type, check_in, check_out trên `hotel_bookings`) ghi bảng này.
   - Vì vậy mọi đường ghi đều giữ bộ đếm đúng: tạo, đổi trạng thái, hủy, hoàn tác, mở lại, ghi thẳng vào DB, import P7.
   - Service không tự kiểm sức chứa. Vi phạm CHECK (`hotel_room_nights_capacity_check`) được `hotelStayWrite` ánh xạ sang 409 "Loại phòng này đã hết chỗ…".
3. **Đồng thời:** các booking cùng đêm cập nhật cùng dòng đếm nên bị khóa dòng tuần tự hóa. Khi tới lượt, mệnh đề CHECK được đánh giá lại, nên chỉ đúng số phòng còn trống được nhận. Cách này không cần khóa toàn loại phòng và vẫn đúng khi Core chạy nhiều replica.
4. **Sức chứa:** bảng `hotel_room_capacity`, giá trị mặc định do agent chọn: standard 10, deluxe 5, vip 2.
   - Admin đổi qua `PUT /api/hotel-capacity/{roomType}`, cần quyền mới `hotel.capacity.manage` trong ma trận AQ-05.
   - Giá trị mới áp cho hôm nay và các đêm sau. Nếu một đêm đã có nhiều booking hơn giá trị mới thì CHECK từ chối và API trả 409.
   - Staff, doctor và admin đọc được qua `GET /api/hotel-capacity`.
5. **Migration** `20261023000200_hotel_room_capacity`:
   - Backfill bộ đếm từ các booking đang hoạt động. Đêm nào đã vượt mặc định thì lấy số đang có làm sức chứa của đêm đó, để lịch sử không làm CHECK fail; booking mới vào đêm đó sẽ bị từ chối.
   - Hàm trigger dùng `SET search_path FROM CURRENT`, nên luôn tìm đúng bảng dù session ghi dùng `search_path` nào.
6. **P7:** hai bảng mới được chép nguyên từ nguồn.
   - Lúc import, trigger được tắt; seed của DB đích bị thay trong cùng transaction.
   - Rule `runtime-grants-cover-every-model` buộc phải phân loại và cấp quyền cho hai bảng này; rule đã báo `P7_UNCLASSIFIED_SOURCE_MODEL` cho tới khi phân loại xong.

## Bằng chứng

- `phase2:test:notification-runtime`, trên Core và Postgres thật qua gateway, dùng phòng vip ở ngày xa trong tương lai:
  - Staff và doctor đổi sức chứa bị 403; admin đặt 1 thì 200.
  - Booking thứ hai chồng một đêm bị 409 "hết chỗ". Booking nhận phòng đúng ngày trả phòng của booking trước được nhận (khoảng nửa mở).
  - Bộ đếm theo đêm khớp từng đêm. Giảm sức chứa xuống dưới số đã đặt bị 409. Hủy booking thì trả đêm.
  - 5 request song song tranh một phòng cuối: đúng 1 nhận 201, 4 nhận 409.
  - Chèn thẳng vào DB, bỏ qua service, bị chính CHECK chặn.
  - Truy vấn đối soát: số `booked` bằng số booking đang hoạt động ở mọi đêm của DB test, kể cả các đêm được backfill.
- Fixture của suite đặt sức chứa của DB test (dùng lâu dài) là 1000 cho các test không kiểm sức chứa. Test sức chứa tự đặt giá trị riêng và trả lại sau khi chạy.
- Unit `backend/tests/hotel-capacity.test.mjs`: chỉ admin đổi được; sức chứa phải là số nguyên 0–1000; loại phòng lạ trả 404; owner không đọc được.
- `permission-matrix.test.mjs` có probe cho GET và PUT. OpenAPI Core 74 thao tác.

## Trade-off

- Sức chứa tính theo loại phòng, không theo từng phòng cụ thể. Gán số phòng (phương án b) chỉ cần khi phòng khám quản lý theo từng phòng.
- Booking `pending` giữ chỗ nên có thể chiếm phòng mà không bao giờ được xác nhận. Chưa có hạn tự hủy pending; staff hủy thủ công.
- Hai booking nhiều đêm chồng nhau khóa các dòng đêm theo cùng thứ tự quét (khóa chính tăng dần), nên thực tế không deadlock. Nếu có deadlock, Postgres hủy một transaction và client thử lại với cùng Idempotency-Key.
- Giá trị mặc định 10/5/2 do agent chọn, cần phòng khám xác nhận; admin đổi được mà không cần deploy.
