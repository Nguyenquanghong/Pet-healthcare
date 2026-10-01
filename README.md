# Pet Healthcare (NIPOPETO)

Ứng dụng quản lý thú cưng, lịch khám và Spa, lưu trú khách sạn, hồ sơ y tế, hóa đơn và thông báo. `frontend/` dùng React, TypeScript và Vite; `backend/` là một ứng dụng Express chia module theo route → application service/port → infrastructure, dùng Prisma và PostgreSQL. Hai phần dùng chung npm workspace; đây chưa phải kiến trúc microservice.

## Phạm vi và kiến trúc Pha 1

Chủ nuôi quản lý thú cưng, đặt lịch, đặt phòng, xem bệnh án/hóa đơn của mình. Nhân viên và quản trị viên xác nhận lịch, check-in, ghi chăm sóc/bệnh án, chốt phí và đối chiếu thanh toán. VNPay tắt mặc định; không có đặt cọc, hoàn tiền hoặc tồn kho phòng tự động trong phạm vi này.

```text
HTTP JSON / JWT middleware (backend/src/routes, backend/src/middleware)
                    ↓
Nghiệp vụ và hợp đồng repository (backend/src/application, backend/src/domain)
                    ↓
Repository Prisma / transaction (backend/src/infrastructure) → PostgreSQL
```

`backend/src/app.ts` lắp các route, service và repository. Tầng `application`/`domain` không import Express hay Prisma; script `test:architecture` kiểm tra ranh giới này. Prisma schema và migrations ở `backend/prisma/`. Frontend gọi API qua `frontend/src/services/apiClient.ts`, không truy cập PostgreSQL trực tiếp.

### Hợp đồng API cơ bản

Base URL: `http://localhost:5000/api`; request/response dùng JSON (DELETE thành công có thể trả `204` không có body). Đặc tả đầy đủ và schema: [`backend/openapi.json`](backend/openapi.json), khi chạy API xem `/api/openapi.json` hoặc `/api/docs/`. Lỗi nghiệp vụ trả mã HTTP và JSON dạng `{ "error": "..." }`.

| Method và đường dẫn | Vai trò | Công dụng |
| --- | --- | --- |
| `POST /auth/owner/login`, `POST /auth/admin/login` | Công khai | Đăng nhập, nhận JWT |
| `GET /pets`, `POST /pets` | JWT chủ nuôi/nhân viên theo nghiệp vụ | Xem/tạo thú cưng |
| `GET /appointments`, `POST /appointments` | JWT | Xem/tạo lịch; chủ nuôi chỉ xem dữ liệu của mình |
| `GET /medical-records`, `POST /medical-records` | JWT; POST chỉ nhân viên | Xem/tạo bệnh án |
| `PATCH /medical-records/{id}`, `DELETE /medical-records/{id}` | JWT nhân viên | Sửa nội dung hoặc xóa bệnh án |

JWT gửi bằng header `Authorization: Bearer <token>`. Middleware `requireAuth` bảo vệ các nhóm route riêng tư trước khi route xử lý. Khi sửa bệnh án đã tạo, thú cưng, chủ nuôi và lịch liên kết cố định; gửi giá trị khác hoặc `null` để gỡ sẽ nhận `422`. Bản ghi demo `record_1` là lần khám độc lập; lịch sắp tới `appointment_1` không liên kết bệnh án đó.

## Chạy trên máy không cần Docker

Cần Node.js 24, npm và PostgreSQL cục bộ. Không dùng database đang vận hành để thử migration hoặc test tích hợp.

1. Clone nhánh `refactor` bằng `git clone -b refactor https://github.com/Nguyenquanghong/Pet-healthcare.git`, vào thư mục `Pet-healthcare` rồi chạy `npm ci`.
2. Sao chép `backend/.env.example` thành `backend/.env`, `frontend/.env.example` thành `frontend/.env`.
3. Trong `backend/.env`, đặt `DATABASE_URL` trỏ tới database PostgreSQL của môi trường này và đặt `JWT_SECRET` ngẫu nhiên dài ít nhất 32 ký tự. Thiếu `DATABASE_URL` sẽ gây Prisma P1012 khi chạy `db:deploy`.
4. Tạo database tương ứng bằng PostgreSQL cục bộ, rồi chạy `npm run db:generate` và `npm run db:deploy -w backend`. Chỉ chạy deploy migration sau khi đã kiểm tra đúng URL và có bản sao lưu nếu đó là dữ liệu cần giữ.
5. Chạy `npm run dev` hoặc mở riêng `npm run dev:backend` và `npm run dev:frontend`. Giao diện mặc định ở `http://localhost:5173`; API health ở `http://localhost:5000/api/health`.

`db:seed` chỉ dành cho database demo mới, trống và có thể bỏ. Không chạy seed trên dữ liệu thật. Người dùng và quản trị viên có thể tạo hoặc cấu hình theo quy trình riêng của môi trường.

## Chạy backend bằng Docker Compose trên máy mới

Cần Docker Desktop đang chạy với Linux containers, Node.js 24 và npm cho frontend. Tại thư mục gốc sau khi clone nhánh `refactor`:

```powershell
git clone -b refactor https://github.com/Nguyenquanghong/Pet-healthcare.git
Set-Location Pet-healthcare
npm ci
Copy-Item .env.docker.example .env.docker
Copy-Item frontend/.env.example frontend/.env
```

Chỉ sao chép nếu file đích chưa tồn tại. Trong `.env.docker`, điền `POSTGRES_PASSWORD`, `DATABASE_URL=postgresql://nipopeto:<cùng-mật-khẩu>@postgres:5432/nipopeto?schema=public` và `JWT_SECRET` ngẫu nhiên ít nhất 32 ký tự. Nếu mật khẩu chứa ký tự đặc biệt, phải URL encode trong `DATABASE_URL`. Giữ file môi trường riêng ngoài Git; không gửi bí mật lên repository.

```powershell
docker compose --env-file .env.docker config --quiet
docker compose --env-file .env.docker up --build -d
docker compose --env-file .env.docker ps -a
Invoke-RestMethod http://localhost:5000/api/health
npm run dev:frontend
```

Compose khởi động PostgreSQL, chạy `migrate` rồi mới khởi động API. `migrate` thoát mã 0 là bình thường; frontend hiện chạy riêng ở `http://localhost:5173`. **Chỉ với database demo mới, trống và có thể bỏ**, tạo dữ liệu minh họa bằng `docker compose --env-file .env.docker run --rm --no-deps migrate npm run db:seed --workspace @nipopeto/backend`. Không chạy seed trên dữ liệu thật hoặc để “sửa” dữ liệu demo cũ: `upsert` với `update: {}` giữ nguyên bản ghi đã tồn tại.

## Luồng lưu trú và thanh toán pha 1

1. Chủ nuôi chọn thú cưng, ngày, phòng, dịch vụ và gửi yêu cầu. API yêu cầu header `Idempotency-Key`; lần gửi lại cùng mã và nội dung trả về booking cũ. Sau khi ghi thành công, giao diện chuyển sang `/owner/hotel-bookings/:id` để xem và mở lại yêu cầu. Lúc này chưa có hóa đơn hoặc VietQR.
2. Nhân viên xác nhận booking và check-in thú cưng bằng màn xác nhận. Mỗi lần đổi trạng thái lưu revision, người thao tác và lịch sử; thao tác nhận nhầm có thể hoàn tác theo điều kiện nghiệp vụ.
3. Khi booking `in_stay`, nhân viên chốt hóa đơn từ thông tin booking và giá đã lưu, bổ sung phí phát sinh nếu có. Booking cũ `checked_out` chưa có hóa đơn vẫn được chốt phí theo luồng tương thích. Chủ nuôi không thể tự phát hành hóa đơn khách sạn.
4. Với hóa đơn `unpaid`, chủ nuôi chọn tiền mặt tại cửa hàng hoặc chuyển khoản. VietQR chỉ hiện cho hóa đơn đã chọn chuyển khoản và còn được phép thanh toán. Chủ nuôi báo đã chuyển tiền chỉ tạo yêu cầu đối chiếu, **không** đổi thành `paid`.
5. Nhân viên kiểm tra tiền thực nhận rồi xác nhận `paid`, hoặc từ chối báo chuyển khoản kèm lý do. Lịch sử thanh toán ghi người thao tác và thời điểm trong cùng giao dịch với thay đổi hóa đơn. Xác nhận lặp lại cùng phương thức không tạo biên nhận thứ hai.
6. Chỉ khi hóa đơn khách sạn đã `paid`, nhân viên mới xác nhận bàn giao và checkout. Quản trị viên có thể hoàn tác lần bàn giao nhầm, giữ nguyên hóa đơn đã thanh toán và checkout lại mà không thu thêm.

Khách sạn thu đủ vào cuối kỳ lưu trú; pha này không có đặt cọc, trả góp, công nợ, hoàn tiền hay thay đổi phí sau khi phát hành hóa đơn. VNPay để pha sau và tắt mặc định. Thông tin chuyển khoản demo được ghi rõ chỉ để minh họa, không chuyển tiền thật.

## Biến môi trường thanh toán

- `BANK_TRANSFER_DEMO=true`: thông tin tài khoản minh họa. Để dùng tài khoản nhận tiền thật, đặt `false` và điền đủ `BANK_TRANSFER_BANK_NAME`, `BANK_TRANSFER_BANK_BIN` (6 chữ số), `BANK_TRANSFER_ACCOUNT_NUMBER`, `BANK_TRANSFER_ACCOUNT_HOLDER` trong `backend/.env`. Không đưa thông tin môi trường thật vào fixture hoặc tài liệu công khai. Tài khoản được chụp lại trên hóa đơn đã chọn chuyển khoản để không đổi nơi nhận của hóa đơn cũ.
- `VNPAY_ENABLED=false`: giữ tắt trong pha 1. Các biến `VNPAY_*` hiện có được dành cho bước tích hợp sau.
- `VITE_API_BASE_URL` trong `frontend/.env` chỉ chứa địa chỉ API công khai. Không đưa bí mật vào biến `VITE_*` hoặc Git.

## Kiểm tra

`npm test` chạy build hai phần, unit/HTTP test không database, kiểm tra ranh giới kiến trúc và OpenAPI. Đọc đặc tả API ở `/api/openapi.json` hoặc `/api/docs/` khi backend đang chạy.

Kiểm tra riêng helper Kaggle: `python -m unittest discover -s benchmarks/kaggle -p 'test_*.py' -v`. Browser test dùng `E2E_BROWSER_CHANNEL=msedge`, `E2E_START_FRONTEND=1` và `npm run test:e2e -- tests/e2e/medical-write-feedback.spec.ts tests/e2e/appointment-refresh.spec.ts`. Các browser test này mock API để kiểm tra giao diện, không chứng minh PostgreSQL thật.

Các ca tích hợp PostgreSQL, đồng thời và khóa giao dịch cần database **riêng** có tên kết thúc `_test`. Chỉ sau khi xác nhận database này là bản bỏ được, đặt `PG_TEST_DATABASE_URL` và chạy `npm run test:integration -w backend`; bộ test từ chối URL không phải `localhost`/`127.0.0.1` hoặc tên không kết thúc `_test`. Migration cho database test cũng phải được áp dụng **vào chính database test** trước đó. Không lấy `DATABASE_URL` đang vận hành để chạy suite. Các Playwright test dùng backend thật cần một môi trường demo/test riêng; hai test giao diện nêu trên dùng API mock nên không cần PostgreSQL.

## Kaggle CPU và giới hạn kết quả

Sau khi bản Pha 1 được commit/push, tải [`benchmarks/kaggle/notebook.ipynb`](benchmarks/kaggle/notebook.ipynb) lên Kaggle Notebook mới, chọn Accelerator **None**, bật Internet. Điền full `COMMIT_SHA` 40 ký tự của bản chốt trong cell cấu hình, rồi Run All. Notebook clone source đúng SHA, cài Node/PostgreSQL/Locust, chạy tối đa 16 lượt (ReadHeavyUser/MixedUser × 1/10/50/100 người dùng × hai lần) và tạo ZIP dưới `/kaggle/working`. Tải ZIP ở mục Output, bấm refresh nếu chưa thấy. Không dùng đường dẫn filesystem này làm URL Jupyter proxy để tải trực tiếp.

Mỗi lượt warmup 15 giây, đo 60 giây gồm ramp-up 5 người dùng/giây, think time 0,5–1,5 giây. Runner dừng khi lượt đo lỗi, error rate trên 1% hoặc p95 trên 2.000 ms. Báo cáo phải kèm SHA, dirty flag, cấu hình CPU/RAM, versions, requests, failures, RPS, p95 và log. ZIP cũ 16 lượt thuộc SHA `48d01c3c95d136f808b846a66a75fe08aacd92be`; nó là baseline lịch sử, không chứng minh bản sau các thay đổi booking/thanh toán. Workload hiện chủ yếu là GET của chủ nuôi và một phần POST; chưa đo luồng admin, thanh toán và dữ liệu lớn. Kết quả này không phải cam kết tải production.

## Tình trạng nghiệm thu

| Yêu cầu Pha 1 | Bằng chứng có trong source |
| --- | --- |
| REST JSON, GET/POST/DELETE | Route trong `backend/src/routes/`, HTTP contract tests |
| OpenAPI/Swagger | `backend/openapi.json`, `/api/docs/`, `test:openapi` |
| Phân tầng và DAL/ORM | `backend/src/application`, `backend/src/infrastructure`, Prisma, `test:architecture` |
| Đăng nhập và GET/POST xác thực | `requireAuth`, route auth, HTTP auth tests |
| Docker | `Dockerfile.backend`, `docker-compose.yml`; đã kiểm tra build, migration, API health và luồng GET/POST/DELETE trên Compose project thử riêng |
| GitHub và README | Nhánh `refactor` công khai; bản README tiếng Việt phải được đưa vào commit bàn giao |
| Kaggle CPU | ZIP baseline lịch sử; cần chạy lại notebook ở full SHA bản chốt |

Trên working tree ngày 01/10/2026, build và 55/55 unit/HTTP test đạt; kiểm tra kiến trúc 59 file, OpenAPI 55 operation, 8 nhóm integration PostgreSQL, 7 Playwright test và Docker runtime trên dữ liệu thử đều đạt. Đây là kết quả cho mã chưa được commit tại thời điểm ghi README. Trạng thái cuối chỉ được xác nhận sau khi README và code được đưa lên GitHub, rồi ZIP Kaggle CPU cho **đúng full SHA bản chốt** được đối chiếu. Các tài liệu lưu riêng trên máy phát triển không phải điều kiện để làm theo README này.
