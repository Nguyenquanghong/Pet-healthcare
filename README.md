# Pet Healthcare (NIPOPETO)

Ứng dụng quản lý thú cưng, lịch khám và Spa, lưu trú khách sạn, hồ sơ y tế, hóa đơn và thông báo. `frontend/` dùng React, TypeScript và Vite; `backend/` là một ứng dụng Express chia module theo route → application service/port → infrastructure, dùng Prisma và PostgreSQL. Hai phần dùng chung npm workspace; đây chưa phải kiến trúc microservice.

## Phạm vi và kiến trúc Pha 1

Chủ nuôi có tài khoản quản lý thú cưng, đặt lịch, đặt phòng, xem bệnh án/hóa đơn của mình. Nhân viên và quản trị viên có thể tạo hồ sơ khách mới tại quầy, thêm thú cưng, tạo lịch khám/Spa và đặt phòng thay khách; xác nhận lịch, check-in, ghi chăm sóc/bệnh án, chốt phí và đối chiếu thanh toán. Khách đến trực tiếp không cần đăng ký tài khoản trước để dùng dịch vụ. VNPay tắt mặc định; không có đặt cọc, hoàn tiền hoặc tồn kho phòng tự động trong phạm vi này.

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
| `POST /owners` | JWT admin/nhân viên | Tạo hồ sơ khách tại quầy, chưa cấp đăng nhập online; không trả token |
| `POST /owners/{id}/activation` | JWT admin/nhân viên | Cấp liên kết kích hoạt sau khi xác minh khách và email |
| `POST /auth/owner/activation/inspect`, `POST /auth/owner/activation` | Công khai, cần mã kích hoạt | Kiểm tra liên kết và đặt mật khẩu trên hồ sơ cũ; không trả JWT |
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


## Phân trang và tải theo màn hình (02/10/2026)

Collection GET cho khách, pet, lịch hẹn, hotel, bệnh án, ảnh, nhật ký và thông báo/hóa đơn trả **`{ items, pagination, counts, related }`**. Mặc định 20 dòng, tối đa 100; `page` bắt đầu từ 1. Đây là thay đổi contract v3: cập nhật backend và frontend cùng nhau, thay các client đọc mảng trực tiếp bằng `response.items`. Ví dụ `GET /api/pets?page=2&pageSize=20&q=Mochi`. Tham số sai hoặc pageSize >100 trả 422; trang vượt tổng trả items rỗng. Owner luôn bị giới hạn theo JWT, kể cả khi truyền ownerId của người khác.

Tìm kiếm/lọc chạy ở DB trước skip/take; id là khóa cuối để thứ tự không trôi khi ngày trùng nhau. `pagination.total` là tổng sau lọc; `counts` đếm theo trạng thái trước bộ lọc status, độc lập với trang. `related` chỉ chứa quan hệ cần cho các dòng hiện tại. Giao diện có Trước/Sau và chọn 10/20/50/100 dòng, trở lại trang 1 khi đổi bộ lọc, bỏ response cũ và đưa về trang hợp lệ khi xóa hết trang cuối.

`GET /api/bootstrap` mặc định `view=session`: profile, tối đa 20 pet của owner và số thông báo chưa đọc, không tải lịch sử. `view=dashboard` trả preview giới hạn và tổng từ count/groupBy; không dùng độ dài preview làm KPI. Mỗi màn hình tải collection riêng; option khách/pet/lịch được tìm và phân trang bằng API. `GET /api/appointments/calendar?month=2026-10&category=medical` đếm toàn tháng theo scope. `GET /api/invoices/summary?month=2026-10` dành cho staff, tính thu tiền/chờ thu ở DB theo UTC+7. `mode=unbilled` trên lịch/hotel loại các nguồn đã có hóa đơn ngay tại DB.

Chạy `npm run db:deploy -w backend` trên đúng DB trước khi khởi động bản mới: migration phân trang bổ sung 15 index, tổng hiện có 12 migration. OpenAPI/Swagger đã mô tả 65 operation. Các bản ghi lịch sử và payment/status-history theo từng đơn vẫn là contract mảng; chúng được tải khi mở chi tiết, không nằm trong bootstrap.

Kaggle ZIP cũ đo mã trước phân trang. Workload `phase1-kaggle-v4` / `architecture-diagnostics-v2` hiện gửi `view=dashboard` và đọc envelope collection để khớp luồng mới; chưa có số tải Kaggle cho SHA mới. Khi so sánh trước/sau phải giữ hành trình nghiệp vụ và ghi rõ contract/workload version, không lấy RPS từ việc đọc ít dữ liệu rồi suy ra dung lượng toàn hệ thống.

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

## Nhân viên tạo thú cưng và đặt dịch vụ tại quầy

Trong admin, vào **Thú cưng → Thêm thú cưng**, **Lịch hẹn → Tạo lịch khám / Spa**, hoặc **Hotel Bookings → Tạo đặt phòng**. Với khách đã có hồ sơ, dùng **Tìm khách đã có** theo tên, số điện thoại, email hoặc mã; chọn đúng chủ nuôi rồi chọn thú cưng. Đổi chủ nuôi sẽ bỏ lựa chọn thú cưng cũ. Nếu khách mang thú cưng mới, dùng **Thêm thú cưng cho chủ nuôi này** ngay trong form đặt dịch vụ; sau khi lưu, form tự chọn thú mới và tiếp tục đặt lịch/phòng.

Với khách lần đầu đến, bấm **Tạo khách mới** ngay trong form, nhập họ tên + số điện thoại; email và địa chỉ không bắt buộc. Kiểm tra thông tin rồi **Xác nhận tạo khách**. Form chuyển sang thêm thú cưng cho khách vừa tạo; lưu thú xong tiếp tục đặt phòng/lịch hẹn. Số điện thoại được chuẩn hóa về dạng 10 chữ số; phát hiện trùng số điện thoại/email sẽ trả `409`, nhân viên dùng **Tìm khách đã có** để chọn lại, không ghi đè hồ sơ. API chỉ cho admin/nhân viên tạo khách, không đổi phiên đăng nhập của nhân viên.

Hồ sơ tại quầy ban đầu chưa có mật khẩu hoặc quyền đăng nhập online. Khi khách muốn đăng nhập, dùng quy trình kích hoạt bên dưới; không tạo thêm tài khoản qua trang đăng ký cho cùng khách. Các tài khoản chủ nuôi đã đăng ký vẫn đăng nhập theo luồng hiện có.

Nhập thông tin, bấm **Kiểm tra thông tin**, đối chiếu tên + số điện thoại + mã chủ nuôi/thú cưng, ngày giờ/dịch vụ rồi xác nhận lưu. Lịch mới ở trạng thái `pending`; lịch khám/Spa có nhãn **Nhân viên tạo**. Các bước xác nhận, check-in, hoàn tác và lịch sử thao tác dùng luồng hiện có. Booking khách sạn được backend tính giá và kiểm tra trùng khoảng lưu trú, chưa tạo hóa đơn/VietQR khi đặt. Nhân viên vẫn chốt phí cuối kỳ và chỉ checkout khi đã xác nhận thu đủ tiền.

Form khóa gửi lặp khi đang lưu. Gửi lại booking khách sạn trong cùng form dùng lại `Idempotency-Key` nếu nội dung không đổi. Khi đã lưu nhưng tải danh sách lỗi, dùng **Tải lại danh sách**, không tạo lại. Với yêu cầu tạo khách/thú cưng/lịch khám bị mất phản hồi, form yêu cầu **Tải và kiểm tra danh sách** trước khi tạo mới; các API này chưa có cơ chế idempotency như booking khách sạn. API tạo khách còn có ràng buộc unique số điện thoại/email để chặn hai yêu cầu tạo đồng thời cùng thông tin chuẩn hóa.

### Kích hoạt đăng nhập cho khách đã có hồ sơ tại quầy

1. Admin/nhân viên vào **Khách hàng** (`/admin/owners`), tìm và đối chiếu họ tên, số điện thoại, mã chủ nuôi với khách thực tế. Hồ sơ chưa có thú cưng vẫn xuất hiện trong danh sách.
2. Bấm **Kích hoạt tài khoản**, nhập email đăng nhập của khách và tích xác nhận đã xác minh đúng khách/hồ sơ/email. Bấm **Cấp liên kết kích hoạt**. Email của hồ sơ chưa bị thay đổi ở bước này.
3. Sao chép liên kết và giao riêng cho đúng khách. Hệ thống chưa gửi email tự động; nhân viên không đặt mật khẩu thay khách. Liên kết dùng một lần, hết hạn sau **30 phút**. **Cấp lại liên kết** cần xác nhận lại và thu hồi mọi liên kết chưa dùng trước đó.
4. Khách mở liên kết, tự nhập mật khẩu 8–128 ký tự và xác nhận. Backend cập nhật email + mật khẩu trên **chính ID chủ nuôi cũ**, giữ nguyên thú cưng, bệnh án, lịch hẹn, đặt phòng và hóa đơn. Khách đăng nhập riêng tại `/login` sau khi kích hoạt thành công.
5. Khi danh sách admin chưa phản ánh việc khách vừa kích hoạt, bấm **Tải lại danh sách**. Khách đã có mật khẩu không có nút kích hoạt; API cũng từ chối cấp lại để ngăn dùng luồng này đặt lại tài khoản đang hoạt động. Chức năng quên mật khẩu/gộp hai tài khoản không nằm trong luồng này.

Mã ngẫu nhiên 256 bit được đặt trong fragment `#token=...` của liên kết; API nhận mã qua JSON body, database chỉ lưu SHA-256. Bảng `owner_activations` giữ người cấp, thời điểm cấp/hết hạn/sử dụng/thu hồi. Kiểm tra và tiêu thụ mã nằm trong giao dịch có khóa hồ sơ, chỉ một yêu cầu đồng thời có thể kích hoạt. Các endpoint công khai dùng giới hạn auth chung 50 yêu cầu/IP/15 phút và trả `Cache-Control: no-store`. Email trùng hồ sơ khác bị chặn; nhân viên kiểm tra lại thay vì tự gộp hồ sơ bằng số điện thoại.

Liên kết dùng địa chỉ frontend đang mở trên máy nhân viên. `localhost` chỉ dùng được khi demo trên cùng máy; để khách mở trên thiết bị khác phải cấp liên kết từ địa chỉ frontend mà khách truy cập được. Khi triển khai thực tế, dùng HTTPS và giao liên kết riêng vì người giữ mã còn hiệu lực có thể đặt mật khẩu cho hồ sơ đó.

**Cập nhật bản đang chạy:** lần bổ sung này có migration `20261002120000_owner_activation`, chỉ thêm bảng và quan hệ kích hoạt. Với Docker, chạy `docker compose --env-file .env.docker up --build -d` để rebuild backend và chạy migration rồi khởi động API; frontend dev tự tải mã mới, khởi động lại nếu cần. Không cần seed/reset database. Nếu chạy backend trực tiếp, áp dụng `npm run db:deploy -w backend` vào đúng database, rồi restart backend; với bản build chạy `npm run build` trước khi restart.

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

Kiểm tra riêng helper Kaggle: `python -m unittest discover -s benchmarks/kaggle -p 'test_*.py' -v`. Browser test dùng `E2E_BROWSER_CHANNEL=msedge`, `E2E_START_FRONTEND=1` và `npm run test:e2e -- tests/e2e/owner-activation.spec.ts tests/e2e/admin-creation.spec.ts tests/e2e/medical-write-feedback.spec.ts tests/e2e/appointment-refresh.spec.ts`. Các browser test này mock API để kiểm tra giao diện, không chứng minh PostgreSQL thật.

Các ca tích hợp PostgreSQL, đồng thời và khóa giao dịch cần database **riêng** có tên kết thúc `_test`. Chỉ sau khi xác nhận database này là bản bỏ được, đặt `PG_TEST_DATABASE_URL` và chạy `npm run test:integration -w backend`; bộ test từ chối URL không phải `localhost`/`127.0.0.1` hoặc tên không kết thúc `_test`. Migration cho database test cũng phải được áp dụng **vào chính database test** trước đó. Không lấy `DATABASE_URL` đang vận hành để chạy suite. Các Playwright test dùng backend thật cần một môi trường demo/test riêng; bốn file test giao diện nêu trên dùng API mock nên không cần PostgreSQL.

## Kaggle CPU và giới hạn kết quả

Commit/push cả bản Pha 1 và các file harness mới trong `benchmarks/kaggle/` (gồm `ports.py`, `test_ports.py`), lấy `git rev-parse HEAD`, rồi tải [`benchmarks/kaggle/notebook.ipynb`](benchmarks/kaggle/notebook.ipynb) lên Kaggle Notebook mới, chọn Accelerator **None**, bật Internet. Điền full `COMMIT_SHA` 40 ký tự ở cell cấu hình, giữ `RUN_LABEL="B1"`, rồi Run All. Notebook kiểm SHA, working tree và protocol `phase1-kaggle-v4`; source ở SHA cũ chưa có harness này sẽ bị chặn. Cell cài đặt kiểm cả PostgreSQL server (`initdb`, `pg_ctl`), chọn Node.js 24 và cài đúng Locust 2.44.4/psutil 7.0.0 bằng Python của kernel; không cần Docker.

Ma trận tối đa 16 lượt: ReadHeavyUser/MixedUser × 1/10/50/100 người dùng × hai lần. Notebook tạo thư mục bằng chứng mới cho mỗi lần chạy cell, giữ kết quả cũ. Tải ZIP ở mục **Output**, bấm refresh nếu chưa thấy. Không dùng đường dẫn `/kaggle/working/...` làm URL Jupyter proxy để tải trực tiếp. Khi một run lỗi hoặc bạn dừng ma trận, vẫn chạy cell cuối để đóng gói kết quả một phần và runner log. `COMPLETE_PASS` chỉ nghĩa là đủ ma trận này và không vi phạm điều kiện đo; `PARTIAL_OR_FAILED` nghĩa là thiếu/lỗi/vượt ngưỡng.

Protocol v4 giữ thời gian, think time và ma trận của v3 nhưng đọc trang 1/20 dòng và bootstrap dashboard: warmup **45 giây**, process đo **120 giây**, tăng tải 5 người dùng/giây, think time 0,5–1,5 giây. Lượt đo khởi động Locust mới và **gồm ramp-up**; 100 users có khoảng 100 giây sau ramp, không gọi số tổng hợp là riêng steady state. HTTP timeout 10 giây, Locust cho tối đa 12 giây hoàn tất request đang chạy khi dừng. Riêng thời gian tải của 16 lượt khoảng 44 phút, cộng thời gian cài/build/migrate. Các biến profile/users/repeats/thời gian nằm ở đầu notebook; giữ nguyên khi so sánh B1/B2 trong cùng phiên Kaggle CPU.

### Kết quả B1 đã đối chiếu ngày 01/10/2026

ZIP `nipopeto-evidence-B1-20261001T103019Z-4fba7fce.zip` tại SHA **`c178824e50bbdcd9c095ff706d9eb8c10a033596`**, protocol v3, working tree sạch, đạt **COMPLETE_PASS: 16/16 lượt**, tổng **72.107 request, 0 lỗi**. Đã đối chiếu đủ ma trận, manifest với `locust_final.json`, CSV lỗi, runner/API/PostgreSQL logs; cấu hình phần cứng và phiên bản công cụ thống nhất, các lượt chạy tuần tự. SHA256 ZIP: `7a2d48c38e97a97e1b6082af441be70cf97ae51ccec260331df039b2ead3b627`. Giữ ZIP cùng bài nộp hoặc đính kèm bản phát hành để người khác kiểm chứng; tài liệu phân tích local không thay thế ZIP.

| Users | ReadHeavy: RPS trung bình | ReadHeavy: p95 từng lượt (ms) | Mixed: RPS trung bình | Mixed: p95 từng lượt (ms) |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1,05 | 8 / 8 | 1,05 | 14 / 14 |
| 10 | 9,96 | 7 / 7 | 9,92 | 13 / 13 |
| 50 | 48,18 | 8 / 9 | 47,89 | 13 / 13 |
| 100 | 91,80 | 11 / 12 | 91,62 | 15 / 15 |

RPS là trung bình số đo của hai lượt; p95 giữ riêng từng lượt, không lấy trung bình percentile để giả thành percentile gộp. Phần cứng Kaggle: Intel Xeon 2,20 GHz, 4 logical CPUs, affinity [0,1,2,3], RAM khoảng 31,35 GiB. Công cụ: Node 24.15.0, npm 11.12.1, PostgreSQL 14.24, Python 3.12.13, Locust 2.44.4. Warmup/đo 45s/120s mỗi lượt; toàn ma trận khoảng 58,38 phút kể cả setup/build/migrate từng lượt.

Ở 100 users, CPU API trung bình qua hai lượt khoảng 50,47% (ReadHeavy) và 56,40% (Mixed), với **100%=một core**, không phải toàn máy; PostgreSQL khoảng 6,54% và 9,08%. Chưa thấy dấu hiệu bão hòa CPU trong workload đã đo. Kết quả đáp ứng phần kiểm thử tải Kaggle CPU của Pha 1 cho SHA trên; chưa xác định giới hạn tải tối đa hoặc đủ cơ sở bắt buộc tách microservice.

Lịch sử: ZIP tại SHA `957e693a8bf5af5dfabea83a78bf83ba2b3a9fef` chỉ đạt 4/16 lượt do kiểm tra cổng `55432` báo `Address already in use` trước khi tạo tải 50 users. V3 dùng `socket.create_server` với SO_REUSEADDR trên Linux để không báo nhầm TIME_WAIT thành listener, vẫn chặn dịch vụ đang chạy; 13/13 helper/notebook/port tests trên Linux đạt. ZIP mới đã chạy đủ ma trận, không tái diễn lỗi cổng. Nếu cổng thật sự bận, xem runner log hoặc mở phiên Kaggle mới; không chạy nhiều ma trận đồng thời và không gộp số đo khác SHA thành cùng baseline.

Runner dừng khi lượt đo lỗi, error rate trên 1% hoặc p95 trên 2.000 ms. `manifest.results` lấy bộ đếm cuối qua sự kiện kết thúc Locust (`locust_final.json`); CSV định kỳ vẫn giữ dưới `csv_snapshot` để đối chiếu. Percentile theo histogram làm tròn của Locust. Báo cáo kèm SHA, dirty flag, protocol, CPU model/affinity, CPU/RAM, versions, requests, failures, RPS, p95 và log. ZIP cũ 16 lượt thuộc SHA `48d01c3c95d136f808b846a66a75fe08aacd92be` dùng thời gian 15s/60s và CSV snapshot; chỉ là baseline lịch sử, không so trực tiếp với v2 và không chứng minh bản sau các thay đổi booking/thanh toán. Workload hiện chủ yếu là GET của chủ nuôi và một phần POST; chưa đo luồng admin, thanh toán và dữ liệu lớn. Kết quả này không phải cam kết tải production hoặc tự đủ cơ sở để chuyển microservice.

## Kiểm thử chẩn đoán để chọn cải tiến Pha 2

Dùng [`notebook_diagnostics.ipynb`](benchmarks/kaggle/notebook_diagnostics.ipynb), protocol `architecture-diagnostics-v2`. Bản mới kiểm tra chi phí count/facet/search trên dataset lớn với dashboard preview có giới hạn và collection trang 1/20 dòng; API của admin và chủ nuôi dùng chung process/DB. Đây là giả thuyết cần đo, không phải kết luận monolith phải chuyển thành microservice. Baseline B1 16 lượt ở trên vẫn là kết quả riêng.

| `SUITE` | Kịch bản và đối chứng | Số lượt | Cần xem |
| --- | --- | ---: | --- |
| `data` (mặc định) | 3 admin, cố định 500 chủ nuôi/thú cưng; 1.000/10.000/50.000 đợt lịch sử, mỗi mức lặp 2 lần | 6 | p95/p99, byte/response và RAM của bootstrap/danh sách theo kích thước dữ liệu |
| `interference` | Cùng 10.000 đợt lịch sử; 50 owner GET pets so với đúng 50 owner + 5 admin GET bootstrap; chạy A/B rồi B/A | 4 | p95/RPS/lỗi riêng `OWNER probe`, CPU API/DB/generator |
| `stress` | Cùng 10.000 đợt lịch sử, cố định 500 chủ nuôi/thú cưng; MixedUser 100/200/300/500, mỗi mức lặp 2 lần | 8 | Mức bắt đầu tăng độ trễ/lỗi; GET và POST riêng |
| `soak` | MixedUser 100, dữ liệu ban đầu 10.000 đợt; khoảng 30 phút sau ramp | 1 | Diễn biến RAM/CPU/độ trễ theo thời gian, tốc độ tăng dữ liệu do POST |

Một **đợt lịch sử = 8 bản ghi**: lịch hẹn, bệnh án, booking khách sạn, nhật ký chăm sóc, hóa đơn, dòng hóa đơn và hai thông báo (owner/admin). Ví dụ 50.000 đợt tạo 400.000 bản ghi lịch sử ngoài 500 chủ nuôi/thú cưng. Seed chia batch, thực hiện ngoài thời gian đo, chạy `ANALYZE` trước warmup; không tạo ảnh lớn giả để tăng tải. Lịch sử đã hoàn thành và thanh toán, không chồng với ngày đặt lịch của workload. Fixture chứa token chỉ nằm trong thư mục tạm của runner, không đưa vào ZIP.

Cách chạy:

1. Commit/push README gốc và các file code/notebook trong `benchmarks/kaggle/`, đặc biệt các file mới `diagnostics.py`, `diagnostic_report.py`, `diagnostic_locustfile.py`, `diagnosticFixture.mjs`, `prepare_diagnostic_fixture.mjs`, `test_diagnostics.py`, `notebook_diagnostics.ipynb` cùng `runner.py`. README trong thư mục benchmark và tài liệu `docs/` vẫn có thể giữ local theo quy định nhóm; không cần các file local đó để chạy.
2. Lấy `git rev-parse HEAD`, upload notebook chẩn đoán lên Kaggle **CPU/Accelerator None**, bật Internet, điền SHA mới và `RUN_LABEL="B1D"`.
3. Bắt đầu bằng `SUITE="data"`, Run All. Dự kiến 40–50 phút gồm setup/seed; nếu vượt ngưỡng sẽ dừng sớm. Sau khi phân tích, chọn `interference` (~25–35 phút), `stress` (~60–75 phút), `soak` (~35 phút) khi cần. Thời gian phụ thuộc máy và seed.
4. Luôn chạy cell xuất ZIP cuối, kể cả khi lỗi/vượt ngưỡng; tải từ Output. Mỗi lần chạy tạo thư mục và ZIP mới, giữ bằng chứng cũ.

Spawn 10 users/s; owner nghỉ 0,5–1,5s, admin nghỉ 2–4s giữa tác vụ. Warmup ít nhất ramp+15s; measured process có ít nhất 300s sau ramp (soak 1800s). Số đo tổng hợp **vẫn gồm ramp-up**. Ngưỡng thăm dò mặc định từng endpoint: p95 2.000ms, riêng owner probe 500ms, error rate 1%; không phải SLA nghiệp vụ. Notebook dừng suite khi runner lỗi hoặc sau lượt vượt ngưỡng, không tự tăng tải tiếp. Có thể chỉnh hai biến p95 ở đầu notebook nhưng phải giữ cùng ngưỡng khi so B1D/B2D.

ZIP bổ sung `endpoint-summary.csv`, `endpoint_final.json`, `warmup_endpoint_final.json` và `fixture-summary.json`. `notebook-summary.json` ghi tỷ lệ p95 owner khi có/không có admin nếu đủ cặp hợp lệ. `COMPLETED_WITHIN_LIMITS` là hoàn tất suite dưới ngưỡng; `LIMIT_REACHED` là đã ghi nhận lượt đo vượt ngưỡng; `RUN_ERROR_OR_PARTIAL` cần đọc lỗi prerequisite/setup/warmup hoặc lý do dừng. **Tìm được giới hạn tải không đồng nghĩa đã chứng minh cần microservice.**

Payload media lớn có thể làm cả Locust bận nhận/parse JSON, nên xem CPU generator và byte/response trước khi kết luận API bão hòa. Nếu dữ liệu lớn làm danh sách chậm, đo offset/count/search và sửa truy vấn/index có thể là hướng cải tiến; nếu admin làm owner chậm, cần phân biệt tranh chấp DB với chi phí tạo JSON trong API. Chỉ chọn tách service sau khi có vấn đề cần cô lập/mở rộng độc lập và cân nhắc chi phí giao tiếp, nhất quán dữ liệu. Với B1D/B2D, đo cùng phiên Kaggle, cùng tổng CPU/RAM, versions, harness, seed, thời gian và hành trình. Thay đổi phân trang phải giữ lượng công việc nghiệp vụ tương đương khi so sánh. Một lượt soak tăng RAM chưa đủ kết luận rò rỉ bộ nhớ vì workload cũng tạo thêm dữ liệu.

Kiểm chứng harness chẩn đoán trước đợt phân trang: build backend đạt; 21/21 Python tests trên Linux và test fixture Node đạt; hai notebook hợp lệ về schema/cú pháp. Kiểm tra ngắn với PostgreSQL riêng, 20 chủ nuôi và 1.001 đợt lịch sử xác nhận dữ liệu/schema/quyền owner; bốn profile Locust chạy 16s/profile có 16/30/35/46 request, không lỗi, bộ đếm endpoint khớp tổng. Đây là kiểm tra khả năng chạy và xuất bằng chứng, **chưa phải kết quả của các suite đầy đủ trên Kaggle**.

## Tình trạng nghiệm thu

Cập nhật sửa lỗi **02/10/2026**: QR cứu hộ được sinh/đổi bằng backend qua `POST /api/pets/:id/qr-token` có JWT và kiểm tra quyền sở hữu. Public API chỉ nhận token hiện tại đang bật; token cũ sau đổi và ID thú cưng trả 404. Các thẻ cũ dùng ID cần tạo/in lại QR. PATCH pet không nhận `qrToken` do client tự chọn. Thẻ in dùng DOM/textContent để tên, giống và số điện thoại không thực thi HTML/script; lời nhắn cứu hộ chỉ gửi khi bấm lưu.

Pet và bệnh án kiểm tra enum, boolean thật, tên/nội dung bắt buộc, ngày lịch thực và số đo dương trong giới hạn DB; cân nặng tối đa 2 chữ số thập phân, nhiệt độ tối đa 1, nhịp tim là số nguyên. Optional `null`/chuỗi rỗng xóa số đo. Body vắng không gây login 500. Đăng ký/activation/đổi mật khẩu thống nhất 8–128 ký tự; lịch khám và hotel dùng ngày Việt Nam UTC+7. Read/delete notification áp dụng cùng scope với inbox hiển thị.

Password hash/verify trên HTTP dùng PBKDF2 bất đồng bộ, giữ tương thích hash cũ. Frontend lazy load theo trang: main JS giảm từ 583,42 xuống **251,34 kB** (gzip 152,61 → **80,66 kB**) ở bản phân trang. Shutdown đợi request trước ngắt Prisma. Prisma CLI đặt tại root workspace để override `deepmerge-ts@8.0.0` áp dụng nhất quán; `ip-address@10.7.3` cũng đã vá. Không nâng Prisma major.

Đợt sửa lỗi trước phân trang đã qua **77/77 unit/HTTP test**, guard kiến trúc **69 file**, OpenAPI **60 operation**, **11 nhóm PostgreSQL integration**, **27/27 Playwright test**, harness Python **21/21 trên Linux** (**20 PASS, 1 Linux-only skip trên Windows**), Docker build/runtime và **0 npm advisory** trong full/runtime audit. Kaggle ZIP trong README vẫn là baseline trước sửa; cần chạy lại notebook CPU trên SHA đã chốt trước khi chứng nhận hiệu năng bản mới.

Đợt phân trang tiếp theo đã qua **79/79 unit/HTTP**, guard **74 file**, OpenAPI **65 operation**, **12 nhóm PostgreSQL integration**, migration/Docker và **39/39 ca browser Pha 1** qua các nhóm độc lập. Tách nhóm API thật để không chạm auth rate limit tích lũy; giữ nguyên limiter, không báo một invocation toàn suite đạt. Ca VNPay Pha 2 skip vì mặc định tắt; VietQR chạy riêng trên tài khoản giả. Harness Python đạt 21/21 trên Linux, Windows 20 PASS và 1 Linux-only skip. Bộ tài liệu hiện hành và 18 sơ đồ đã đối chiếu lại với code/schema/API; chưa có load run Kaggle cho bản phân trang.

| Yêu cầu Pha 1 | Bằng chứng có trong source |
| --- | --- |
| REST JSON, GET/POST/DELETE | Route trong `backend/src/routes/`, HTTP contract tests |
| OpenAPI/Swagger | `backend/openapi.json`, `/api/docs/`, `test:openapi` |
| Phân tầng và DAL/ORM | `backend/src/application`, `backend/src/infrastructure`, Prisma, `test:architecture` |
| Đăng nhập và GET/POST xác thực | `requireAuth`, route auth, HTTP auth tests |
| Docker | `Dockerfile.backend`, `docker-compose.yml`; đã kiểm tra build, migration, API health và luồng GET/POST/DELETE trên Compose project thử riêng |
| GitHub và README | Nhánh `refactor` công khai; bản README tiếng Việt phải được đưa vào commit bàn giao |
| Kaggle CPU | SHA `c178824e50bbdcd9c095ff706d9eb8c10a033596`, protocol v3: 16/16 lượt đạt, 72.107 request, 0 lỗi; xem kết quả và SHA256 ZIP ở trên |

Trên working tree ngày 01/10/2026 sau khi thêm luồng tạo khách/dịch vụ tại quầy và kích hoạt tài khoản, build và **67/67 unit/HTTP test** đạt; kiểm tra kiến trúc **67 file**, OpenAPI **59 operation**, **10 nhóm integration PostgreSQL** và **23 Playwright test** đều đạt. Integration xác nhận mã hết hạn/đã dùng/cấp lại, tiêu thụ đồng thời đúng một lần, tranh chấp email không ghi dở dang, đăng nhập đúng ID cũ và giữ dữ liệu dịch vụ. Docker runtime đã được kiểm tra trong đợt nghiệm thu trước; đợt này dùng container PostgreSQL riêng để áp dụng migration mới và chạy API integration từ mã build mới, không rebuild toàn bộ Compose ứng dụng. Các kết quả chức năng này được ghi nhận trước khi commit; đợt đối chiếu ZIP mới chỉ kiểm tra bằng chứng Kaggle, không chạy lại toàn bộ test chức năng. Đã có baseline tải đầy đủ cho **SHA `c178824e50bbdcd9c095ff706d9eb8c10a033596`**. Khi bàn giao, đưa README cập nhật lên GitHub và giữ ZIP tương ứng; các tài liệu lưu riêng trên máy phát triển không phải điều kiện để làm theo README này.
