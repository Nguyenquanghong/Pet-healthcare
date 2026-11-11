# Hướng dẫn tải và chạy Pet Healthcare

Hướng dẫn này dành cho **Windows PowerShell**, chạy toàn bộ PostgreSQL, backend và frontend bằng Docker Compose. Các lệnh bên dưới thực hiện ở **thư mục gốc** `Pet-healthcare`, nơi có `docker-compose.yml`.

## 0. Điểm bắt đầu cho nhóm làm việc Pha 2 (3 Service: Core, Clinic, Notification)

Nếu bạn là thành viên nhóm bắt đầu nhận bàn giao Pha 2, hãy đọc theo thứ tự sau:

1. **Tổng quan kiến trúc 3 service**: [`kien-truc.md`](kien-truc.md) và [`docs/phase2-architecture/README.md`](docs/phase2-architecture/README.md) (sơ đồ C4, phân quyền DB, luồng sự kiện RabbitMQ, Redis rate-limit, S3/MinIO Claim Check và kịch bản demo 10 phút).
2. **Hướng dẫn tiếp nhận & chạy kiểm thử theo từng vai trò**: [`phase2-plan/RECEIVER-START.md`](phase2-plan/RECEIVER-START.md) và [`phase2-plan/HANDOFF.md`](phase2-plan/HANDOFF.md).
3. **Bảng phân công công việc sau mốc H**: [`phase2-plan/POST-H-TASKS.md`](phase2-plan/POST-H-TASKS.md) và [`phase2-plan/03-delivery-plan.md`](phase2-plan/03-delivery-plan.md):
   - **Thành viên Clinic**: phụ trách `services/clinic`, chạy `npm run phase2:test:clinic` (7 nhóm) và `npm run phase2:test:billing` (12 nhóm).
   - **Thành viên Notification & UI**: phụ trách `services/notification` và vùng UI liên quan, chạy `npm run phase2:test:notification-runtime` (8 nhóm), `npm run phase2:test:notification-ui` (9 nhóm) và `npm run phase2:test:e2e` (18 nhóm).
   - **Tích hợp Core**: phụ trách `backend`, `packages/*`, `deploy/*`, chạy `npm run phase2:test:resilience` (18 nhóm), `npm run phase2:test:migration` (11 nhóm) và `npm run arch:check`.
4. **Runbook chi tiết từng service trên stack thử độc lập**: [`deploy/phase2/README.md`](deploy/phase2/README.md) (cổng PostgreSQL `55432`, RabbitMQ `5679`, Redis `6389` tách biệt hoàn toàn với DB đang dùng).
5. **Chạy nhanh toàn bộ 3 service Pha 2 bằng Docker Compose** (sau khi đã tạo `.env.docker` ở Mục 3 bên dưới):

```powershell
node tools/docker/prepare-phase2.mjs .env.docker
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.phase2.yml config --quiet
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.phase2.yml up --build -d
docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.phase2.yml ps -a
```

---

## 1. Cần cài gì trước?

- Git để tải mã nguồn.
- Docker Desktop đang chạy với Linux containers và Docker Compose. Kiểm tra bằng `docker compose version`.
- Kết nối mạng trong lần đầu để tải npm packages và Docker images.
- Các cổng `5432` (PostgreSQL), `5000` (API), `5173` (frontend) còn trống.

Không cần cài Node.js/npm hoặc PostgreSQL trên Windows. Docker build backend/frontend và Nginx phục vụ giao diện đã build.

## 2. Lấy đúng nhánh

**Máy chưa có repo:**

```powershell
git clone -b refactor https://github.com/Nguyenquanghong/Pet-healthcare.git
cd Pet-healthcare
git branch --show-current
```

Lệnh cuối cần in `refactor`. **Máy đã có repo:** mở PowerShell tại thư mục gốc của repo rồi chạy:

```powershell
git fetch origin
git switch refactor
git pull --ff-only origin refactor
git branch --show-current
```

Nếu `git switch refactor` báo chưa có nhánh local, dùng `git switch --track origin/refactor`. Nếu `git pull --ff-only` báo có thay đổi cục bộ hoặc hai nhánh đã phân kỳ, kiểm tra `git status`; không dùng `git reset` để xóa phần việc của người khác.

## 3. Tạo file cấu hình riêng

```powershell
Copy-Item .env.docker.example .env.docker
```

File `.env.docker` ở **gốc repo**, cùng cấp `docker-compose.yml`, bị Git bỏ qua nên mỗi máy phải tự tạo. Nếu file đã tồn tại và đang dùng, không chạy lại `Copy-Item` để ghi đè. Frontend Docker luôn dùng URL `/api` cùng địa chỉ web; không cần `frontend/.env`.

Mở `.env.docker` bằng trình soạn thảo. Ba giá trị bắt buộc là:

```dotenv
POSTGRES_PASSWORD=<mat-khau-postgres-rieng>
DATABASE_URL=postgresql://nipopeto:<cung-mat-khau-postgres>@postgres:5432/nipopeto?schema=public
JWT_SECRET=<chuoi-ngau-nhien-it-nhat-32-ky-tu>
```

Hãy **thay toàn bộ phần trong dấu `<...>`**. Hai chỗ mật khẩu PostgreSQL phải giống nhau. Nên dùng chuỗi hex để mật khẩu không phải mã hóa ký tự đặc biệt trong URL. Có thể tạo hai chuỗi riêng bằng lệnh dưới đây, rồi sao chép kết quả tương ứng vào file:

```powershell
docker run --rm node:24-bookworm-slim node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
docker run --rm node:24-bookworm-slim node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Chuỗi thứ nhất dùng làm `POSTGRES_PASSWORD` và mật khẩu trong `DATABASE_URL`; chuỗi thứ hai dùng làm `JWT_SECRET`. **Không gửi hoặc commit file `.env.docker`**. Host `postgres` trong `DATABASE_URL` là tên service Compose; **không đổi thành `localhost`** khi backend chạy trong Docker.

Các giá trị còn lại trong `.env.docker.example` có thể giữ cho lần chạy demo: `PORT=5000`, `FRONTEND_PORT=5173`, `CORS_ORIGIN=http://localhost:5173`, `BANK_TRANSFER_DEMO=true`, `VNPAY_ENABLED=false`. Thông tin chuyển khoản demo chỉ để minh họa, không dùng để chuyển tiền thật. Mở giao diện bằng **`http://localhost:5173`**.

## 4. Chạy toàn bộ ứng dụng và kiểm tra database

Đảm bảo Docker Desktop đã chạy, sau đó tại thư mục gốc:

```powershell
docker compose --env-file .env.docker config --quiet
docker compose --env-file .env.docker up --build -d
docker compose --env-file .env.docker ps -a
Invoke-RestMethod http://localhost:5000/api/health
```

`config --quiet` chỉ kiểm tra cấu hình và không in secret ra màn hình. Compose khởi động PostgreSQL, chạy Prisma migration bằng service `migrate`, rồi khởi động API và frontend. Trong `ps -a`, `postgres` và `frontend` cần `healthy`, `migrate` có thể hiện `Exited (0)` vì đó là tác vụ chạy một lần, và `api` cần `running`. Health trả `status: ok` và `database: connected`.

Không cần chạy thêm `npm run db:deploy -w backend` trên Windows cho cách này: service `migrate` đã thực hiện bước đó **trong Docker**. Không cần tạo `backend/.env` nếu chỉ chạy backend bằng Compose.

## 5. Mở frontend

Mở `http://localhost:5173`. Frontend, API và database chạy nền trong Docker; không cần PowerShell thứ hai. Nginx chuyển tiếp `/api/` tới API qua mạng Compose. Trang tài liệu API ở `http://localhost:5000/api/docs/`, hoặc `http://localhost:5173/api/docs/` qua frontend.

API chỉ mở cổng host ở `127.0.0.1`; truy cập từ máy khác đi qua cổng frontend. Compose cho API tin một bước proxy và Nginx ghi lại các header proxy để giới hạn đăng nhập theo người dùng. Backend chạy trực tiếp mặc định không tin header proxy.

Đây là bản frontend đã build. Sau khi sửa source giao diện, chạy lại `docker compose --env-file .env.docker up --build -d` và tải lại trình duyệt. Nếu cần Vite tự cập nhật khi phát triển, vẫn có thể dùng cách chạy trực tiếp ở README gốc.

## 6. Tạo dữ liệu demo nếu database vừa tạo và có thể bỏ

Compose chỉ tạo cấu trúc bảng; **không tự tạo tài khoản**. Nếu đây là database demo **mới, trống, không chứa dữ liệu cần giữ**, chạy **một lần** từ thư mục gốc:

```powershell
docker compose --env-file .env.docker run --rm --no-deps migrate npm run db:seed --workspace @nipopeto/backend
docker compose --env-file .env.docker run --rm --no-deps -e API_BASE_URL=http://frontend:8080/api migrate npm run test:smoke --workspace @nipopeto/backend
```

Seed thêm tài khoản và dữ liệu minh họa. `test:smoke` kiểm tra health, đăng nhập demo, bootstrap và một trang thú cưng công khai. Tài khoản/mật khẩu demo được cố định trong `backend/prisma/seed.ts` và `backend/scripts/smoke-test.mjs`; chỉ dùng với database demo. Người dùng mới có thể tự đăng ký tài khoản chủ nuôi trên giao diện, nhưng tài khoản admin demo cần seed hoặc được tạo theo quy trình quản trị riêng.

**Không chạy seed trên database đang vận hành.** Khi dùng lại Docker volume cũ, dữ liệu và tài khoản cũ vẫn còn; không cần seed lại.

## 7. Cập nhật code và dừng hệ thống

Để lấy commit mới trên cùng nhánh:

```powershell
git switch refactor
git pull --ff-only origin refactor
docker compose --env-file .env.docker up --build -d
```

Compose tự cài dependency theo `package-lock.json` trong lúc build và áp dụng các migration mới qua service `migrate`. Sau khi cập nhật frontend, tải lại trình duyệt.

Khi ngừng sử dụng, chạy:

```powershell
docker compose --env-file .env.docker down
```

Lệnh `down` giữ nguyên Docker volume PostgreSQL, nên dữ liệu vẫn có khi chạy lại. Tránh dùng `down -v` nếu muốn giữ dữ liệu.

## 8. Nếu gặp lỗi

| Hiện tượng                                                                      | Kiểm tra và xử lý                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL` thiếu / Prisma `P1012` khi chạy `npm run db:deploy` trên Windows | Lệnh npm này đọc `backend/.env`, không đọc `.env.docker`. Với cách Docker, dùng `docker compose --env-file .env.docker up --build -d`.                                                                                                                       |
| Compose báo thiếu `POSTGRES_PASSWORD`, `DATABASE_URL` hoặc `JWT_SECRET`         | Điền đủ trong `.env.docker` ở gốc repo; chạy `docker compose --env-file .env.docker config --quiet`.                                                                                                                                                         |
| API không lên hoặc health trả `503`                                             | Xem `docker compose --env-file .env.docker ps -a` và `docker compose --env-file .env.docker logs --tail=100 postgres migrate api`. `migrate` phải hoàn tất trước `api`.                                                                                      |
| PostgreSQL báo sai mật khẩu sau khi đổi `.env.docker`                           | Docker volume cũ giữ mật khẩu khởi tạo ban đầu. Dùng lại mật khẩu cũ hoặc xử lý dữ liệu/volume theo kế hoạch sao lưu; chỉ sửa `.env.docker` không đổi mật khẩu trong PostgreSQL đã tạo.                                                                      |
| Cổng `5432`, `5000` hoặc `5173` đã được dùng                                    | Kiểm tra tiến trình đang dùng cổng. Cổng API dùng `PORT`, cổng frontend dùng `FRONTEND_PORT` trong `.env.docker`; nếu đổi địa chỉ frontend, cập nhật `CORS_ORIGIN` và `VNPAY_RETURN_URL` cho khớp. Cổng PostgreSQL được khai báo trong `docker-compose.yml`. |
| Giao diện mở được nhưng không gọi được API                                      | Kiểm tra `http://localhost:5173/api/health` và log `frontend api`. Frontend Docker dùng `/api`, không đọc `frontend/.env`; Nginx nhận `API_PORT` từ `PORT` của Compose.                                                                                      |
| Không đăng nhập được ở database mới                                             | Chạy seed **chỉ trên database demo trống**, hoặc đăng ký tài khoản chủ nuôi. Compose không tự seed.                                                                                                                                                          |
| Docker không kết nối được daemon                                                | Mở Docker Desktop, chờ Docker Engine khởi động hoàn toàn, rồi chạy lại Compose.                                                                                                                                                                              |

`npm test` chạy build, unit test, kiểm tra kiến trúc và OpenAPI; không yêu cầu database demo. Bộ kiểm thử tích hợp PostgreSQL dùng database `_test` riêng, không trỏ `PG_TEST_DATABASE_URL` vào database đang dùng để demo.

## 9. Cập nhật EC2 sau khi chỉnh sửa code

Sửa và kiểm thử code trên máy phát triển, commit các file cần chia sẻ rồi push lên `origin/refactor`. Trên EC2 đã được cấu hình sẵn để phục vụ frontend và API, vào thư mục repo và chạy:

```bash
git status --short
git switch refactor
git pull --ff-only origin refactor
docker compose --env-file .env.docker up --build -d
curl -f http://127.0.0.1:5000/api/health
```

Nếu `git status` thấy code đã sửa trực tiếp trên EC2, xử lý phần đó trước khi pull; không dùng `git reset` để xóa. `up --build -d` build lại backend/frontend, khởi động lại container cần thiết và service `migrate` áp dụng các migration còn thiếu. Kiểm thử migration trên môi trường riêng và sao lưu dữ liệu cần giữ trước khi cập nhật database. **Không chạy `db:seed` mỗi lần triển khai.** [Prisma `migrate deploy`](https://docs.prisma.io/docs/cli/migrate/deploy) áp dụng migration đang chờ, không reset dữ liệu.

Frontend Docker phục vụ tại cổng `FRONTEND_PORT` (mặc định 5173), dùng Nginx thay cho Vite dev server. Nếu EC2 đang có web server phục vụ trực tiếp `frontend/dist` của cách triển khai cũ, cần chuyển cấu hình web server sang proxy tới container frontend để nhận bản Docker mới; lệnh Compose không cập nhật thư mục `frontend/dist` trên host.

**Chỉ sửa code thì không cần sửa `.env.docker`.** Chỉ cập nhật cấu hình khi đổi domain, cổng, tài khoản nhận tiền hoặc secret. `.env.docker` được giữ riêng trên EC2, không đi theo `git pull`. Sau khi đổi cấu hình, chạy `docker compose --env-file .env.docker up -d` để Compose cập nhật các container bị ảnh hưởng. Frontend Docker luôn gọi `/api` và không dùng `frontend/.env`.
