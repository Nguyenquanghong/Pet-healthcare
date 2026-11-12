# ADR-P14: Giữ kiến trúc tách service dù đã đo được cái giá

Ngày 31/10/2026. Trạng thái: **ACCEPTED**, đã chốt ngày 31/10, gồm cả các điều kiện ở mục 5. Bổ sung §4.1 ở K5, đã chốt ngày 6/11. Cập nhật §2, §3, §4.1, §5, §7 ngày 12/11 sau lượt VM v2 (K9); D4 chưa chốt lại. Tiếp nối ADR-01, [ADR-P12](adr-p12-deferred-list-authorization.md), [ADR-P13](adr-p13-local-read-authorization.md).

## 1. Bối cảnh

Hệ thống có ba service (Core, Clinic & Scheduling, Notification), mỗi service một database. Trước khi tách có bản monolith M (`48d01c3`). Hai lượt đo bridge cho thấy bản tách đắt hơn rõ rệt ([báo cáo](../bridge/README-20261028.md)). Câu hỏi của ADR này: **đã đo được giá rồi, vì sao vẫn giữ?**

## 2. Cái giá đã đo

Lượt VM `bridge-m-h-vm-v1`, cùng máy, 100 user closed-loop, khoảng 99 request/s:

| Chỉ số                         | M           | H0 (`e0e8937`) | H1 (`2841d1b`) | H0/M | H1/H0 |
| ------------------------------ | ----------- | -------------- | -------------- | ---- | ----- |
| p95 toàn bộ (ms, hai lượt)     | 3,94 / 4,15 | 11,0 / 11,5    | 9,63 / 9,87    | 2,78 | 0,868 |
| CPU mỗi request (ms, hai lượt) | 1,35 / 1,40 | 6,41 / 6,59    | 5,70 / 5,80    | 4,72 | 0,884 |
| RAM server (MB, hai lượt)      | 649 / 706   | 2.238 / 2.223  | 2.192 / 2.214  | 3,30 | 0,988 |

Đọc đúng các số này:

- H0/M gộp cả việc tách lẫn các tính năng thêm sau M (ma trận quyền, trigger P10/AQ-10, audit, DTO giàu hơn), nên không phải toàn bộ là giá của việc tách.
- Lượt VM chạy loopback trên một máy, môi trường có lợi cho H. Chi phí tách ở triển khai thật ít nhất bằng con số này.
- Lượt v1 chỉ có một phiên VM ở 100 user, chưa đo khi bão hòa. Không suy ra năng lực chịu tải từ các tỷ lệ trên; lượt v2 ở bên dưới đo thêm ở bậc cao.
- Số VM không so với số Kaggle bằng phép chia.

**Về giá trị tuyệt đối:** ở tải đã đo, p95 của H1 khoảng 10 ms, còn ngưỡng read p95 của QS-10 là 750 ms ([08](../../docs/phase2-architecture/08-quality-scenarios.md)). Giá tương đối lớn nhưng chưa đụng ngưỡng chất lượng ở tải này. So sánh này chỉ để thấy bậc độ lớn, vì hai phép đo khác điều kiện.

**Lượt VM v2 (12/11, `bridge-m-h-vm-v2`, mã sản phẩm `b02350d` gọi là H3, cùng máy, 100 đến 800 user closed-loop, một phiên; chi tiết ở [báo cáo bridge](../bridge/README-20261028.md)):**

| Chỉ số                  | 100 user | 200 user | 400 user | 800 user |
| ----------------------- | -------- | -------- | -------- | -------- |
| M: p95 đọc (ms)         | 2,0      | 2,0      | 2,4      | 4,4      |
| H3: p95 đọc (ms)        | 7,3      | 7,9      | 12,8     | 116,7    |
| H3/M: CPU mỗi request   | 4,34     | 3,77     | 3,83     | 4,14     |
| H3/M: throughput        | 0,996    | 0,997    | 0,994    | 0,958    |

- Giá tương đối vẫn lớn và **tăng theo tải**: M gần như phẳng, H3 bắt đầu xếp hàng ở 800 user (p95 đọc gấp 26,5 lần M). Ở 800 user H3 dùng 4,2 lõi trên 7 lõi server cho khoảng 764 req/s, M dùng 1,06 lõi cho khoảng 797 req/s.
- Giá tuyệt đối vẫn xa ngưỡng: p95 đọc cao nhất đo được là 148 ms ở 800 user, ngưỡng QS-10 là 750 ms, và không bậc nào bão hòa theo ba dấu hiệu chốt trước. **Chưa biết điểm gãy**; không ngoại suy.

**Cái giá ngoài hiệu năng:** hai pha prepare/commit cho hóa đơn, retry và DLQ, nhiều credential, nhiều migration, và phải chạy Postgres, RabbitMQ, Redis, bucket.

## 3. Quyết định

Giữ ba service. Hiệu năng **không** phải lý do giữ: về hiệu năng, monolith thắng ở mọi thao tác đã đo. Lý do giữ nằm ở các thứ sau, kèm mức bằng chứng.

| Lý do                                                                                                                                                           | Bằng chứng                                                                                                                                                | Mức chắc chắn                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Ranh giới dữ liệu:** mỗi service có DB, migration, Prisma client và credential riêng, không có đường đọc chéo DB                                              | `check-boundaries.mjs` trong `arch:check`; `dbCrossConnectDenied` kiểm 6 hướng trên stack thử ([04](../../docs/phase2-architecture/04-data-ownership.md)) | Có kiểm tự động                                                       |
| **Lỗi ở phần phụ không kéo sập phần chính:** Notification API tắt mà đặt lịch và xác nhận lịch vẫn thành công; bucket ảnh lỗi thì chỉ thao tác ảnh trả 503      | Diễn tập 31/10 ([13](../../docs/phase2-architecture/13-demo-10-phut.md)), E2E `resilience.spec.ts`, [06](../../docs/phase2-architecture/06-deployment.md) | Đã chạy thật                                                          |
| **Không mất event khi service hoặc broker gián đoạn:** outbox, inbox, delay queue                                                                               | `billing.test.mjs` (kill Core thật), `proof.test.mjs` (dừng broker thật), probe [ADR-P03](adr-p03-messaging-retry.md) (Core giả trả 503)                  | Đã chạy thật một phần, probe là giả lập                               |
| **Đơn vị bàn giao:** sau mốc H, thành viên Clinic và thành viên Notification/UI nhận phần riêng, Người tích hợp giữ Core và tích hợp ([HANDOFF](../HANDOFF.md)) | Kế hoạch bàn giao                                                                                                                                         | **Chưa kiểm chứng.** Mốc H còn IN_PROGRESS, chưa có ai nhận việc thật |
| **Mở rộng từng phần:** Clinic và Core chạy được nhiều instance sau gateway                                                                                      | NFR06, P6 (≥ 2 replica Clinic); H2 (v1), H3x2, H3cl2 và H3x2cl2 (v2) trong lượt VM                                                                                                          | **Một phần.** Ở 800 user nhân Core có lợi (p95 đọc 0,420, throughput 1,027, CPU mỗi request 1,003), nhân Clinic thì không (H3cl2/H3 p95 đọc 1,204). Ở 100–400 user không đổi. Chưa tách được pool khỏi event loop, chưa bậc nào bão hòa       |

## 4. Điều không che giấu

- **Core là điểm phụ thuộc chung.** Quyền luôn hỏi Core ([ADR-05](../../docs/phase2-architecture/07-adr-index.md)), nên Core ngừng thì đọc danh sách của Clinic cũng trả 503. Đo 31/10 trên stack thử, 12 lần mỗi bên: trước `e138bd3`, 503 khoảng 2 s (9 lần) hoặc khoảng 12 s (3 lần, do kết nối keep-alive giữ drain tới deadline 10 s); sau `e138bd3`, 1,7–2,3 s cả 12 lần. Trong lúc đó cả `/pets` lẫn `/appointments` đều 503, không có dữ liệu nào lọt ra. Cô lập lỗi chỉ đúng với Notification và bucket, **không** đúng với Core. Đây là đánh đổi có chủ ý để thu hồi phiên có hiệu lực ngay ([ADR-P13](adr-p13-local-read-authorization.md)).
- **Tính chất "không tách thì không có" khá ít.** Outbox, inbox, ma trận quyền hay trigger đều làm được trong monolith. Việc tách chủ yếu mua ranh giới cứng và khả năng chia việc, không mua thêm tính năng.
- **Ở quy mô một phòng khám, monolith là lựa chọn hợp lý.** Giữ kiến trúc tách ở đây phục vụ mục tiêu của đồ án (chứng minh và đo được một kiến trúc phân tán, có bàn giao cho nhóm), không phải vì tải đòi hỏi.

### 4.1 Bổ sung ngày 06/11/2026 (K5)

Mục này thêm vào, không đổi quyết định ở mục 3. đã chốt ngày 6/11.

- **Số đo ở mục 2 lấy trên topology đi thẳng.** Harness (`benchmarks/phase2/kaggle/stack.mjs:136`) đưa `/api/appointments`, `/api/medical-records` thẳng tới Clinic và `/api/notifications` thẳng tới Notification. Riêng `/api/dashboard/clinic` đi qua Core rồi tới Clinic.
  - _Chú thích 7/11/2026 (K9 C1, `1f333c0`):_ câu trên đúng với bản harness đo v1. Nay harness có hai template, `direct` (đi thẳng chuẩn, gồm cả `dashboard/clinic`) và `core-ingress` (H3c, mọi `/api` qua Core). Tải PCN không gọi `dashboard/clinic`, nên số v1 không bị ảnh hưởng.
- **Compose, demo, E2E, dev và diễn tập P7 đi qua Core** (`frontend/nginx/default.conf.template:10-13`, `tools/phase2/e2e-server.mjs:119-122`):
  - mọi request tới Clinic và Notification có thêm một chặng proxy;
  - một request Clinic chạm Core hai lần: một lần proxy, một lần Clinic gọi `/internal/directory/authorize`;
  - giá của chặng này đã đo ở K9 (12/11) bằng H3c/H3 ở 100 user: p95 đọc 1,175 (hai cặp 1,138 và 1,213), CPU mỗi request 1,134 (1,134 và 1,135), throughput 0,999. Đây là **cận trên** của giá ở compose, vì harness có thêm một chặng nginx mà compose không có (Core gọi Clinic trực tiếp), và chỉ đo ở 100 user. Cả hai tỷ lệ vượt 1,1, nên điều kiện mở lại D4 (đi qua Core hay đi thẳng) đã xảy ra; **D4 giữ nguyên, chờ chốt**. Số ở mục 2 là cận dưới của giá ở compose.
- **Ranh giới dữ liệu ở compose:**
  - từ K4 ([ADR-P08c](adr-p08c-core-legacy.md)), khi có `CLINIC_SERVICE_URL`, Core không mount router lâm sàng và không nạp nguồn đọc bảng lâm sàng (`servesClinical`, `backend/src/composition/config.ts`);
  - rule `legacy-isolated` cấm code ngoài `legacy/` đọc các bảng đó;
  - ở Core, chỉ còn `serviceProxy` trả lời prefix lâm sàng; cách viết hoa khác (`/api/Appointments`) nhận 404 từ proxy. Bỏ proxy thì các prefix này nhận 404 chung của Core, không có split-brain;
  - ranh giới ở compose vẫn **chưa có lớp DB**: user của Core có toàn quyền trên DB còn chứa bảng lâm sàng, vì grant P7 chưa áp ở compose.
- **Mẫu `deploy/phase2/nginx.split.conf.example` có khoảng trống bảo mật:**
  - mẫu đưa `/api/notifications` thẳng tới Notification;
  - Notification chỉ kiểm chữ ký và thu hồi do đổi mật khẩu (`services/notification/src/app.ts`, `sessions.ts`); tài khoản còn tồn tại và còn đúng role chỉ Core kiểm (`backend/src/middleware/currentAccount.ts`);
  - đi thẳng thì token của staff đã bị xóa hoặc hạ quyền vẫn đọc được inbox admin tới khi JWT hết hạn (`JWT_EXPIRES_IN`, 8 giờ);
  - với Clinic, Core vẫn kiểm qua `authorize`; tài khoản đã xóa chỉ đổi từ 401 thành 403 (`application/services/directoryAuthorization.ts`);
  - compose và demo không bị ảnh hưởng vì đi qua Core. Không dùng mẫu này cho triển khai thật trước khi đạt các điều kiện mở lại D4.
- **Một nguồn định tuyến:**
  - prefix và service chủ khai một lần ở `packages/contracts/src/gatewayRoutes.ts`;
  - rule `gateway-routes-single-source` kiểm 9 nơi cấu hình (7 nơi ban đầu, cộng `vite.config.ts`, cộng `stack.mjs` tính hai lần vì có hai topology) và service chủ của từng path trong `backend/openapi.json`;
  - biến thể còn lại có lý do và ngày hết hạn;
  - chu trình gọi đồng bộ: [ADR-P15](adr-p15-sync-call-cycles.md).

## 5. Điều kiện quay lại monolith

Xem xét lại khi có **một** trong các điều kiện sau:

1. **Ranh giới không dùng để chia việc được:** sau bàn giao H, các thay đổi nghiệp vụ thường phải sửa cùng lúc nhiều service, hoặc không có người nhận sở hữu riêng.
2. **Không đạt ngưỡng ở tải cần phục vụ:** một lượt đo có bậc tải cho thấy vượt ngưỡng QS-10, và đã thử hết các cách giảm: ADR-P13, Core nhiều instance, chỉnh pool kết nối. _Cập nhật 12/11 (K9):_ lượt v2 tới 800 user chưa vượt ngưỡng (p95 đọc cao nhất 148 ms so với 750 ms), và Core nhiều instance đã đo và có lợi ở 800 user (p95 đọc 0,420), nên điều kiện này chưa xảy ra.
3. **Đòi hỏi Clinic đọc được khi Core ngừng,** mà nghiệp vụ không chấp nhận điều kiện (c) của ADR-P13 (cửa sổ thu hồi ≤ 2 s, Clinic giữ bản sao DTO).
4. **Chi phí vận hành vượt khả năng người vận hành:** không ai duy trì được broker, nhiều DB, bucket, runbook và alert khi triển khai thật.

Quay lại không phải là revert về `48d01c3`, vì bản đó thiếu các tính năng làm sau. Phải gộp có kế hoạch: nhập ba DB về một, giữ ranh giới bằng module và fitness function, và bỏ các đường HTTP nội bộ. Việc này cần một ADR riêng kèm phương án chuyển dữ liệu theo [runbook P7](../../deploy/phase2/migration-runtime.md).

## 6. Phương án đã cân nhắc

- **Quay lại monolith ngay:** rẻ về CPU, RAM và độ trễ, nhưng mất ranh giới dữ liệu đã có kiểm tự động, mất đơn vị bàn giao, và phải làm một đợt chuyển dữ liệu lớn khi chưa có điều kiện nào ở mục 5 xảy ra.
- **Giữ nhưng tiếp tục giảm thuế:** đang làm. ADR-P12 giảm lời gọi Core từ 2 xuống 1 ở đường đọc danh sách. ADR-P13 đã hoãn vì đổi hành vi bảo mật. Limiter in-memory cho GET đã làm, chưa đo.
- **Tách thêm service hoặc đổi ngôn ngữ:** không làm, vì chỉ tăng thuế.

## 7. Hệ quả

- Trình bày kiến trúc này như một đánh đổi đã đo, không phải một cải tiến hiệu năng.
- Nên nói rõ khi trình bày: mỗi lượt VM chỉ một phiên; nhân Core có lợi ở 800 user nhưng chưa biết điểm gãy và chưa tách pool khỏi event loop; nhân Clinic không có lợi; lý do bàn giao chưa kiểm chứng.
- Khi có lượt đo mới hoặc khi bàn giao H xảy ra, cập nhật bảng ở mục 3.
