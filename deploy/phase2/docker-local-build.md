# Build Docker từ repo trên D

Di chuyển repo và di chuyển Docker disk là hai việc riêng. Docker Desktop WSL
thường lưu image, volumes và build cache trong AppData trên C.

Trước khi build tiếp, mở Docker Desktop → Settings → Resources → Advanced →
Disk image location, chọn `D:\DockerDesktop`, Apply & Restart. Nếu có lựa chọn
thì giữ/chuyển dữ liệu hiện có. Chỉ đổi vị trí, không reset hoặc purge data.

Sau khi engine sẵn sàng, kiểm inventory và chỉ build:

```powershell
docker system df
node tools/docker/prepare-notifications.mjs
docker compose --env-file .\.env.docker build
```

`build` không chạy migration. `up` của compose này sẽ chạy service migrate và
đưa app lên database được chỉ định trong env; phải xác minh môi trường/dữ liệu
trước bước đó. Bản sửa A01 nối Notification và DB/broker/worker riêng vào root
Compose; Clinic vẫn trong Core ở chế độ local chuyển tiếp, không phải deployment
ba service pha 2 đã qua tiếp nhận độc lập. Công cụ prepare giữ credentials DB cũ
và không xoay khóa khi chạy lại; cần đăng nhập lại sau khi đổi JWT sang RSA.
Nếu còn notification legacy, API local chặn để chờ chuyển dữ liệu có đối soát;
không seed/reset/xóa bảng để vượt chặn. Xem [bản sửa và kiểm thử](../../phase2-plan/evidence/fixes-20261013.md).

Dockerfile frontend cần local patched braces trong build context; backend cần
build shared packages và mang workspace dist vào runtime. `.dockerignore` loại
node_modules, build/generated outputs, env thật và artifacts thử trên host.

Đổi Disk image location qua Docker Desktop theo [hướng dẫn Docker](https://docs.docker.com/desktop/features/wsl/).
Không tự move/delete file VHD khi Docker đang chạy. Xóa build cache bên trong VM
cũng không bảo đảm file VHD trên Windows sẽ co ngay về kích thước trước đó.
