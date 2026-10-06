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

## Chạy toàn bộ ứng dụng bằng Docker Compose trên máy mới

Cần Git và Docker Desktop đang chạy với Linux containers. Node.js/npm và PostgreSQL được cung cấp trong Docker, không cần cài trên Windows. Bản được mô tả trong README này thuộc nhánh `main`:

```powershell
git clone -b main https://github.com/Nguyenquanghong/Pet-healthcare.git
Set-Location Pet-healthcare
if (-not (Test-Path .env.docker)) {
    Copy-Item .env.docker.example .env.docker
}
```

Thư mục sau khi clone cần có `Dockerfile.backend`, `Dockerfile.frontend`, `docker-compose.yml` và `frontend/nginx/default.conf.template`. Cấu hình Docker toàn bộ ứng dụng phải được commit/push cùng bản bàn giao để máy mới chạy được theo hướng dẫn này.

Trong `.env.docker`, điền `POSTGRES_PASSWORD`, `DATABASE_URL=postgresql://nipopeto:<cùng-mật-khẩu>@postgres:5432/nipopeto?schema=public` và `JWT_SECRET` ngẫu nhiên ít nhất 32 ký tự. Nếu mật khẩu chứa ký tự đặc biệt, phải URL encode trong `DATABASE_URL`. `postgres` là tên dịch vụ trong mạng Compose; không đổi thành `localhost`. Giữ file môi trường riêng ngoài Git; không gửi bí mật lên repository. Các cổng mặc định `5432`, `5000` và `5173` cần chưa bị ứng dụng khác sử dụng.

```powershell
docker compose --env-file .env.docker config --quiet
docker compose --env-file .env.docker up --build -d
docker compose --env-file .env.docker ps -a
Invoke-RestMethod http://localhost:5000/api/health
```

Mở `http://localhost:5173`. Compose khởi động PostgreSQL, chạy `migrate` rồi khởi động API và frontend. `migrate` thoát mã 0 là bình thường. Frontend được build trong Docker và phục vụ bằng Nginx; `/api/` được chuyển tiếp tới API qua mạng Compose. Có thể đổi cổng giao diện bằng `FRONTEND_PORT` trong `.env.docker`; bản frontend Docker luôn gọi `/api` cùng địa chỉ web. Đặc tả API ở `http://localhost:5000/api/docs/` khi dùng cổng mặc định.

**Chỉ với database demo mới, trống và có thể bỏ**, tạo dữ liệu minh họa sau khi Compose khởi động thành công:

```powershell
docker compose --env-file .env.docker run --rm --no-deps migrate npm run db:seed --workspace @nipopeto/backend
```

Sau seed, đăng nhập chủ nuôi tại `/login` bằng `owner@example.com` / `owner123`; đăng nhập admin tại `/admin/login` bằng `admin` / `admin123`. Seed có hai thú cưng Mochi/Yuki, lịch khám/Spa, một bệnh án độc lập và một booking khách sạn; chưa có hóa đơn mẫu. Ngày dữ liệu mẫu cố định trong tháng 10–11/2026, nên dashboard hôm nay có thể trống.

Không chạy seed trên dữ liệu thật hoặc để “sửa” dữ liệu demo cũ: seed cập nhật mật khẩu các tài khoản mẫu, còn các bản ghi thú cưng/lịch/bệnh án/booking dùng `update: {}` nên giữ nội dung đã tồn tại. Dừng ứng dụng bằng `docker compose --env-file .env.docker down`; lệnh này giữ volume database. Không dùng `down -v` nếu cần giữ dữ liệu.

## Phân trang và tải theo màn hình (02/10/2026)

Collection GET cho khách, pet, lịch hẹn, hotel, bệnh án, ảnh, nhật ký và thông báo/hóa đơn trả **`{ items, pagination, counts, related }`**. Mặc định 20 dòng, tối đa 100; `page` bắt đầu từ 1. Đây là thay đổi contract v3: cập nhật backend và frontend cùng nhau, thay các client đọc mảng trực tiếp bằng `response.items`. Ví dụ `GET /api/pets?page=2&pageSize=20&q=Mochi`. Tham số sai hoặc pageSize >100 trả 422; trang vượt tổng trả items rỗng. Owner luôn bị giới hạn theo JWT, kể cả khi truyền ownerId của người khác.

Tìm kiếm/lọc chạy ở DB trước skip/take; id là khóa cuối để thứ tự không trôi khi ngày trùng nhau. `pagination.total` là tổng sau lọc; `counts` đếm theo trạng thái trước bộ lọc status, độc lập với trang. `related` chỉ chứa quan hệ cần cho các dòng hiện tại. Giao diện có Trước/Sau và chọn 10/20/50/100 dòng, trở lại trang 1 khi đổi bộ lọc, bỏ response cũ và đưa về trang hợp lệ khi xóa hết trang cuối.

`GET /api/bootstrap` mặc định `view=session`: profile, tối đa 20 pet của owner và số thông báo chưa đọc, không tải lịch sử. `view=dashboard` trả preview giới hạn và tổng từ count/groupBy; không dùng độ dài preview làm KPI. Mỗi màn hình tải collection riêng; option khách/pet/lịch được tìm và phân trang bằng API. `GET /api/appointments/calendar?month=2026-10&category=medical` đếm toàn tháng theo scope. `GET /api/invoices/summary?month=2026-10` dành cho staff, tính thu tiền/chờ thu ở DB theo UTC+7. `mode=unbilled` trên lịch/hotel loại các nguồn đã có hóa đơn ngay tại DB.

Chạy `npm run db:deploy -w backend` trên đúng DB trước khi khởi động bản mới: migration phân trang bổ sung 15 index, tổng hiện có 12 migration. OpenAPI/Swagger đã mô tả 65 operation. Các bản ghi lịch sử và payment/status-history theo từng đơn vẫn là contract mảng; chúng được tải khi mở chi tiết, không nằm trong bootstrap.

Kaggle ZIP cũ đo mã trước phân trang. Workload `phase1-kaggle-v4` / `architecture-diagnostics-v2` hiện gửi `view=dashboard` và đọc envelope collection để khớp luồng mới; chưa có số tải Kaggle cho SHA mới. Khi so sánh trước/sau phải giữ hành trình nghiệp vụ và ghi rõ contract/workload version, không lấy RPS từ việc đọc ít dữ liệu rồi suy ra dung lượng toàn hệ thống.

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

**Cập nhật bản đang chạy:** migration `20261002120000_owner_activation` thêm bảng và quan hệ kích hoạt. Chạy `docker compose --env-file .env.docker up --build -d` để rebuild backend/frontend và áp dụng các migration còn thiếu rồi khởi động API; tải lại trình duyệt sau khi frontend được cập nhật. Không cần seed/reset database.

## Luồng lưu trú và thanh toán pha 1

1. Chủ nuôi chọn thú cưng, ngày, phòng, dịch vụ và gửi yêu cầu. API yêu cầu header `Idempotency-Key`; lần gửi lại cùng mã và nội dung trả về booking cũ. Sau khi ghi thành công, giao diện chuyển sang `/owner/hotel-bookings/:id` để xem và mở lại yêu cầu. Lúc này chưa có hóa đơn hoặc VietQR.
2. Nhân viên xác nhận booking và check-in thú cưng bằng màn xác nhận. Mỗi lần đổi trạng thái lưu revision, người thao tác và lịch sử; thao tác nhận nhầm có thể hoàn tác theo điều kiện nghiệp vụ.
3. Khi booking `in_stay`, nhân viên chốt hóa đơn từ thông tin booking và giá đã lưu, bổ sung phí phát sinh nếu có. Booking cũ `checked_out` chưa có hóa đơn vẫn được chốt phí theo luồng tương thích. Chủ nuôi không thể tự phát hành hóa đơn khách sạn.
4. Với hóa đơn `unpaid`, chủ nuôi chọn tiền mặt tại cửa hàng hoặc chuyển khoản. VietQR cần tài khoản nhận tiền hợp lệ, hóa đơn đã chọn chuyển khoản và còn được phép thanh toán; chế độ `BANK_TRANSFER_DEMO=true` mặc định chỉ hiển thị thông tin minh họa, không tạo VietQR. Chủ nuôi báo đã chuyển tiền chỉ tạo yêu cầu đối chiếu, **không** đổi thành `paid`.
5. Nhân viên kiểm tra tiền thực nhận rồi xác nhận `paid`, hoặc từ chối báo chuyển khoản kèm lý do. Lịch sử thanh toán ghi người thao tác và thời điểm trong cùng giao dịch với thay đổi hóa đơn. Xác nhận lặp lại cùng phương thức không tạo biên nhận thứ hai.
6. Chỉ khi hóa đơn khách sạn đã `paid`, nhân viên mới xác nhận bàn giao và checkout. Quản trị viên có thể hoàn tác lần bàn giao nhầm, giữ nguyên hóa đơn đã thanh toán và checkout lại mà không thu thêm.

Khách sạn thu đủ vào cuối kỳ lưu trú; pha này không có đặt cọc, trả góp, công nợ, hoàn tiền hay thay đổi phí sau khi phát hành hóa đơn. VNPay để pha sau và tắt mặc định. Thông tin chuyển khoản demo được ghi rõ chỉ để minh họa, không chuyển tiền thật.

## Biến môi trường thanh toán

- `BANK_TRANSFER_DEMO=true`: thông tin tài khoản minh họa, không tạo VietQR. Để dùng tài khoản nhận tiền thật, đặt `false` và điền đủ `BANK_TRANSFER_BANK_NAME`, `BANK_TRANSFER_BANK_BIN` (6 chữ số), `BANK_TRANSFER_ACCOUNT_NUMBER` (6–19 chữ số), `BANK_TRANSFER_ACCOUNT_HOLDER` trong `.env.docker`, rồi chạy lại `docker compose --env-file .env.docker up -d api`. Không đưa thông tin môi trường thật vào fixture hoặc tài liệu công khai. Tài khoản được chụp lại trên hóa đơn đã chọn chuyển khoản để không đổi nơi nhận của hóa đơn cũ.
- `VNPAY_ENABLED=false`: giữ tắt trong pha 1. Các biến `VNPAY_*` hiện có được dành cho bước tích hợp sau.
- Frontend Docker được build với `VITE_API_BASE_URL=/api`; không cần tạo `frontend/.env`. `PORT` và `FRONTEND_PORT` trong `.env.docker` điều khiển cổng API và giao diện; các URL trong ví dụ trên dùng giá trị mặc định.

## Kiểm tra

Build backend/frontend được thực hiện khi chạy `docker compose --env-file .env.docker up --build -d`. Tại thư mục gốc, kiểm tra backend trong image `migrate` đã build:

```powershell
docker compose --env-file .env.docker run --rm --no-deps --volume "${PWD}/benchmarks/kaggle:/work/benchmarks/kaggle:ro" migrate npm run test:unit --workspace @nipopeto/backend
docker compose --env-file .env.docker run --rm --no-deps migrate npm run test:architecture --workspace @nipopeto/backend
docker compose --env-file .env.docker run --rm --no-deps migrate npm run test:openapi --workspace @nipopeto/backend
```

Unit test có ca dùng helper Kaggle nên lệnh đầu gắn thư mục `benchmarks/kaggle` chỉ đọc vào container; `Dockerfile.backend` không sao chép thư mục này vào image. Các lệnh trên kiểm tra unit/HTTP không database, ranh giới kiến trúc và OpenAPI; không thay thế test trình duyệt hoặc test tích hợp PostgreSQL. Đọc đặc tả API ở `/api/openapi.json` hoặc `/api/docs/` khi backend đang chạy.

Test trình duyệt nằm trong `tests/e2e/`. Các file `owner-activation.spec.ts`, `admin-creation.spec.ts`, `medical-write-feedback.spec.ts` và `appointment-refresh.spec.ts` dùng API mock; các ca dùng API thật cần môi trường demo/test riêng. Image frontend Nginx chỉ phục vụ bản build, không chứa trình duyệt hoặc môi trường chạy Playwright.

Các ca tích hợp PostgreSQL trong `backend/tests/*.integration.mjs` yêu cầu `PG_TEST_DATABASE_URL` trỏ tới database **riêng**, đã migrate và có tên kết thúc `_test`; bộ test từ chối host khác `localhost`/`127.0.0.1`. Vì vậy không thể chạy trực tiếp suite trong container `migrate` với URL dùng host `postgres` như cấu hình ứng dụng. Không dùng database đang vận hành để thử suite.

## Kiểm thử hiệu năng trên Kaggle CPU

Commit/push cả bản Pha 1 và các file harness mới trong `benchmarks/kaggle/` (gồm `ports.py`, `test_ports.py`), lấy `git rev-parse HEAD`, rồi tải [`benchmarks/kaggle/notebook.ipynb`](benchmarks/kaggle/notebook.ipynb) lên Kaggle Notebook mới, chọn Accelerator **None**, bật Internet. Điền full `COMMIT_SHA` 40 ký tự ở cell cấu hình, giữ `RUN_LABEL="B1"`, rồi Run All. Notebook kiểm SHA, working tree và protocol `phase1-kaggle-v4`; source ở SHA cũ chưa có harness này sẽ bị chặn. Cell cài đặt kiểm cả PostgreSQL server (`initdb`, `pg_ctl`), chọn Node.js 24 và cài đúng Locust 2.44.4/psutil 7.0.0 bằng Python của kernel; không cần Docker.

Protocol v4 giữ thời gian, think time và ma trận của v3 nhưng đọc trang 1/20 dòng và bootstrap dashboard: warmup **45 giây**, process đo **120 giây**, tăng tải 5 người dùng/giây, think time 0,5–1,5 giây. Lượt đo khởi động Locust mới và **gồm ramp-up**; 100 users có khoảng 100 giây sau ramp, không gọi số tổng hợp là riêng steady state. HTTP timeout 10 giây, Locust cho tối đa 12 giây hoàn tất request đang chạy khi dừng. Riêng thời gian tải của 16 lượt khoảng 44 phút, cộng thời gian cài/build/migrate. Các biến profile/users/repeats/thời gian nằm ở đầu notebook; giữ nguyên khi so sánh B1/B2 trong cùng phiên Kaggle CPU.

Ứng dụng sử dụng Locust để đo hiệu năng REST API trên Kaggle với hai kịch bản:

- **ReadHeavyUser:** đọc dữ liệu tổng hợp, thú cưng, lịch hẹn và thông báo.
- **MixedUser:** kết hợp các thao tác đọc với tạo lịch khám và gửi thông tin tìm thấy thú cưng qua hồ sơ QR.

Backend, PostgreSQL và Locust chạy trên cùng môi trường CPU. Mỗi lượt dùng database tạm và dữ liệu giả lập, tách biệt với dữ liệu vận hành.

### Thực hiện kiểm thử

1. Tải [notebook kiểm thử](benchmarks/kaggle/notebook.ipynb) lên Kaggle, chọn **Accelerator: None** và bật **Internet**.
2. Điền thông tin phiên bản mã nguồn cần kiểm thử tại cell cấu hình theo hướng dẫn trong notebook.
3. Chạy các cell theo thứ tự. Sau khi hoàn tất hoặc dừng kiểm thử, chạy cell cuối để đóng gói báo cáo và tải ZIP từ mục **Output**.

### Cấu hình đo

| Thông số | Giá trị |
| --- | --- |
| Mức tải | 1, 10, 50 và 100 người dùng đồng thời |
| Số lần lặp | 2 lần cho mỗi kịch bản và mức tải, tổng cộng 16 lượt |
| Thời gian khởi động tải | 45 giây mỗi lượt |
| Thời gian đo | 120 giây mỗi lượt, bao gồm giai đoạn tăng tải |
| Tốc độ tăng tải | 5 người dùng/giây |
| Khoảng nghỉ giữa thao tác | 0,5–1,5 giây |
| Thời gian chờ HTTP tối đa | 10 giây |
| Ngưỡng đánh giá | Tỷ lệ lỗi không quá 1%; p95 không quá 2.000 ms |

Môi trường ghi nhận: Intel Xeon 2,20 GHz, 4 CPU logic, RAM khoảng 31,35 GiB; Node.js 24.15.0, PostgreSQL 14.24, Python 3.12.13 và Locust 2.44.4.

### Kết quả đo ngày 01/10/2026

Hoàn thành **16/16 lượt**, tổng cộng **72.107 yêu cầu, 0 lỗi**. Thời gian toàn bộ đợt kiểm thử khoảng **58,38 phút**, bao gồm cài đặt, build, migration và đo tải.

| Người dùng đồng thời | ReadHeavy: RPS trung bình | ReadHeavy: p95 từng lượt (ms) | Mixed: RPS trung bình | Mixed: p95 từng lượt (ms) |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1,05 | 8 / 8 | 1,05 | 14 / 14 |
| 10 | 9,96 | 7 / 7 | 9,92 | 13 / 13 |
| 50 | 48,18 | 8 / 9 | 47,89 | 13 / 13 |
| 100 | 91,80 | 11 / 12 | 91,62 | 15 / 15 |

RPS là số yêu cầu xử lý mỗi giây, lấy trung bình của hai lượt. p95 là thời gian phản hồi mà 95% yêu cầu không vượt quá; bảng giữ riêng giá trị của từng lượt.

Ở mức 100 người dùng, CPU API trung bình khoảng **50,47%** với ReadHeavy và **56,40%** với Mixed; PostgreSQL lần lượt khoảng **6,54%** và **9,08%**. Các tỷ lệ này dùng quy ước **100% tương ứng một lõi CPU**. Chưa ghi nhận bão hòa CPU trong phạm vi tải đã đo.

### Phạm vi đánh giá

Các số liệu trên thuộc đợt đo ngày 01/10/2026 và phản ánh hai kịch bản API đã nêu. Kiểm thử chưa bao phủ toàn bộ luồng admin, thanh toán, giao diện hoặc dữ liệu quy mô lớn; chưa xác định giới hạn tải tối đa của hệ thống. Báo cáo ZIP gồm kết quả, cấu hình môi trường và log cần được lưu cùng tài liệu bàn giao để đối chiếu.

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
| Docker | `Dockerfile.backend`, `Dockerfile.frontend`, `docker-compose.yml`, `frontend/nginx/default.conf.template`; Compose gồm PostgreSQL, migration, API và frontend Nginx |
| GitHub và README | Bản hiện tại thuộc nhánh `baseline/phase1-bootstrap`; cấu hình Docker và README cập nhật cần được commit/push cùng bản bàn giao |
| Kaggle CPU | Hai kịch bản API, 1–100 người dùng đồng thời; đợt đo ngày 01/10/2026 hoàn thành 16/16 lượt, 72.107 yêu cầu, 0 lỗi |
