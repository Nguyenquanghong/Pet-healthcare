# Đo tải pha 2 theo PCN pha 1

Upload [phase2-pcn-kaggle.ipynb](../phase2-pcn-kaggle.ipynb) vào Kaggle, chọn
CPU / Internet On và Run All. Không cần Docker, Dataset, sửa cấu hình hoặc push
repo trước. Sau setup có khoảng 31 phút tải; ZIP hiện ở cell cuối và Output.

Notebook clone application tại commit
`58811549225692ec7e765031151ca5f47aed4b56`, cùng mốc bộ kết quả Deep đã gửi ngày
14/10. Helper benchmark mới được nhúng trực tiếp dưới dạng source trong notebook,
kiểm SHA256 rồi ghi vào bản clone `/tmp` sau build. `environment.json` phân biệt
hash source gốc, commit ứng dụng và overlay. Các sửa booking/Admin chưa commit
ở local không thuộc ứng dụng được đo này. Không tự commit/push.

## Cái gì giống pha 1

- Tái sử dụng trực tiếp `benchmarks/kaggle/pcn_locustfile.py` và
  `pcn_contract.py`, giữ nguyên task, weight, URL, body, random seed và policy.
- 100 owner/user ảo, spawn 10/s; sau đủ người dùng warmup 30 giây rồi đo
  1.800 giây. Wait 0,5–1,5 giây; timeout HTTP 10 giây; drain 12 giây.
- Mỗi owner một pet bật QR, một appointment, medical record, hotel booking,
  invoice có một item và notification. Các hàng phân về DB tương ứng.
- GET pets:4, appointments:2, medical theo pet:2, hotel:1, invoices:1,
  notifications:1; POST appointment:2, rescue report:1. Tổng weight 14.
- PCN01: từng operation p95 ≤2.000ms và ≥95% request thành công trong 2s.
  PCN02: error rate ≤1%. Phải đủ 100 users toàn bộ 30 phút, có mọi operation
  bắt buộc và đã ghi đủ response cho request bắt đầu trong cửa sổ đo.
- Không bỏ 429/503, không retry/backoff và không sửa limiter. Mọi traffic chung
  IP loopback như bài cũ; có thể gặp quota chung IP trước giới hạn CPU.

## Khác biệt bắt buộc và giới hạn

Pha 2 cần `Idempotency-Key` khi tạo lịch; GET pets trả được envelope `items`
phân trang. Adapter chỉ xử lý hai khác biệt contract này, vẫn kiểm pet của owner
và lịch tạo đúng pet, bổ sung kiểm ID để đối soát. Token RS256 được lấy qua login
trong setup, ngoài mẫu đo; pha 1 cấp sẵn token. Không reset quota sau setup.

Đây là so sánh cùng nghiệp vụ và cách tạo tải, không phải response byte giống hệt:
phân trang có thể giảm lượng dữ liệu mỗi lần đọc so với pha 1. Service/database,
worker/broker và chi phí truyền nội bộ khác. Kaggle cùng máy với generator,
chưa cưỡng chế tổng quota CPU/RAM bằng pha 1. Kết quả một/hai Clinic không tự
chứng minh scale-out có lợi.

**Chỉ PCN01–PCN02.** PCN03–PCN07 (security, UI/booking steps, browser,
restart, backup) ghi NOT_RUN. `overall=PARTIAL` dù tải đạt; `capacity_accepted`
luôn false. Mặc định `MODE='full'`, `CLINIC_REPLICAS=1`. `MODE='smoke'` chỉ
2 users/15 giây, không đủ điều kiện PASS PCN. Không thay notebook tải sâu cũ.

## Bằng chứng xuất ra

- `load-final.json`, `requests.jsonl`: nguyên bộ số đo pha 1, percentile tính
  trên mọi response; tỷ lệ thành công trong 2s xét cả lỗi.
- `http.csv`, `http-summary.json`: status/latency/outcome, bao gồm 429/503.
- `generator.json`: số exception của user ảo. Locust exit 1 do vài HTTP lỗi
  không tự làm FAIL nếu PCN vẫn đạt; lỗi generator/runtime không được che đi.
- `reconciliation.json`: đối soát appointment (cả ramp/warmup), không mất/trùng
  ID hay slot hiệu lực, không có commit ngoài phản hồi thành công; không suy
  đối soát toàn bộ rescue/hotel/invoice từ bài này.
- `resources.jsonl`: CPU/RSS từng API, worker, PostgreSQL, RabbitMQ, Redis,
  Nginx, generator. CPU dùng delta theo PID + creation time; tiến trình rất ngắn
  giữa hai sample có thể bị bỏ; RSS cộng có thể đếm trùng shared pages.
- `manifest.json`, `pcn-report.json`, environment và chart. ZIP dùng allowlist,
  không có token, fixture, database, runtime log hoặc source clone.

## Kiểm thử và tái tạo

```powershell
python benchmarks/phase2/kaggle/make_pcn_notebook.py
python -m unittest discover -s benchmarks/phase2/kaggle -p "test_*.py" -v
python -m unittest discover -s benchmarks/kaggle -p test_pcn.py -v
node --test --test-isolation=none benchmarks/phase2/kaggle/pcn_dataset.test.mjs
```

HTTP integration test cần `locust==2.44.4`, `psutil==7.0.0` trong môi trường
Python thử riêng. Test tự ghi SKIP nếu thiếu Locust; không tính SKIP là đã chạy.
Notebook generator đóng gói helper hiện tại; sau sửa helper cần tái tạo notebook.

Đã chạy ngày 14/10/2026: **22/22 Python pha 2 (không skip)**, **10/10 PCN
legacy**, **2/2 Node fixture**, syntax Node và compile mọi cell đạt. HTTP test
chạy Locust thật trên server loopback giả lập với success và toàn 429, xác minh
raw/summary đếm khớp và không xuất token. Đây không phải benchmark application.
Docker daemon local không chạy; chưa chạy native stack 100 owner hoặc 30 phút
trên Kaggle. Bước tiếp theo: Run All notebook mới và đọc ZIP trước so pha 1.
