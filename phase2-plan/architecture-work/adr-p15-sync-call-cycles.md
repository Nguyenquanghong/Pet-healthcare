# ADR-P15: Chu trình gọi đồng bộ Core ⇄ Clinic, Core ⇄ Notification là cái giá có chủ ý

Ngày 6/11/2026. Trạng thái: **ACCEPTED** ngày 7/11/2026: K5 xong, hai rule `gateway-routes-single-source` (`3323189`) và `service-calls-declared` (`e1dc1fa`, thay `clinic-core-calls-confined`) đã có trong `arch:check`. Danh sách lời gọi: `deploy/phase2/service-calls.json`. Ngoại lệ timeout lồng (finalize 1.800 ms bọc evidence 2.000 ms) hết hạn 30/11/2026, sửa sau K9 (Q7). Thực hiện ở K5 của lộ trình cải thiện kiến trúc, thiết kế ở k5-design (`k5-design-20261106.md`). Liên quan: [ADR-P13](adr-p13-local-read-authorization.md), [ADR-P14](adr-p14-keep-service-split.md) §4.1, [ADR-P08c](adr-p08c-core-legacy.md).

## Bối cảnh

Ba service gọi nhau đồng bộ theo cả hai chiều. Thiết kế K5 §5.1 có bảng đủ 9 lời gọi.

- **Core → Clinic:**
  - proxy request của người dùng;
  - đọc nguồn hóa đơn;
  - prepare, commit hoặc release giữ chỗ hóa đơn.
- **Clinic → Core:**
  - hỏi quyền (`/internal/directory/authorize`, `lookup`);
  - lấy evidence của thao tác hóa đơn;
  - worker hydrate thư mục (`/internal/directory/export`).
- **Core → Notification:** proxy.
- **Notification → Core:** `authorize-send`.

Ở mức một request có ba chu trình:

1. proxy → Clinic → `directory/authorize` (Core);
2. proxy → Notification → `authorize-send` (Core);
3. Core finalize → Clinic commit/release → evidence (Core).

Ở compose, một request Clinic chạm Core hai lần. Trước K5 chỉ chiều Clinic → Core có rule kiểm (`clinic-core-calls-confined`). Chưa có ADR nào nói vì sao các chu trình này chấp nhận được.

## Quyết định

1. **Giữ Core làm ingress ở compose** (D4 vẫn là "chưa"). Core là nguồn duy nhất của quyền, role và thu hồi phiên (ADR-05, ADR-P13). Đi qua Core giữ được thu hồi có hiệu lực ngay.
2. **Giữ các chu trình**, nhưng không để chúng ẩn:
   - mỗi lời gọi khai trong `deploy/phase2/service-calls.json`, gồm caller, callee, path, credential, timeout, lời gọi bọc ngoài và lý do đồng bộ;
   - rule `service-calls-declared` thay `clinic-core-calls-confined` và kiểm cả ba service.
3. **Một nguồn định tuyến.** Prefix và service chủ khai ở `packages/contracts/src/gatewayRoutes.ts`. Rule `gateway-routes-single-source` kiểm 7 nơi cấu hình định tuyến.

## Bất biến có rule kiểm

- Mọi lời gọi HTTP trong `src` của ba service đều đã khai, hoặc có trong danh sách hệ thống ngoài (S3, VNPay).
- Path đã khai khớp route thật của callee và có trong `packages/contracts/internal/openapi.json`. Route `/internal/` không ai gọi phải khai lý do.
- Timeout của lời gọi bên trong nhỏ hơn của lời gọi bọc ngoài, trừ ngoại lệ có hạn.
- Mỗi endpoint nội bộ một credential riêng (`backend/src/composition/config.ts`), và route nhận lời gọi có gate kiểm credential đó.
- Breaker tách theo chiều gọi: `clinic-gateway`, `notification-gateway`, `core-directory`.

**Ngoại lệ đang mở:**

- Core gọi commit/release với 1.800 ms, nhưng bên trong Clinic gọi evidence với 2.000 ms. Evidence còn dùng chung breaker `core-directory` với các lượt đọc quyền.
- đã chốt 6/11 không sửa trong K5, để số đo K9 lấy trên code như hiện tại. Ngoại lệ có hạn 30/11/2026.
- Sau K9, sửa trong commit riêng (evidence 1.500 ms) và kiểm reconcile của Clinic còn idempotent khi bị retry.

## Rủi ro chấp nhận

- **Core bão hòa thì tải bị khuếch đại**, vì mỗi request Clinic tốn thêm một lượt Core.
- **Core ngừng thì mọi thứ ngừng** (ADR-P14 §4).
- **Gọi `directory` tuần tự có thể dồn thời gian.** Nhiều lời gọi `directory` trong một request có thể cộng lại chạm mức 6 s của proxy.
- **Limiter theo IP có thể gom lời gọi nội bộ.** Mọi lời gọi `/internal` từ một service có thể rơi vào cùng một bucket. Chưa kiểm.

## Phương án phá chu trình đã cân nhắc

| Phương án                                             | Bỏ được                | Cái giá                                                                                                          |
| ----------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| (a) Đi thẳng tới service (D4)                         | Cạnh proxy ở compose   | Hở F9: Notification không kiểm được tài khoản bị xóa hay đổi role. Khoảng 3 công, xem điều kiện D4 ở kế hoạch K5 |
| (b) Clinic tự quyết quyền                             | Chu trình 1            | ADR-P13 đang hoãn; mất thu hồi tức thì                                                                           |
| (c) Notification kiểm quyền bằng projection identity  | Chu trình 2            | Cần event khi đổi role, xóa tài khoản; chấp nhận thu hồi theo event, không tức thì                               |
| (d) Clinic chỉ finalize theo billing event đã consume | Chu trình 3            | Release chậm hơn (suy luận, chưa đo)                                                                             |
| (e) Gateway riêng không có DB                         | Chu trình ra khỏi Core | Thêm một chặng, một process                                                                                      |
| (f) Quay lại monolith                                 | Mọi chu trình          | Xem ADR-P14 §5                                                                                                   |

## Khi nào xem lại

- Ở K9, H3c/H3 ≥ 1,1, tức là chặng qua Core đắt đáng kể.
- Các điều kiện mở lại D4 đã đạt.
- Các điều kiện (a)–(c) của ADR-P13 đã đạt.

## Hệ quả

- **S6 và S13 thành chỉ số đo được** (thiết kế K5 §6):
  - S6 đếm nơi định tuyến chưa có rule kiểm, số biến thể và số ngoại lệ;
  - S13 đếm chiều gọi chưa có rule kiểm và chỗ gọi chưa khai.
- **`clinic-core-calls-confined` gộp vào `service-calls-declared`.** Rule mới giữ toàn bộ fixture cũ. ADR-P13 có thêm một dòng chú thích về việc này.
- **Thêm lời gọi nội bộ mới phải khai trong `service-calls.json`,** không khai thì `arch:check` FAIL. Đây là chủ đích.
