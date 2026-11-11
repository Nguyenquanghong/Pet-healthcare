# Tiếp tục sửa và kiểm tải — 13/10/2026

Giữ working tree trước phiên. Không ghi DB đang dùng, không build Docker image/cài dependency/copy node_modules. Đọc lại yêu cầu: xác minh JWT cục bộ có giới hạn thu hồi; thu hồi tức thì toàn hệ thống được loại khỏi phạm vi chính ở tài liệu 06. Không thêm feature này để gọi audit hoàn tất.

## A05 — Core làm mất hướng dẫn chờ từ Notification

`backend/src/phase2/coreApp.ts` trước sửa chỉ chuyển status/body; mất `Retry-After` khi Notification trả 429/503. Regression HTTP thật qua hai server loopback tái hiện `null !== '7'`. Sửa bằng allowlist ba header `retry-after`, `x-service-degraded`, `x-service-instance`; instance thêm tiền tố `notification:` như quy ước Clinic. Không chuyển service credential/cookie hoặc header tùy ý.

Test giữ nguyên status/body cho 429/503/200/204, request actor/idempotency key và kiểm header nội bộ không rò rỉ theo cả hai chiều. Log trước sửa: `test-results/phase2/continuation-20261013-proxy-before.log` (exit 1 đúng assertion). Sau sửa nằm trong backend unit suite.

## A06 — Runner tải và đối soát có thể báo sai

- Retry-After: xử lý tên header không phân biệt hoa/thường, số giây/HTTP-date; NaN, âm, Infinity hoặc sai định dạng dùng fallback 1 giây. Chờ không vượt hạn đo; áp dụng cả 429 và 503. Không tính thời gian chờ vào latency HTTP hoặc biến rejection thành success.
- Hai test âm tái hiện lỗi: trả cùng ID cho hai request tạo độc lập vẫn PASS; response 500 có ID vẫn bị đếm vào created_ids. Đã sửa: chỉ response tạo hợp lệ mới vào danh sách thành công; ID trùng làm đối soát REVIEW_REQUIRED. Số hàng sau lỗi ghi không khớp vẫn cần điều tra, không retry khác key.
- `run_notebook_smoke.py` thêm tham số screening có giới hạn (1–60 giây, 1–10 VU, 1–2000 request/segment). Cập nhật notebook/hướng dẫn, giữ outputs rỗng và không chứa credential. Ghi rõ warmup/profile trước dùng cùng quota, không reset counter hoặc coi các profile là phép đo độc lập.

## Kiểm đã chạy trong phiên

| Kiểm                                                     | Kết quả                                 | Artifact trong `test-results/phase2/`                                            |
| -------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| TypeScript Core `tsc -p backend/tsconfig.json`           | exit 0                                  | Output lệnh; không generate/install lại                                          |
| Backend unit                                             | **83/83**, exit 0                       | `continuation-20261013-unit.log`                                                 |
| Notification runtime, DB/broker thật                     | **8/8**, exit 0                         | `continuation-20261013-notification-runtime.log`                                 |
| Negative reconciliation trước sửa                        | 2 lỗi assertion đúng như dự kiến        | `continuation-20261013-reconcile-before.log`                                     |
| Unit runner sau sửa                                      | **11/11**                               | `continuation-20261013-runner-unit.log`; chạy lại sau cập nhật notebook cũng đạt |
| Tất cả code cell notebook, 2 VU, 1s warmup + 30s/profile | 4 profile PASS kiểm trong scope, exit 0 | `continuation-20261013-notebook.log`                                             |
| Notebook sau siết đối soát, 2 VU, 1s warmup + 5s/profile | 4 profile PASS, exit 0                  | `continuation-20261013-notebook-final.log`                                       |

Không chạy lại toàn bộ 73 integration/18 E2E trong phiên này: kết quả đó thuộc lượt sửa trước, đã xác nhận từ log. File STATUS/evidence trước đó còn dòng chờ do cập nhật cuối phiên chưa được ghi đúng; đã sửa theo bằng chứng, không chạy lại để tạo số PASS mới.

## Screening 30 giây (trước siết đối soát, dữ liệu thực không gặp hai trường hợp lỗi trên)

| Profile      | HTTP hoàn tất | Thành công | 429 | 503 | p95 thành công lớn nhất theo operation (ms) |
| ------------ | ------------: | ---------: | --: | --: | ------------------------------------------: |
| read         |           447 |        447 |   0 |   0 |                                       64,54 |
| clinic_write |           110 |        108 |   2 |   0 |                                       71,19 |
| mixed        |            31 |         29 |   2 |   0 |                                       80,12 |
| login_policy |            21 |         19 |   2 |   0 |                                      121,49 |

Write: before 12 → after 120, đúng 108 success; mixed: 120 → 122, đúng 2 success. Không thiếu ID hoặc trùng slot đang hiệu lực. Mixed chịu quota write từ profile trước; không dùng throughput này so sánh capacity giữa workload. `unexpected_error_rate=0`, metrics cả ba API được lấy thành công. Đây là p95 theo operation, không phải p95 gộp hoặc SLA đã nghiệm thu.

Run IDs theo thứ tự bảng: `a16ffd3a-4f80-4efb-bc7c-0dc0515e2160`, `6c9f1e25-ecad-4a27-9227-1a3e9839ea0d`, `8a7af78a-6ac0-4798-ad74-738c688fa920`, `f82e45bc-0892-4341-92a7-05f2f7e301e6`. Mỗi thư mục `load-result-<id>` giữ requests.csv/summary.json/metrics.json.

Lượt 5 giây cuối: lần lượt 74/64/73/21 request; read/write/mixed không lỗi ngoài dự kiến, login 19 success + 2 quota rejection. Write/mixed đối soát đạt bằng logic đã sửa; metrics không scrape lỗi. Run IDs: `a20d89f0-232e-42e8-b7de-8d24b9c1e1ec`, `6add1542-d74a-4f4c-b186-252781e1487a`, `dd43e60b-76a8-4769-af9d-9a496ff552eb`, `5beea5fe-0abe-4e2b-be91-a8ee24209755`.

Tất cả vẫn **SCREENING, capacity_accepted=false**: một Clinic, Node proxy, chung owner/IP, dataset nhỏ, chưa B0–B3/arrival-rate/tải nền hotel/billing. Không giảm quota hoặc ngưỡng NFR để nhận PASS. Lượt này không tái hiện native Windows process-loss, chưa có bằng chứng nguyên nhân đã sửa. Bước tiếp theo là chuẩn bị dữ liệu/tải đa tài khoản và topology benchmark phù hợp trước đo P8; triển khai dữ liệu thật vẫn cần cutover riêng.

Kết thúc: ba container thử đều stop/exit 0, không còn container chạy; hai queue lịch sử vẫn mỗi queue một message ready, chưa ACK. Volumes giữ nguyên. Boundaries, Notification writer guard và `git diff --check` đạt.
