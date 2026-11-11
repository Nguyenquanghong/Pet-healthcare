# Docker build và vùng lưu dữ liệu — 13/10/2026

Repo trên nhánh `phase2/service-split-checkpoint-20261012`, HEAD trước sửa
`41d8a72ea69f342e278d357be27b10130e07c954`. Không chạy `compose up`, migration,
seed, prune image/cache/volume hoặc thay database trong lượt chẩn đoán này.

## Chẩn đoán từ log và môi trường thật

- Log người dùng: frontend fail ở Vite/PostCSS, `Cannot find module 'braces'`.
- `package-lock.json` trỏ `node_modules/braces` tới `tools/vendor/braces` bằng
  link. Dockerfile frontend chưa COPY thư mục vendor trước `npm ci`, nên consumer
  micromatch/Tailwind không có target của link trong container.
- Dockerfile backend còn thiếu manifest/source/dist của contracts, messaging,
  runtime, và helper copy generated Core client. Source pha 2 có dependency thật
  vào ba package này; không thể chỉ build/copy backend như trước.
- Docker Desktop managed disk: `C:\Users\<user>\AppData\Local\Docker\wsl\disk\docker_data.vhdx`,
  file khoảng 5,30 GB lúc khảo sát. Chuyển Documents sang D không chuyển AppData.
- Docker báo 787,1 MB build cache, 748,6 MB images, 643,6 MB volumes; ba container
  thử đang dừng và không có container chạy. Chưa có baseline disk ngay trước build
  nên không quy toàn bộ 2 GB chênh lệch người dùng thấy cho một cache cụ thể.
- Chỗ trống thực tế qua DriveInfo: C khoảng 91,99 GB, D khoảng 127,44 GB. Kết quả
  Get-PSDrive trong sandbox trả 0 không được dùng để kết luận ổ đĩa đầy.

## Sửa source

- Frontend COPY đủ workspace manifests và local braces trước install; giữ
  install riêng frontend, giữ pricing source và build production như trước.
- Backend dùng một base cài OpenSSL/CA dùng chung; build contracts/messaging/
  runtime trước backend, COPY helper Core client; tách production prune khỏi
  target build để target migrate còn Prisma CLI. Runtime giữ các workspace dist,
  package manifests, production dependencies và generated Prisma client.
- Runtime container đặt `HOST=0.0.0.0` để API nghe được qua port mapping; port trên
  host trong Compose vẫn bind loopback như cấu hình hiện có.
- Docker context loại generated clients, các bản thử, tài liệu, benchmark,
  credential/env và archive/dump/log, tránh gửi lại Windows engines và evidence.
  Loại thêm `backend/target/pet-healthcare-api-2.0.0.jar` cũ, 34,17 MB. Không
  chạy Spring hay xóa artifact tham khảo của người dùng.
- Không thêm service/framework hay đổi compose topology/database volumes.

## Kiểm và chuyển storage

- BuildKit `--check` cho cả hai Dockerfile: exit 0, no warnings. Kiểm này không
  chạy RUN/npm ci và không chứng minh build image cuối cùng đã thành công.
- Frontend build host trên D exit 0; dependency guard 2/2 PASS. Kết quả/log trong
  `test-results/phase2/docker-fix-host-frontend.log`.
- Người dùng chọn chuyển Docker data sang D trước khi chạy build thật.
  Đã tạo thư mục trống `D:\DockerDesktop`; không di chuyển thủ công VHD hay sửa
  JSON settings. Windows chặn điều khiển foreground và UI Automation không có
  controls, nên người dùng đã chọn Disk image location trong Docker Desktop và
  xác nhận Apply & Restart. Hai VHD thực tế ở `D:\DockerDesktop\DockerDesktopWSL`,
  file data VHD cũ trên C không còn. Inventory IDs của cả 3 image/3 volume/3
  container trước chuyển đều khớp sau chuyển.
- Chạy build-only ba image: frontend/api/migrate đều thành công. Smoke đầu có
  assertion sai rằng TypeScript phải vắng trong production; `npm explain` xác
  nhận TypeScript là optional peer của Prisma/Prisma Client. Sửa assertion rồi
  phát hiện Playwright dev dependency vẫn có, vì prune chỉ chọn workspaces mà
  không chọn root. Đã sửa `--include-workspace-root` và build lại API từ cache.
- Sau loại JAR cũ khỏi context, final build cả ba image exit 0. Final smoke cả ba
  exit 0: API import 3 shared packages, 2 Prisma clients và Core app factory;
  Playwright absent; `HOST=0.0.0.0`; Nginx template render và `nginx -t` PASS;
  migration image có Prisma CLI/lock, không invoke migrate hay connect DB.
- Smoke dùng `--network none`, `--rm`, không mount DB volume; API chỉ import
  factory, không chạy index/server. Migrate chỉ kiểm tồn tại artifact. Không
  chạy `compose up`, DB integration, real E2E hoặc remote CI.
- Final disk: D data VHD khoảng 8,616 GB; C free khoảng 97,16 GB, D free 118,72 GB.
  Docker báo build cache 3,036 GB, volumes vẫn 643,6 MB. Sau smoke còn đúng 3
  volume/container cũ, không có container chạy. File VHD thực tế ở D đã xác minh;
  Docker vẫn có executable/config/log nhỏ trong AppData/Program Files trên C.
- Không xóa cache/dữ liệu hoặc tự thu gọn VHD. Lượt dọn trước chỉ xóa bốn bản
  cài thử của repo, không bao gồm Docker data trong AppData.

Dockerfile.frontend được sửa có chủ đích để khắc phục lỗi hiện tại. SHA256 byte
hiện tại sẽ khác snapshot Original18; bản gốc và thay đổi có sẵn vẫn có trong
commit 41d8a72. Không sửa hash lịch sử để làm verifier báo PASS giả.
Kiểm riêng sau sửa: 17 original files vẫn khớp; Dockerfile.frontend thay đổi có
chủ đích, bytes cũ trong gói H vẫn khớp hash Original18. Source/image hashes và
phạm vi kiểm được ghi trong [report máy đọc](docker-image-check.json).

Log local giữ nguyên các lượt fail/pass: `docker-runtime-smoke-first.log`,
`docker-runtime-smoke-second.log`, `docker-fixed-build.log`,
`docker-api-prune-fixed-build.log`, `docker-final-build.log`,
`docker-runtime-smoke-final.log` dưới `test-results/phase2`.

Commit source fix/report: `18c1788320504df10256c9bf02cecddd36515ef4`, 4 file trên
nhánh checkpoint hiện tại. Hook chạy bình thường; main giữ `add596e`; chưa push.
Các file Markdown này vẫn local theo hook, không suy ra đã có trong Git commit.

Nguồn chính thức: [vị trí Docker WSL data và đổi trong Settings](https://docs.docker.com/desktop/features/wsl/),
[build cache được quản lý theo chính sách GC](https://docs.docker.com/build/cache/garbage-collection/).
