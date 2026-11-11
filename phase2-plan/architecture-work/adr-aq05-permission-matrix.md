# ADR-AQ05 — Phân quyền policy-as-code: một ma trận quyền cho mọi service

Ngày 23/10/2026. Trạng thái: ACCEPTED. User duyệt đề xuất của agent ("chốt làm theo thứ tự của bạn").

## Bối cảnh

- Review gốc (ARCHITECTURE_QUALITY_REVIEW.md (`../../docs/ARCHITECTURE_QUALITY_REVIEW.md`), AQ-05) ghi nhận ma trận quyền chưa rõ. Option A của review: "permission matrix, shared guard". Verification yêu cầu "Role/ownership matrix tất cả sensitive routes".
- Trước thay đổi này, Core và Clinic có khoảng 30 điều kiện role viết tay (`actor.role === "owner"`, `role !== "admin"`, `requireRole("admin","staff")`), rải trong service, router và middleware.
- Hệ quả:
  - Doctor, staff và admin gần như có cùng quyền ghi: staff ghi được bệnh án, doctor lập được hóa đơn và xác nhận thu tiền.
  - Đổi một quyền phải sửa nhiều chỗ ở ba service, và không có gì báo khi bỏ sót một chỗ.

## Quyết định

1. Một ma trận quyền duy nhất trong `packages/contracts/src/permissions.ts`: tên quyền → các role được phép, kèm thông điệp từ chối. Gói `@nipopeto/contracts` không có dependency nào, và Core, Clinic, Notification đều đã dùng nó.

   | Quyền                    | Role                 | Dùng cho                                                 |
   | ------------------------ | -------------------- | -------------------------------------------------------- |
   | `booking.manage`         | doctor, staff, admin | Đổi trạng thái, hoàn tác, nhắc lịch, lịch sử trạng thái  |
   | `booking.reopen`         | admin                | Mở lại dịch vụ đã hoàn tất                               |
   | `hotel.care-note.write`  | doctor, staff, admin | Nhật ký chăm sóc lưu trú                                 |
   | `medical-record.write`   | doctor, admin        | Tạo, sửa, xóa bệnh án và ảnh y tế                        |
   | `medical-record.history` | doctor, staff, admin | Lịch sử sửa bệnh án (AQ-15)                              |
   | `billing.manage`         | staff, admin         | Lập hóa đơn, xác nhận thu tiền, từ chối chuyển khoản     |
   | `billing.audit`          | doctor, staff, admin | Thống kê hóa đơn, lịch sử kiểm tra thu tiền              |
   | `billing.self-service`   | owner                | Tự thanh toán, chọn cách trả, báo đã chuyển khoản, VNPay |
   | `owner.manage`           | staff, admin         | Tạo khách tại quầy, cấp liên kết kích hoạt               |
   | `directory.read`         | doctor, staff, admin | Danh bạ chủ nuôi                                         |
   | `notification.send`      | staff, admin         | Gửi thông báo thủ công                                   |
   | `clinic-activity.read`   | admin                | Dashboard hoạt động phòng khám                           |

   Quyết định nghiệp vụ mới: staff chỉ đọc bệnh án và ảnh; doctor chỉ đọc hóa đơn và thanh toán, không gửi thông báo thủ công. Các quyền khác giữ như Pha 1.

2. Mỗi service kiểm qua một hàm, không tự so role:
   - Core và Clinic dùng `authorize(actor, permission)` trong `domain/authorization.ts`; lỗi 403 mang thông điệp của ma trận.
   - Route của Core dùng `requirePermission(permission)`. Hàm này thay `requireRole`, và `requireRole` đã bị xóa.
   - Notification gọi `allows()`. Endpoint nội bộ `authorize-send` của Core cũng gọi `allows()`.
   - Phạm vi sở hữu (owner chỉ thấy dòng của mình) vẫn kiểm trong từng service; ma trận chỉ quyết định role.
3. Đăng nhập, đăng ký và `/auth/me` trả `user.permissions` tính từ ma trận (`sessionUser`). Frontend ẩn nút theo `can(permission)`, không tự viết lại bảng quyền. Đây chỉ là gợi ý cho giao diện; server vẫn kiểm mọi request.

## Fitness functions

- Rule `permissions-from-matrix` trong `tools/phase2/check-architecture-rules.mjs`, chạy trong `arch:check`. Rule quét 162 file nguồn của Core, Clinic và Notification, và FAIL khi gặp một trong các trường hợp:

  - còn `requireRole`;
  - so sánh role với `admin`, `doctor` hoặc `staff`;
  - danh sách role viết inline (`['admin','staff'].includes(role)`);
  - trả 403 dựa trên role owner mà không kèm điều kiện sở hữu;
  - có quyền trong ma trận mà không chỗ nào kiểm.

  Rule có negative fixture cho từng mẫu và cho các trường hợp hợp lệ: so danh tính (role trong token bằng role trong DB) và lọc phạm vi.

- Test `tools/phase2/permission-matrix.test.mjs` (check thứ 8 của `arch:check`) sinh từ ma trận, chạy 4 role × 42 probe:

  - Core thật qua HTTP: 26 route; DB không tồn tại, nên role bị từ chối phải nhận 403 trước khi chạm dữ liệu.
  - Clinic thật qua HTTP: 11 route, DB giả bằng tripwire.
  - Mức service: 5 thao tác phải nạp dữ liệu rồi mới kiểm quyền.

  Test cũng khẳng định: quyền nào cũng có probe; enum `permissions` trong OpenAPI khớp ma trận; `sessionUser` trả đúng quyền cho từng role. Mutation test (tạm bỏ guard trong `dist`) làm test FAIL ở cả Core và Clinic.

- `phase2:test:clinic` chạy trên Core, Clinic và Postgres thật: staff tạo bệnh án và ảnh bị 403, staff vẫn đọc được bệnh án và lịch sử.

## Trade-off

- Thông điệp 403 đổi theo ma trận; các thông điệp cũ kiểu "Staff access is required." không còn.
- Ma trận là contract chung: đổi quyền thì build lại cả ba service, giống mọi thay đổi contract khác.
- Rule tĩnh chạy theo từng dòng, nên dựa vào quy ước code một dòng hiện có. Test HTTP sinh từ ma trận là lớp bảo vệ thứ hai cho những chỗ rule tĩnh bỏ sót.
- Hai mức kiểm (router và service) ở các route bệnh án của Clinic được giữ có chủ đích. `POST /medical-records` đi qua dedup trước khi vào service, nên guard ở router là chốt chặn đầu tiên.

## Đổi quyết định khi

Có chức danh mới (ví dụ thu ngân tách khỏi lễ tân), hoặc cần quyền theo phạm vi, ví dụ bác sĩ chỉ sửa bệnh án do mình tạo. Khi đó thêm khóa vào ma trận và test tự sinh probe cho khóa mới.
