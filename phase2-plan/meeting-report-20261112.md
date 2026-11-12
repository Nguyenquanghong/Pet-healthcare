# Pet-healthcare Pha 2 — Báo cáo tiến độ họp nhóm

Cập nhật 12/11/2026. Bản gốc là tài liệu họp nhóm trên Claude Docs; bản này chép vào repo để cả nhóm đọc, nên không có sơ đồ tương tác.

## Tóm tắt 1 phút

Hệ thống đã tách xong thành 3 service, đúng và chịu lỗi theo các test đã chạy, code đã lên `main` ngày 10/11; nhưng bản tách chậm và tốn hơn monolith rõ rệt, và mốc bàn giao cho nhóm chưa xong.

- **Đã làm:** tách Core, Clinic, Notification, mỗi service một DB. Đo trên VM: so với monolith, p95 gấp 2,78 lần và CPU mỗi request gấp 4,72 lần. Sau tối ưu, p95 giảm 13% và GET lịch hẹn giảm 40%, nhưng khoảng cách với monolith vẫn còn.
- **Có lời rõ:** thu hồi phiên từ 4,4–5,8 s còn 19–30 ms; danh sách ảnh từ 800 KB còn 1,9 KB; 11/13 chỉ số cấu trúc code đạt đích.
- **Đã thử và bỏ:** CQRS chậm hơn đọc trực tiếp 25%, nên đã gỡ theo ngưỡng chốt trước khi đo.
- **Đã đo lại (K9, 12/11):** tới 800 user chưa bậc nào bão hòa; Core quá tải trước Clinic, chạy 2 bản Core hạ p95 đọc 58%, 2 bản Clinic không có lợi. Timeout lồng đã sửa ngày 12/11.
- **Đối chiếu 9 mục tiêu:** 3 đạt, 5 đạt một phần, 1 chưa đạt (bàn giao). P95 đọc vẫn trong ngưỡng 750 ms tới 800 user (cao nhất 148 ms), nhưng chưa biết điểm gãy.

## Mục tiêu ban đầu

Ngày 13–14/10/2026 nhóm chốt mục tiêu Pha 2: tách monolith Pha 1 thành 3 service (Core, Clinic, Notification), mỗi service một DB riêng, giữ đủ nghiệp vụ cũ và chứng minh hệ thống vẫn đúng khi nhiều request ghi cùng lúc, khi một phần bị lỗi và khi khởi động lại. Nguồn: `phase2-plan/06-functional-nonfunctional-requirements.md` và `07-benchmark-protocol.md`.

Các mục tiêu dưới đây được đánh mã G1–G9 để phần "Đối chiếu" dùng lại.

| Mã  | Mục tiêu                                  | Mức                | Tiêu chí đo đã chọn từ đầu                                                                                                       |
| --- | ----------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Giữ đủ nghiệp vụ cũ (FR01–FR10, NFR10)    | Bắt buộc           | Hành trình UI thật (E2E) và API vẫn chạy; giữ URL, JSON, mã lỗi cũ                                                               |
| G2  | Đúng đắn khi ghi đồng thời (NFR01, NFR03) | Bắt buộc           | Test trên PostgreSQL thật: không trùng slot, không trùng hóa đơn, không mất giao dịch đã commit                                  |
| G3  | Chịu lỗi và phục hồi (NFR02)              | Bắt buộc           | Broker hoặc Notification dừng 60 s thì Core/Clinic vẫn ghi được; sau khi chạy lại nhận đủ sự kiện trong 120 s, không xử lý trùng |
| G4  | Mỗi service sở hữu dữ liệu riêng (NFR05)  | Bắt buộc           | DB, migration, tài khoản DB riêng; cả 6 hướng đọc chéo DB đều bị từ chối                                                         |
| G5  | Bảo mật (NFR04)                           | Bắt buộc           | Chặn truy cập chéo chủ nuôi; JWT sai bị từ chối; API nội bộ và `/metrics` không ra ngoài                                         |
| G6  | Mở rộng độc lập (NFR06)                   | Bắt buộc về cơ chế | Chạy ≥ 2 bản Clinic sau gateway, tắt 1 bản vẫn đúng                                                                              |
| G7  | Thời gian đáp ứng (NFR07)                 | Mục tiêu đo        | Đọc p95 ≤ 750 ms; Clinic ghi p95 ≤ 1.500 ms; đăng nhập p95 ≤ 2.000 ms; thành công ≥ 99%                                          |
| G8  | Quan sát và vận hành (NFR09)              | Bắt buộc           | Lần theo một request qua các service bằng ID; có số đo queue, retry, DLQ, outbox                                                 |
| G9  | Bảo trì và tái hiện (NFR12)               | Bắt buộc           | Người nhận dựng lại được trên máy riêng (mốc H); lỗi và test bỏ qua được công bố                                                 |

Từ 28/10 có thêm một mục tiêu phụ: nâng chất lượng cấu trúc code để dễ bảo trì, đo bằng bộ kiểm tự động `npm run arch:check` (kế hoạch K0–K9).

## Kiến trúc hiện tại

_Sơ đồ kiến trúc nằm trong bản Claude Docs; trong repo xem [docs/phase2-architecture](../docs/phase2-architecture/README.md)._

Trình duyệt chỉ nói chuyện với nginx, nginx chuyển mọi `/api` tới Core, và Core chuyển tiếp phần lịch hẹn, bệnh án, thông báo. Mỗi service chỉ đọc DB của mình; cần dữ liệu của service khác thì gọi HTTP (nét liền) hoặc nhận sự kiện qua RabbitMQ (nét đứt). Cả 9 lời gọi đồng bộ được khai trong `deploy/phase2/service-calls.json` và có rule tự động kiểm.

## Đã làm

Từ 13/10 đến 10/11: tách xong 3 service, đo được cái giá của việc tách, tối ưu những chỗ đắt nhất, thử CQRS rồi gỡ, và dọn cấu trúc code. Code đã gộp vào `main` ngày 10/11 (PR #1, CI xanh).

### 1. Tách 3 service: cái giá đo được

**Vì sao tách:** để có ranh giới dữ liệu cứng, để lỗi ở phần phụ (Notification, kho ảnh) không kéo sập phần chính, và để chia việc cho từng thành viên. Hiệu năng không phải lý do (ADR-P14).

**Cách đo (study bridge trên VM FPT, 28/10):** cùng một máy 8 vCPU (7 vCPU cho server), 100 user ảo gửi request liên tục, làm nóng 30 s rồi đo 300 s. Mỗi cấu hình chạy 2 lượt theo thứ tự cân bằng M, H0, H1, H2, H2, H1, H0, M để khử việc máy chậm dần. Hai agent tính lại độc lập từ dữ liệu thô và khớp nhau.

- **M:** monolith trước khi tách (`48d01c3`).
- **H0:** bản tách lúc chưa tối ưu (`e0e8937`).
- **H1:** bản tách sau tối ưu (`2841d1b`).
- **H2:** H1 với Core chạy 2 bản.

| Chỉ số (lượt 1 / lượt 2)   | M           | H0            | H1            | H2            |
| -------------------------- | ----------- | ------------- | ------------- | ------------- |
| p95 toàn bộ (ms)           | 3,94 / 4,15 | 11,0 / 11,5   | 9,63 / 9,87   | 9,41 / 9,70   |
| CPU mỗi request (ms)       | 1,35 / 1,40 | 6,41 / 6,59   | 5,70 / 5,80   | 5,89 / 5,93   |
| RAM server (MB)            | 649 / 706   | 2.238 / 2.223 | 2.192 / 2.214 | 2.502 / 2.513 |
| Request thành công (req/s) | 99,2 / 99,5 | 99,0 / 98,1   | 99,0 / 98,7   | 99,4 / 99,3   |

| Tỉ lệ (cân bằng thứ tự)         | H0/M     | H1/H0     | H2/H1       |
| ------------------------------- | -------- | --------- | ----------- |
| p95 toàn bộ                     | 2,78     | 0,868     | 0,980       |
| CPU mỗi request                 | 4,72     | 0,884     | 1,027       |
| RAM server                      | 3,30     | 0,988     | 1,138       |
| Đọc theo luật chốt trước khi đo | chậm hơn | nhanh hơn | tương đương |

Luật đọc chốt trước: tỉ lệ ≤ 0,9 là nhanh hơn, 0,9–1,1 là tương đương, ≥ 1,1 là chậm hơn. Lượt đo trên Kaggle (4 vCPU) cùng chiều: p95 H/M 4,96, CPU mỗi request 4,40. Không chia số VM cho số Kaggle vì hai môi trường khác nhau.

**Kết quả phản ánh:**

- **Đánh đổi:** bản tách chậm hơn monolith ở mọi thao tác (p95 gấp 1,65 lần ở rescue tới 6,33 lần ở GET lịch hẹn), tốn CPU gấp 4,72 lần và RAM gấp 3,3 lần. Con số này gộp cả các tính năng thêm sau M (ma trận quyền, trigger chống trùng lịch, audit, dữ liệu trả về giàu hơn).
- **Tích cực:** p95 tuyệt đối của H1 khoảng 10 ms, còn rất xa ngưỡng đọc 750 ms. Hai phép đo khác điều kiện, nên chỉ dùng để thấy bậc độ lớn.
- **Giới hạn phải nói khi trình bày:** mọi thứ chạy trên 1 máy, gọi nhau qua loopback (có lợi cho bản tách, nên giá thật ít nhất bằng số này); chỉ 1 lượt study; server chỉ dùng 8–9% CPU nên chưa nói được gì về năng lực chịu tải. H2/H1 ≈ 1 không chứng minh Core 2 bản là vô ích khi máy quá tải.

### 2. Các cải tiến và kết quả sau khi đo

| Việc (ngày)                                                                             | Vì sao làm                                                                                       | Cách làm                                                                                                            | Số đo thực tế                                                                                                                                                      | Đánh đổi / chưa rõ                                                                                                                               |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clinic hỏi Core 1 lần (28/10, ADR-P12)                                                  | Trên Kaggle, Core chạy 0,86–0,89 lõi, gần bận kín; mỗi trang danh sách của Clinic gọi Core 2 lần | Đọc dữ liệu trước, rồi gọi `authorize` 1 lần kèm id của cả trang                                                    | H1/H0: p95 GET lịch hẹn 0,603 (giảm 40%); CPU của Core 0,27 → 0,22 lõi; p95 toàn bộ 0,868                                                                          | Là hiệu quả gộp với gỡ CQRS và migration A, không tách riêng được. POST rescue lại chậm hơn (1,165), nghi do pool 4 kết nối DB của Core, chưa đo |
| Retry qua delay queue, queue riêng cho thu hồi phiên (24/10, ADR-P03)                   | Lệnh khóa tài khoản xếp sau hàng trăm thông báo; Core khởi động lại là event rơi vào DLQ         | Retry theo bậc 1 s, 5 s, 30 s, 2 phút, 10 phút; lỗi vĩnh viễn vào DLQ ngay; thu hồi phiên có queue `identity` riêng | Thu hồi phiên sau 500 thông báo: 4,4–5,8 s → 19–30 ms. Core restart 5 s: 0/50 event vào DLQ                                                                        | Thêm queue và cấu hình. Phép đo dùng Core giả trả 503, không phải Core thật                                                                      |
| Claim Check và Valet Key cho ảnh y tế (23/10, AQ-09)                                    | Ảnh lưu trong DB, danh sách ảnh rất nặng                                                         | Ảnh ra bucket S3; trình duyệt tải thẳng bằng URL ký sẵn, hạn 5 phút                                                 | Danh sách 3 ảnh: 800.106 byte → 1.870 byte (khoảng 800 KB → 1,9 KB)                                                                                                | Thêm một thành phần phải vận hành; ai cầm URL ký đều xem được ảnh trong 5 phút                                                                   |
| Thử CQRS rồi gỡ (14–28/10, ADR-CQRS-06)                                                 | Muốn danh sách lịch đọc nhanh hơn bằng bản đọc riêng (projection)                                | Xây projection, đo 3 bản trên Kaggle với ngưỡng chốt trước: bản CQRS phải nhanh hơn ít nhất 20%                     | Bản CQRS chậm hơn 25% (B/A 1,25, ổn định qua 3 vòng đổi thứ tự); phần ghi tốn thêm 11% CPU. Tắt 23/10, gỡ khỏi `main` 28/10 (142 file, −8.270 dòng)                | Tốn khoảng 2 tuần. Bù lại: tìm và sửa 5 lỗi kiến trúc, ví dụ relay outbox của Clinic từ khoảng 27 lên khoảng 1.350 event/s                       |
| Sửa cổng vào của compose (31/10, K0)                                                    | Chưa từng có test nào đi qua nginx của compose; nghi 2 lỗi từ cấu hình                           | Sửa nginx và limiter, thêm `test:docker:ingress` và job CI `compose`                                                | Upload 5 MiB: 413 → 201. Limiter: trước mọi client chung 1 bộ đếm, nay mỗi IP một bộ. `/health`, `/metrics` từ ngoài: 200 → 404. Test ingress 10/10 (code cũ 5/10) | `serviceProxy` chưa chuyển IP thật sang Clinic và Notification, có thể sinh 429 khi tải cao                                                      |
| Core khởi động lại nhanh hơn (31/10)                                                    | Restart Core đôi khi trả 503 tới 12 s                                                            | Đóng kết nối keep-alive khi bắt đầu tắt                                                                             | Trước: 503 khoảng 2 s (9/12 lần) hoặc 12 s (3/12). Sau: 1,7–2,3 s cả 12/12 lần                                                                                     | Trong lúc đó danh sách của Clinic cũng trả 503, vì quyền luôn hỏi Core                                                                           |
| Circuit breaker, limiter in-memory cho GET, correlation ID, 13 rule cảnh báo (22–29/10) | Cô lập lỗi, bớt 1 lần gọi Redis mỗi GET, lần theo request qua các service                        | Thêm vào gateway, runtime chung và consumer                                                                         | Có test; **chưa đo lợi ích**                                                                                                                                       | Ngưỡng GET nay tính riêng từng bản chạy                                                                                                          |

### 3. Dọn cấu trúc code (K0–K5, 31/10–7/11)

**Vì sao:** đo ngày 31/10 thấy 43% code Clinic nằm ngoài các tầng, có 16 phụ thuộc ngược chiều tầng, và định tuyến khai ở 7 nơi. Người nhận bàn giao sẽ khó biết sửa ở đâu.

**Cách làm:** mỗi chỉ số có một rule tự động trong `npm run arch:check` (nay 17 bước kiểm, 22 rule, chạy trên CI), nên số không thể xấu đi mà không ai biết. Mỗi lần di chuyển code đều so song song hành vi cũ và mới (vài nghìn ca) và có review độc lập.

| Chỉ số                                      | Trước (31/10)       | Đích                | Hiện tại                                      |
| ------------------------------------------- | ------------------- | ------------------- | --------------------------------------------- |
| Code Clinic nằm ngoài các tầng              | 1.840 dòng (43%)    | ≤ 300               | 247                                           |
| Phụ thuộc ngược chiều tầng                  | 16                  | 0                   | 0                                             |
| Thư mục theo thời gian `backend/src/phase2` | 14 file, 1.679 dòng | 0                   | 0                                             |
| Nơi khai route của Core                     | 3                   | 1                   | 1                                             |
| Nơi cấu hình định tuyến                     | 7 nơi, 4 biến thể   | 1 nguồn             | 1 nguồn, rule kiểm cả 9 nơi                   |
| Lời gọi Prisma ở tầng HTTP của Clinic       | 10                  | 0                   | 0                                             |
| Route Clinic quên khai quyền                | vẫn chạy            | app không khởi động | đạt                                           |
| Code monolith cũ lẫn vào code đang chạy     | 835 dòng, 12 file   | 0 ngoài `legacy/`   | 0                                             |
| Chiều gọi đồng bộ giữa service có rule kiểm | 1                   | tất cả              | tất cả (9 lời gọi trong `service-calls.json`) |
| File backend trên 400 dòng                  | 4                   | 0                   | 0                                             |
| Hàm dài nhất                                | 303 dòng            | ≤ 100               | 135 (còn 2 hàm trên 100)                      |
| Đoạn code trùng ≥ 6 dòng giữa các service   | 104                 | ≤ 50                | 287                                           |
| Test chạy qua nginx của compose             | 0                   | có job CI           | 10/10, job CI xanh                            |

Đạt 11/13 chỉ số. Hai chỉ số chưa đạt: hàm dài nhất còn 135 dòng (`consumeEvents`, `parseEnvelope`), và code trùng tăng lên 287 vì Prettier format làm lộ phần Core và Clinic chép nhau, không phải code mới. Đích ≤ 50 cần xem lại. Số "hiện tại" lấy từ lần đo gần nhất của từng chỉ số (K2–K5), chưa đo lại toàn bộ trên `main`.

## Đang làm và việc còn lại

K9 đã đo xong ngày 12/11 và timeout lồng đã sửa cùng ngày, nên mốc cứng 30/11 (`arch:check` trên CI đỏ từ 07:00 ngày 1/12) không còn. Việc chính còn lại là bàn giao mốc H.

| Việc                                     | Vì sao                                                                                                                                                                                                                               | Đã xong                                                                                                                                                                                                                   | Còn lại                                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K9: đo lại VM (study `bridge-m-h-vm-v2`) | Số VM cũ đo code ngày 28/10, request đi thẳng tới service, chỉ 100 user. Cần biết: giá của chặng đi qua Core mà compose và demo đang dùng; Core 2 bản có lợi khi máy gần quá tải không; pool 4 kết nối có làm POST rescue chậm không | Xong 12/11: bộ đo C1–C4, chạy thử trên Linux, chạy local và full trên VM; 34/34 lượt hợp lệ, 0 lỗi trên 3,76 triệu request; hai agent tính lại độc lập khớp; kết quả đã vào tài liệu trên `main` (README bridge, ADR-P14) | Tùy chọn: thêm bậc 1.200 và 1.600 user hoặc tải open-loop để tìm điểm gãy; khối pool để tách pool kết nối khỏi việc thêm event loop; tìm nguyên nhân 11/34 lượt có lịch hẹn ghi vào DB mà client không nhận phản hồi; kiểm limiter IP ở tải cao |
| Sửa timeout lồng ngược (Q7)              | Core gọi Clinic với hạn 1.800 ms, nhưng bên trong Clinic lại gọi ngược Core với hạn 2.000 ms: lời gọi trong dài hơn lời gọi ngoài                                                                                                    | Sửa 12/11: evidence 1.500 ms nằm trong 1.800 ms, gỡ ngoại lệ khỏi `service-calls.json`, review độc lập đạt                                                                                                                | —                                                                                                                                                                                                                                               |
| Bàn giao mốc H                           | Mục tiêu G9: người nhận phải dựng lại được trên máy riêng                                                                                                                                                                            | Code đã lên `main` 10/11, CI xanh                                                                                                                                                                                         | Chưa thành viên nào dựng lại. Tài liệu chung (110 file `.md`: thiết kế, ADR, kết quả đo) đã lên `main` ngày 12/11; ghi chú riêng của người tích hợp để ngoài repo                                                                               |
| Các điểm nghiệp vụ chờ quyết             | Ảnh hưởng hành vi người dùng thấy                                                                                                                                                                                                    | Đã ghi trong bàn giao                                                                                                                                                                                                     | `BILLING_TERMINAL_CONFLICT`, cách ẩn `internalNote`, ngày trong dữ liệu mẫu hotel; route `GET /internal/billing-reservations/:id` không service nào gọi                                                                                         |

Đã đo gộp ở K9 (12/11), so với `2841d1b`: H3/H1 ở 100 user p95 đọc 0,835, CPU mỗi request 0,942. Chặng đi qua Core (H3c/H3): p95 đọc 1,175, CPU mỗi request 1,134, là cận trên. D4 quyết lại 12/11: giữ đi qua Core; đi thẳng tới Clinic là hướng làm tiếp, sau khi Notification tự biết tài khoản bị xóa hoặc hạ quyền.

## Đối chiếu với mục tiêu ban đầu

Các mục tiêu về tính đúng đắn đã đạt; hiệu năng và chịu lỗi đạt ở mức đã đo nhưng còn lỗ hổng; bàn giao (G9) chưa đạt. Tính trên 9 mục tiêu: 3 đạt, 5 đạt một phần, 1 chưa đạt.

| Mã  | Mục tiêu                         | Kết quả      | Bằng chứng                                                                                                                                                                                                                                                     | Còn thiếu                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Giữ đủ nghiệp vụ cũ              | Đạt          | E2E 18/18, UI 24, migration 11/11; CI xanh trên `main` ngày 10/11                                                                                                                                                                                              | Chỉ kiểm trên stack thử, chưa có dữ liệu thật                                                                                                                                                                                                                                                            |
| G2  | Đúng đắn khi ghi đồng thời       | Đạt          | Test PostgreSQL thật; trigger DB chặn vượt sức chứa slot, trùng pet, trùng bác sĩ, vượt số phòng mỗi đêm; bệnh án có `revision`, ghi đè lỗi thời trả 409; hóa đơn qua 2 pha prepare/commit                                                                     | —                                                                                                                                                                                                                                                                                                        |
| G3  | Chịu lỗi và phục hồi             | Đạt một phần | Tắt Notification vẫn đặt và xác nhận lịch được; kho ảnh lỗi thì chỉ thao tác ảnh trả 503; test kill Core thật và dừng broker thật; 0/50 event vào DLQ khi Core restart                                                                                         | Core ngừng thì danh sách của Clinic cũng 503 trong 1,7–2,3 s. Cô lập lỗi chỉ đúng với Notification và kho ảnh. Phép đo DLQ dùng Core giả                                                                                                                                                                 |
| G4  | Mỗi service sở hữu dữ liệu riêng | Đạt một phần | Stack thử: cả 6 hướng truy cập DB chéo bị từ chối; rule `check-boundaries` trên CI                                                                                                                                                                             | Ở compose, tài khoản DB của Core vẫn toàn quyền trên DB còn bảng lâm sàng, vì quyền P7 chưa áp                                                                                                                                                                                                           |
| G5  | Bảo mật                          | Đạt một phần | Chỉ Core giữ khóa ký JWT (RS256); `/internal`, `/metrics`, `/health` từ ngoài trả 404; ma trận quyền có test 4 vai trò                                                                                                                                         | Mẫu `nginx.split.conf.example` (đi thẳng tới Notification) có lỗ: tài khoản staff đã xóa vẫn đọc được hộp thư tới khi JWT hết hạn (8 giờ). Compose và demo không bị vì đi qua Core                                                                                                                       |
| G6  | Mở rộng độc lập                  | Đạt một phần | ≥ 2 bản Clinic chạy sau gateway (P6); Core 2 bản chạy được (H2). Đo 12/11 (K9, một phiên VM, 100–800 user): ở 800 user Core 2 bản hạ p95 đọc từ 117 xuống 49 ms; Clinic 2 bản không có lợi                                                                     | Đã đo ngày 12/11: Core nóng trước Clinic (0,85 lõi ở 400 user, 1,87 ở 800; Clinic 0,49 và 0,96), nên nhân Core có lợi, nhân Clinic thì không. Chưa bậc nào bão hòa nên chưa biết điểm gãy; chưa tách được pool kết nối khỏi việc thêm event loop (khối pool chưa chạy). Chỉ một phiên, hai cặp mỗi tỷ lệ |
| G7  | Thời gian đáp ứng                | Đạt một phần | 100 user: p95 khoảng 10 ms so với ngưỡng 750 ms; 7/8 lượt 0 lỗi, 1 lượt 17 lỗi 503 (0,058%) trong một cú đứng 2 s của VM. Đo 12/11 (K9): tới 800 user p95 đọc cao nhất 148 ms, p95 ghi cao nhất 168 ms (ngưỡng 750 và 1.500 ms), 0 lỗi trên 3,76 triệu request | Chưa đúng quy trình đo đã chốt (cần ≥ 3 lượt mỗi cấu hình, mới có 2); đã đo tải cao (K9, tới 800 user) nhưng cũng chỉ 2 lượt mỗi cấu hình và chưa bậc nào bão hòa, nên chưa biết điểm gãy; đăng nhập (p95 ≤ 2.000 ms) chưa đo riêng                                                                      |
| G8  | Quan sát và vận hành             | Đạt          | Correlation ID xuyên gateway, service, consumer; metric queue, retry, DLQ, outbox, circuit breaker; 13 rule cảnh báo                                                                                                                                           | Chưa dùng trong vận hành thật                                                                                                                                                                                                                                                                            |
| G9  | Bảo trì và tái hiện              | Chưa đạt     | Code trên `main`; `arch:check` 17 bước kiểm trên CI                                                                                                                                                                                                            | Mốc H chưa xong: chưa ai dựng lại trên máy riêng. Tài liệu chung đã lên `main` ngày 12/11                                                                                                                                                                                                                |
| Phụ | Cấu trúc code dễ bảo trì         | Đạt một phần | 11/13 chỉ số đạt đích                                                                                                                                                                                                                                          | Hàm dài nhất 135 dòng (đích ≤ 100); code trùng 287 (đích ≤ 50)                                                                                                                                                                                                                                           |

**Về lý do tách service (ADR-P14):** ranh giới dữ liệu và cô lập lỗi Notification đã có bằng chứng; mở rộng từng phần có bằng chứng một phần (ở 800 user nhân Core có lợi, nhân Clinic thì không); chia việc cho nhóm thì chưa. Ở quy mô một phòng khám, monolith rẻ hơn và nhanh hơn. Nhóm giữ kiến trúc tách vì mục tiêu đồ án, kèm 4 điều kiện quay lại monolith: không chia việc được, vượt ngưỡng ở tải cần phục vụ, nghiệp vụ đòi Clinic đọc được khi Core ngừng, hoặc không ai vận hành nổi.

## Cần nhóm quyết trong buổi họp

- [ ] **Ai nhận phần nào để đóng mốc H?** Kế hoạch: một người nhận Clinic, một người nhận Notification và giao diện, người tích hợp giữ Core và tích hợp. Người nhận dựng lại hệ thống trên máy mình và ghi bằng chứng. Đây cũng là cách duy nhất kiểm chứng lý do "chia việc" của việc tách service.
- [x] **Chia sẻ tài liệu `.md`: đã giải quyết 12/11.** Hook không còn chặn `*.md`; tài liệu chung (thiết kế, ADR, kết quả đo) đã lên `main`, ghi chú riêng để ngoài repo.
- [ ] **Có đo thêm trên VM không?** K9 đã chạy xong 12/11 và VM đã tắt; tắt vẫn tốn IP 100.000 đ/tháng và ổ đĩa. Nếu cần biết điểm gãy (bậc 1.200–1.600 user, khối pool) thì chốt ngày bật VM.
- [ ] **Ba điểm nghiệp vụ đang treo:** xử lý `BILLING_TERMINAL_CONFLICT`, cách ẩn `internalNote`, ngày trong dữ liệu mẫu hotel.
- [ ] **Cách trình bày với thầy:** thống nhất nói kiến trúc tách là "một đánh đổi đã đo", không phải cải tiến hiệu năng; luôn kèm giới hạn: mỗi lượt VM chỉ một phiên, chưa bậc nào bão hòa nên chưa biết điểm gãy, nhân Core có lợi ở 800 user nhưng nhân Clinic thì không, chia việc chưa kiểm chứng.

## Thuật ngữ

| Thuật ngữ                      | Nghĩa trong tài liệu này                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Monolith                       | Cả ứng dụng là một chương trình với một DB, như bản Pha 1.                                                         |
| Service                        | Một chương trình riêng, có DB riêng, nói chuyện với service khác qua HTTP hoặc qua hàng đợi tin.                   |
| p95                            | 95% request xong nhanh hơn con số này; đo "đuôi chậm" thay vì trung bình.                                          |
| CPU mỗi request                | Tổng thời gian CPU của mọi tiến trình server chia cho số request thành công; cho biết mỗi request "tốn" bao nhiêu. |
| Closed-loop                    | Mỗi user ảo chờ trả lời rồi mới gửi tiếp, nên tải tự giảm khi server chậm; tải thật thường dồn cục hơn.            |
| Thứ tự cân bằng                | Chạy xuôi rồi ngược (M, H, H, M) để việc máy chậm dần không thiên vị bên nào.                                      |
| Gateway / ingress              | Cổng vào duy nhất nhận request từ trình duyệt rồi chuyển tới đúng service.                                         |
| Outbox / inbox                 | Ghi sự kiện cùng giao dịch DB rồi gửi sau (outbox); bên nhận ghi lại đã xử lý để không làm hai lần (inbox).        |
| Delay queue, DLQ               | Hàng đợi giữ tin để thử lại sau một lúc; DLQ là nơi chứa tin hỏng hẳn để người xem xét.                            |
| Circuit breaker                | Khi service phía sau lỗi liên tục thì tạm ngắt gọi tới nó, trả lỗi ngay thay vì chờ.                               |
| Saga prepare/commit            | Giao dịch trải qua 2 service: giữ chỗ trước (prepare), rồi chốt (commit) hoặc trả lại (release).                   |
| Idempotency                    | Gửi lại cùng một lệnh nhiều lần vẫn chỉ có tác dụng một lần.                                                       |
| CQRS, projection               | Tách đường đọc khỏi đường ghi; projection là bảng đọc riêng được cập nhật theo sự kiện.                            |
| Claim Check                    | Không mang dữ liệu nặng (ảnh) trong tin nhắn hay DB, chỉ mang "phiếu" trỏ tới nơi cất.                             |
| Valet Key                      | URL ký sẵn, có hạn, cho trình duyệt tải thẳng từ kho mà không qua server.                                          |
| Replica / instance             | Nhiều bản chạy của cùng một service để chia tải.                                                                   |
| Fitness function, `arch:check` | Rule tự động kiểm kiến trúc (phụ thuộc tầng, định tuyến, lời gọi giữa service) mỗi lần chạy CI.                    |
| ADR                            | Ghi lại một quyết định kiến trúc: bối cảnh, lựa chọn, lý do, hệ quả.                                               |
| Mốc H                          | Mốc bàn giao: thành viên khác tự dựng lại được hệ thống và nhận phần việc của mình.                                |

**Nguồn (trên `m``ain`):** `phase2-plan/06-functional-nonfunctional-requirements.md`, `phase2-plan/bridge/README-20261028.md`, `phase2-plan/architecture-work/adr-p14-keep-service-split.md`, `docs/phase2-architecture/12-pattern-tradeoffs-20261028.md`, `phase2-plan/cqrs/FINAL-CQRS-20261023.md`. **Ghi chú riêng (ngoài repo):** `PLAN-20261031-diem-kien-truc.md`, `HANDOFF-20261028-tang-diem.md` §2, §8.
