# Rà soát và kiểm thử tải pha 2

**Chấm hiệu quả CQRS Q6:** dùng [cqrs_evaluate.py](kaggle/cqrs_evaluate.py) với ZIP kết quả và source bundle tương ứng. Tình huống, lệnh chạy và số liệu v9 (q6-effectiveness-20261020, ghi chú nội bộ, không có trong repo) phân biệt primary list, tìm kiếm/lọc, calendar, owner và overhead ghi. Bộ chấm không dùng smoke thay full hoặc đổi endpoint chính để đạt mục tiêu. ZIP v9 hiện tại chỉ smoke: **chưa chứng minh cải thiện đáng kể**. Full dùng [notebook v9](cqrs-q6-oab-v9.ipynb), `RUN_FULL=True`; evaluator không yêu cầu tạo notebook mới.

**Chạy toàn bộ stack trên Kaggle:** dùng [phase2-kaggle.ipynb](phase2-kaggle.ipynb)
và [hướng dẫn input/Smoke/Deep](kaggle/README.md). Notebook này dựng native
PostgreSQL/RabbitMQ/Redis/Nginx/ba service trong phiên Kaggle, có open-loop,
đối soát và fault probe. Notebook local dưới đây vẫn được giữ riêng.

Mở [phase2-load.ipynb](phase2-load.ipynb) bằng Jupyter hoặc VS Code Notebook, kernel Python 3.10+. Runner dùng Python standard library; biểu đồ matplotlib là tùy chọn. Notebook không lưu output, password hoặc token.

Tại root repo, khởi động Docker Desktop rồi chuẩn bị:

Windows Node 24.15.0 đã tái hiện native crash trong lượt 8 VU. Node upstream xác nhận
[lỗi TCP đã được sửa trong 24.16.0](https://github.com/nodejs/node/issues/63620).
Để kiểm bằng runtime portable đã pin (không thay bản cài hệ thống):

```powershell
powershell -NoProfile -File tools/phase2/prepare-node-windows.ps1
$env:PATH = (Resolve-Path 'test-results/phase2/tooling/node-v24.16.0-win-x64').Path + ';' + $env:PATH
node --version
```

PATH trên chỉ có hiệu lực trong terminal này; mở notebook/kernel từ terminal đó.
Giữ log của lượt lỗi, không bật restart/retry tự động để che mất native crash.

```powershell
npm run phase2:up
npm run phase2:build
npm run build --workspace frontend
```

Chạy các cell theo thứ tự. Mặc định: 8 tài khoản tổng hợp, 2 VU, warmup 2 giây, steady 10 giây, 1 repeat, chỉ đọc. `ACCOUNTS=1` giữ fixture nhỏ cũ; 2–40 tạo dữ liệu riêng từng owner. `PROFILES` hỗ trợ `read`, `clinic_write`, `mixed` (80% đọc/20% tạo lịch) và `login_policy`. Các profile ghi yêu cầu `ALLOW_WRITES=True` và chỉ chạy trên fixture tổng hợp do runner tự khởi tạo.

Fixture 8 owner có 168 pet, 960 lịch sử appointment, 240 bệnh án, 240 hotel booking và 240 hóa đơn chưa thanh toán. Dữ liệu chỉ tổng hợp, không đại diện quy mô production. Mỗi VU dùng một owner; trả danh sách rỗng ở các domain đã nạp dữ liệu, lộ owner khác hoặc internalNote đều bị tính lỗi contract. Đối soát sau ghi cộng đúng các danh sách được phân quyền của từng owner. Notification owner có thể rỗng; số đo không bao gồm thanh toán thật.

Runner dùng hạ tầng Docker `pet-phase2-p1-test` (55432/5679/6389), ba API thật và worker từ harness E2E có sẵn. Kiểm project/DB/role/marker trước ghi, không đọc `.env.docker`, không dùng admin của DB đang hoạt động. Cổng 5189 phải trống. Không chạy đồng thời với E2E/phase2:verify/notebook khác. Giữ dữ liệu và volumes; không cài dependency, build Docker hoặc tạo bản sao node_modules.

Artifact ở `test-results/phase2/load-result-<uuid>/`:

- `requests.csv`: operation, status, outcome, latency, thời điểm tương đối và worker; không có request/response body hoặc token.
- `summary.json`: p50/p95/p99, RPS thành công, tỷ lệ 429/503/lỗi, cấu hình, fingerprint, giới hạn phép đo và đối soát lịch tạo thành công.
- `metrics.json`: CPU-seconds, RSS, event-loop, backlog/queue và các metric API đang cung cấp; lưu cả scrape lỗi.

Fixture file chứa credential tổng hợp và metrics token nằm riêng trong thư mục ignored. Không chia sẻ fixture hoặc log thô. Một run đủ thời lượng vẫn chỉ `MEASURED_SCOPE_ONLY`; runner không tự chứng nhận capacity. Giới hạn: một Clinic, Node test proxy, chung IP, dữ liệu nhỏ, chưa B0/B2/B3 hay billing terminal latency/notification lag. Không suy throughput từ 429/503 trả nhanh. Sau write load, đọc lại các trang appointment để đối chiếu ID đã trả về, số hàng và slot đang hiệu lực; kết quả không xác định phải điều tra, không tự retry khác key.

Các kiểm tra công cụ:

```powershell
python -m unittest discover -s benchmarks/phase2 -p test_load_runner.py -v
python benchmarks/phase2/load_runner.py
python benchmarks/phase2/run_notebook_smoke.py
# Screening nhiều owner; vẫn giữ limiter và dùng chung IP giữa profile:
python benchmarks/phase2/run_notebook_smoke.py --accounts 8 --steady-seconds 30 --users 8 --max-requests 2000
```

Lệnh `load_runner.py` chạy smoke đọc; `run_notebook_smoke.py` thực thi tất cả code cell với bốn profile, mặc định 2 VU/5 giây. CLI giới hạn tối đa 10 VU, 60 giây, 2000 request mỗi segment; đây vẫn là screening. API/worker được dừng sau lượt chạy. Warmup và các profile trước tiêu thụ quota chung, không so RPS giữa profile như các phép đo độc lập.

Runner tôn trọng Retry-After cho 429/503 (cả số giây và HTTP-date); header lỗi dùng chờ 1 giây, luôn giới hạn theo thời gian còn lại. Đối soát ghi đánh REVIEW_REQUIRED nếu ID phản hồi trùng hoặc số hàng khác số response tạo thành công; ID trong response lỗi không được tính là thành công.

Để tái hiện **cấu hình trước bản sửa A01** trên DB thử riêng (không đại diện Compose hiện tại):

```powershell
node --import tsx benchmarks/phase2/audit_local_mode.mjs
```

Đây là công cụ chẩn đoán: exit 0 nghĩa là đã ghi kết quả, không có nghĩa ứng dụng không lỗi. Không sửa code ứng dụng, cấu hình đang dùng hoặc tài liệu yêu cầu.

Nếu không còn suite nào dùng hạ tầng thử:

```powershell
docker compose -f deploy/phase2/compose.test.yml stop
```
