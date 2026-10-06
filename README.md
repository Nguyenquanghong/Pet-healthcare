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

Cần Git và Docker Desktop đang chạy với Linux containers. Node.js/npm và PostgreSQL được cung cấp trong Docker, không cần cài trên Windows. Bản được mô tả trong README này thuộc nhánh `baseline/phase1-bootstrap`:

```powershell
git clone -b baseline/phase1-bootstrap https://github.com/Nguyenquanghong/Pet-healthcare.git
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

## Kaggle CPU và giới hạn kết quả

Commit/push cả bản Pha 1 và các file harness trong `benchmarks/kaggle/` (gồm `ports.py`, `test_ports.py`), lấy `git rev-parse HEAD`, rồi tải [`benchmarks/kaggle/notebook.ipynb`](benchmarks/kaggle/notebook.ipynb) lên Kaggle Notebook mới, chọn Accelerator **None**, bật Internet. Điền full `COMMIT_SHA` 40 ký tự ở cell cấu hình, giữ `RUN_LABEL="B1"`, rồi Run All. Notebook kiểm SHA, working tree và protocol `phase1-kaggle-v3`; source ở SHA cũ chưa có harness này sẽ bị chặn. Cell cài đặt kiểm cả PostgreSQL server (`initdb`, `pg_ctl`), chọn Node.js 24 và cài đúng Locust 2.44.4/psutil 7.0.0 bằng Python của kernel. Đây là môi trường đo tải riêng trên Kaggle.

Ma trận tối đa 16 lượt: ReadHeavyUser/MixedUser × 1/10/50/100 người dùng × hai lần. Notebook tạo thư mục bằng chứng mới cho mỗi lần chạy cell, giữ kết quả cũ. Tải ZIP ở mục **Output**, bấm refresh nếu chưa thấy. Không dùng đường dẫn `/kaggle/working/...` làm URL Jupyter proxy để tải trực tiếp. Khi một run lỗi hoặc bạn dừng ma trận, vẫn chạy cell cuối để đóng gói kết quả một phần và runner log. `COMPLETE_PASS` chỉ nghĩa là đủ ma trận này và không vi phạm điều kiện đo; `PARTIAL_OR_FAILED` nghĩa là thiếu/lỗi/vượt ngưỡng.

Protocol v3 giữ cấu hình đo của v2: warmup **45 giây**, process đo **120 giây**, tăng tải 5 người dùng/giây, think time 0,5–1,5 giây. Lượt đo khởi động Locust mới và **gồm ramp-up**; 100 users có khoảng 100 giây sau ramp, không gọi số tổng hợp là riêng steady state. HTTP timeout 10 giây, Locust cho tối đa 12 giây hoàn tất request đang chạy khi dừng. Riêng thời gian tải của 16 lượt khoảng 44 phút, cộng thời gian cài/build/migrate. Các biến profile/users/repeats/thời gian nằm ở đầu notebook; giữ nguyên khi so sánh B1/B2 trong cùng phiên Kaggle CPU.

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

## Tình trạng nghiệm thu

| Yêu cầu Pha 1 | Bằng chứng có trong source |
| --- | --- |
| REST JSON, GET/POST/DELETE | Route trong `backend/src/routes/`, HTTP contract tests |
| OpenAPI/Swagger | `backend/openapi.json`, `/api/docs/`, `test:openapi` |
| Phân tầng và DAL/ORM | `backend/src/application`, `backend/src/infrastructure`, Prisma, `test:architecture` |
| Đăng nhập và GET/POST xác thực | `requireAuth`, route auth, HTTP auth tests |
| Docker | `Dockerfile.backend`, `Dockerfile.frontend`, `docker-compose.yml`, `frontend/nginx/default.conf.template`; Compose gồm PostgreSQL, migration, API và frontend Nginx |
| GitHub và README | Bản hiện tại thuộc nhánh `baseline/phase1-bootstrap`; cấu hình Docker và README cập nhật cần được commit/push cùng bản bàn giao |
| Kaggle CPU | SHA `c178824e50bbdcd9c095ff706d9eb8c10a033596`, protocol v3: 16/16 lượt đạt, 72.107 request, 0 lỗi; xem kết quả và SHA256 ZIP ở trên |

Đợt kiểm tra ngày **05/10/2026** trên working tree tại commit `3619e02`: build backend/frontend, **67/67 unit/HTTP test**, kiểm tra kiến trúc **67 file**, OpenAPI **59 operation** và **10 nhóm integration PostgreSQL** đều đạt. PostgreSQL chạy trong Docker thử riêng; đây chưa phải kết quả kiểm tra toàn bộ Compose có frontend Nginx.

Toàn bộ Playwright: **37 đạt, 5 lỗi, 2 bỏ qua**. Bốn ca lỗi do giới hạn xác thực; một ca lệch câu thông báo mong đợi trong test hoàn tác có hóa đơn. Chạy riêng sau khi khởi động lại API thử, bốn ca trang demo/QR và ca đặt hotel–gửi lại–tải lại đều đạt. Không coi bộ browser test hiện tại là đã đạt toàn bộ.

Các vấn đề đã tái hiện và còn cần sửa: hạn mức 50 yêu cầu/15 phút áp dụng cả `/auth/me` có thể làm mất phiên khi tải lại nhiều lần; đăng ký trùng số điện thoại trả `500`; tạo lịch nhận giờ đã qua trong hôm nay; đăng ký nhận mật khẩu một ký tự; đăng ký/sửa hồ sơ nhận số điện thoại có chữ. Tạo khách tại quầy dùng quy trình kiểm tra riêng và trả `409` khi trùng liên hệ như mô tả ở trên.

Kết quả Kaggle B1 ở trên thuộc **SHA `c178824e50bbdcd9c095ff706d9eb8c10a033596`**, không chứng minh các thay đổi sau SHA đó. Khi bàn giao, giữ ZIP tương ứng cùng bài nộp hoặc bản phát hành.
