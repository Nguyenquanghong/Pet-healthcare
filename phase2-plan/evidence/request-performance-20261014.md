# Tối ưu request trước CQRS — 14/10/2026

## Phạm vi và baseline

Người dùng yêu cầu sửa các chi phí request đã tìm thấy trước khi triển khai CQRS. Nền mã là `4435dfadf018e2d8a7596f236c3c85500c7d7028`; giữ nguyên các sửa README và tài liệu chưa commit sẵn có. Không đổi schema hay ghi trực tiếp vào DB đang vận hành.

PCN ZIP `phase2-pcn-results-76bd8985-c2dc-4a0e-b0dc-3b31b4fc9077.zip` đo bản nền: 100 users, warmup 30 giây, steady 1.800 giây, một Clinic; 174.797 HTTP thành công, 0 lỗi/429/503; 97,1094 RPS; p95 60,205 ms, p99 90,917 ms. Đối soát appointment không thiếu/trùng. Đây là số trước sửa, không phải kết quả của code local mới.

## Thay đổi

| Đường xử lý                                             | Trước                                             | Sau                                                        |
| ------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| Clinic đọc bệnh án theo pet đã authorize                | Core authorize rồi lookup cùng pet/owner          | Dùng snapshot trong request; chỉ gọi Core cho ID còn thiếu |
| Xác minh JWT Core có runtime/currentAccount/requireAuth | Ba lần cùng request                               | Một lần, cùng token và verifier                            |
| Xác minh JWT Clinic/Notification có runtime             | Hai lần cùng request                              | Một lần, cùng token và verifier                            |
| ORM đọc danh sách lịch Clinic                           | groupBy, billingHeld count, total count, findMany | groupBy, billingHeld count, findMany                       |
| Health/backlog khi ghi                                  | Request có thể chờ DB/Redis/broker probe          | Probe nền mỗi 3 giây; đọc snapshot còn hạn để admission    |

Các số lần gọi ở trên mô tả đường xử lý cụ thể, không áp dụng cho mọi endpoint. Danh sách lịch chưa biết pet vẫn cần authorize + lookup. Các lời gọi nội bộ giữa service vẫn xác thực riêng, không dùng chung cache JWT qua HTTP.

File chính: `packages/runtime/src/jwt.ts`, `packages/runtime/src/http.ts`, `services/clinic/src/directory.ts`, `services/clinic/src/lists.ts`; middleware xác thực của cả ba service dùng helper chung.

## Điều kiện an toàn được giữ

- WeakMap JWT chỉ sống theo đối tượng request; khóa gồm token và hàm verifier. Không tin `req.auth` do middleware khác gán. Actor được freeze; request mới xác minh lại. Core vẫn hỏi DB về account/role mỗi request.
- Snapshot directory chỉ chứa dữ liệu đã được authorize/lookup qua Core trong request hiện tại. ID thiếu và owner ngoài scope vẫn phải đi qua Core. Giới hạn batch 100 ID giữ nguyên.
- Total lịch tính từ groupBy cùng predicate cơ sở trong transaction RepeatableRead, rồi áp dụng giao của status và statusGroup. Bộ lọc không nhất quán cho total bằng 0; không bỏ kiểm tra quyền hoặc pagination.
- Request ghi trả 503 khi chưa có snapshot, probe DB lỗi, snapshot tuổi >= 6 giây, hoặc pending đạt hard limit. Rate limit Redis cho ghi vẫn fail closed; đọc không bị thêm điều kiện health DB.
- Tuổi snapshot tính từ khi DB probe hoàn tất, không từ khi RabbitMQ trả lời. Broker bị treo không làm dữ liệu DB cũ trở thành mới. Chỉ một vòng probe chạy tại một thời điểm; nếu broker giữ vòng probe quá lâu, snapshot hết hạn và ghi bị chặn an toàn. Đây vẫn là giới hạn vận hành cần kiểm tra trên stack thật.
- Shutdown dừng timer và chờ probe đang chạy trước disconnect DB. Không thay transaction nghiệp vụ, reservation billing, idempotency hay outbox/inbox.

## Kiểm thử thực sự đã chạy

Môi trường Windows, dùng dependencies và Prisma client đã có. Không chạy Prisma generate/migrate; Docker daemon không sẵn sàng (pipe Docker không tồn tại).

| Lệnh                                                                          | Kết quả                              |
| ----------------------------------------------------------------------------- | ------------------------------------ |
| `node node_modules/typescript/bin/tsc -p packages/runtime/tsconfig.json`      | PASS                                 |
| `node node_modules/typescript/bin/tsc -p backend/tsconfig.json`               | PASS                                 |
| `node node_modules/typescript/bin/tsc -p services/clinic/tsconfig.json`       | PASS                                 |
| `node node_modules/typescript/bin/tsc -p services/notification/tsconfig.json` | PASS                                 |
| `node --test backend/tests/*.test.mjs`                                        | 84/84 PASS                           |
| `node --test --test-isolation=none packages/runtime/tests/*.test.mjs`         | 8/8 PASS                             |
| `node --test --test-isolation=none tools/phase2/directory-cache.test.mjs`     | 3/3 PASS                             |
| `npm run phase2:test:request-performance`                                     | 9/9 PASS; tập con của các suite trên |
| `node backend/scripts/check-architecture.mjs`                                 | PASS, 97 file                        |
| `node tools/phase2/check-boundaries.mjs`                                      | PASS                                 |
| `node backend/scripts/check-openapi.mjs`                                      | PASS, 69 operation                   |
| `git diff --check`                                                            | PASS                                 |

Lệnh regression mới cần compiled output runtime/Core/Clinic; chạy các lệnh tsc trên trước nếu vừa sửa source. Các test dùng Express HTTP thật nhưng giả lập DB, Core directory, broker và Redis. Kiểm chứng gồm: số lần verify/call, tài khoản đổi role/xóa vẫn bị chặn, snapshot không dùng qua request, phân trang với bộ lọc giao nhau, broker chậm, DB lỗi, Redis lỗi, backlog đầy, snapshot hết hạn, background timer và shutdown.

## Chưa kiểm chứng và bước tiếp

Chưa chạy PostgreSQL/RabbitMQ/Redis thật trên bản sửa; chưa chạy Docker build hoặc Kaggle benchmark mới. Không dùng test giả lập để tuyên bố tốc độ cải thiện hay chứng minh transaction trên DB thật.

1. Smoke trên stack thử riêng: xác thực đủ ba service; tạo/đọc lịch và bệnh án; giới hạn backlog; outage/recovery; shutdown. Không dùng DB đang sử dụng.
2. Đưa đúng source mới vào môi trường đo, ghi SHA/hash vào report. Thay đổi local chưa commit/push nên chạy lại notebook clone commit cũ không đo được bản sửa.
3. Chạy PCN cùng cấu hình 100 users, warmup 30 giây, steady 1.800 giây, cùng fixture/tổng tài nguyên/một Clinic. So p95 từng endpoint, lỗi/429/503, RPS steady, CPU Core/Clinic và đối soát dữ liệu; lặp các bản trong cùng điều kiện trước khi kết luận.
4. Chỉ cân nhắc read model CQRS khi phép đo tiếp theo chỉ ra nhu cầu còn lại. Không giảm kiểm quyền, độ bền dữ liệu hoặc workload để tạo số đẹp.
