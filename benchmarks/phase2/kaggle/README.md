# Notebook pha 2 chạy toàn bộ stack trong Kaggle

**Đối chứng bài tải PCN pha 1:** dùng
[phase2-pcn-kaggle.ipynb](../phase2-pcn-kaggle.ipynb), 100 users/30 phút,
PCN01–PCN02, một Clinic mặc định. Helper được nhúng trong notebook, application
pin commit `5881154`; upload và Run All, không cần push trước.
[Phạm vi, cách đọc kết quả và kiểm thử](pcn-comparison.md).

Mở [phase2-kaggle.ipynb](../phase2-kaggle.ipynb). Đây là notebook mới cho ba
service; giữ nguyên notebook cũ trong `benchmarks/kaggle/` và notebook local.

## Clone Git trong Kaggle — mặc định

Import [phase2-kaggle.ipynb](../phase2-kaggle.ipynb), chọn CPU/Internet On rồi
**Run All**. Giá trị Git và `MODE='auto'` đã đặt sẵn, không cần sửa cell.
Cell đầu mặc định `SOURCE_MODE='git'`, URL repo
`https://github.com/Nguyenquanghong/Pet-healthcare.git` và nhánh
`phase2/service-split-checkpoint-20261012`. Đặt `GIT_REF` là nhánh hoặc SHA đã push
có các file Kaggle mới; có thể pin `EXPECTED_COMMIT` bằng full SHA.

Notebook tự clone/fetch/checkout trong `/tmp`, ghi commit thật và hash các file
tracked vào report, rồi cài dependency/build/start stack. Không cần Dataset source.
Nếu repo private, đặt `PRIVATE_REPO=True` và thêm Kaggle Secret `PET_GITHUB_TOKEN`
quyền đọc repo. Token dùng askpass riêng, không nằm URL, command args hoặc output.

Notebook kiểm ref có workflow mới trước apt/build. Report ghi commit thực sự đã
clone; không dùng HEAD ở máy người gửi để giả làm provenance của Kaggle.

## Snapshot archive — tùy chọn

Đổi `SOURCE_MODE='archive'` nếu cần chạy snapshot local chưa có trên Git.

Tại root repo, sau khi lưu source hiện tại:

```powershell
npm run phase2:handoff:package
```

Lệnh in đường dẫn `test-results/phase2/handoff-<UUID>/`. Lấy đúng hai file
`pet-healthcare-phase2-source.tgz` và `receipt.json` cùng thư mục, tạo Kaggle
Dataset **private**, rồi Add Input vào notebook. Gói phải chứa thư mục này.
Import riêng file `.ipynb` vào Kaggle. Chọn Python/CPU/Internet On. Notebook
tự xác minh hash, cài Node 24.16.0/PostgreSQL/RabbitMQ/Redis/Nginx và `npm ci`
trong phiên Kaggle, sau đó build ba service. Không cần Docker hay server public.

Nếu có nhiều receipt trong Input, đặt `RECEIPT_PATH` chính xác. Không dùng gói H
ngày 12/10 hoặc gói trước khi bổ sung Kaggle; notebook từ chối source thiếu module.
Gói source không chứa `.env`, credential, DB, node_modules hay generated clients.

## Chạy và đọc kết quả

Mặc định tự thực hiện:

1. Smoke mixed/8 owner, 1 và 2 Clinic, 2s warmup +5s steady. Kiểm generator,
   contract/scope, telemetry, đối soát và cleanup. Smoke chưa đạt → dừng tăng tải.
2. Nếu Smoke đạt: 18 lượt đo sâu với 40 owner, read20/mixed30/clinic-write10 RPS,
   1/2 Clinic, 120s warmup +300s steady ×3 cho mỗi cấu hình. Cần ít nhất **2,1 giờ**
   warmup/steady, cộng setup/migration và fault probes.
3. Healthy billing/replay/INVOICED, notification khỏe, consumer outage60s/30event,
   rồi login-policy8owner/10RPS/30s để quan sát quota; không tắt bảo vệ.
4. Bảng/chart và ZIP download. Khi một case lỗi, giữ summary và xuất report lỗi;
   không retry tự động. `COMPLETE` không có nghĩa mọi NFR đạt.

Tùy chọn `MODE='smoke'` chỉ kiểm setup nhanh. `MODE='stress'` bổ sung mixed20/40/80
RPS (10s warmup/60s steady), ghi SCREENING. `mixed` là 80% read/20% create, chưa
đủ hành trình10/20/70. Fault probes ít mẫu chưa đủ nghiệm thu full NFR02/03/07.

Mỗi case tạo mới PG cluster/ba DB và role, kiểm data directory + marker trước
migrate; marker nằm schema riêng để public còn trống cho Prisma migrate lần đầu.
Kiểm sáu CONNECT chéo bị từ chối. Schema/runtime dùng role owner trong môi trường
benchmark, không thay thế least privilege rehearsal P7. Native services chỉ bind
loopback. Nginx chặn internal/metrics ở cổng gateway, Clinic có private upstream.

DB, RSA/token, fixture và runtime logs nằm `/tmp`, không `/kaggle/working`.
Không in context/fixture ra cell; không thêm các file đó vào output. Cleanup dừng
đúng process đã tạo, giữ dữ liệu riêng để điều tra tới hết phiên; không seed/reset
DB có sẵn, không kill theo tên process. Quota không reset giữa warmup/steady.

## Cách đánh giá và giới hạn

[NFR định lượng](../../../phase2-plan/07-benchmark-protocol.md) và
[acceptance.json](acceptance.json) là tiêu chí trước đo. Scheduler open-loop giới
hạn in-flight, ghi drop khi không phát kịp; không đổi thành closed-loop. Client
tôn trọng Retry-After theo actor/nhóm API, ghi client_backoff vào mẫu số scheduled.
Mỗi request có TCP mới; latency loopback gồm connection overhead, chưa TLS/Internet.

`COMPLETE` khác PASS. Mỗi operation/lượt cần ≥1.000 success, mỗi cấu hình ≥3 lượt,
đủ warmup/steady; không gộp để che một lượt lỗi. Matrix luôn
`capacity_accepted=false`: chưa B0, CPU/RAM quota B2/B3, pool tổng cố định,
workload đăng ký/journey, hotel interference hoặc DB pool histograms. Runtime
metrics có lock-wait gauge/outbox/queue gauge; không phải histogram toàn bộ lock/
pool wait và không cho biết mọi unacked. Hai Clinic tăng pool từ 4 lên 8, phải
báo rõ; không gọi đây là B2 cùng ngân sách. Generator/DB/broker dùng chung host.

Sau benchmark có ghi, đối soát toàn bộ appointment trong DB thử: thiếu ID success,
ID trả trùng, active slot trùng hoặc write đã commit mà không có success response
→ REVIEW_REQUIRED; không tự retry key khác. Fault billing đo tới terminal, đối
chiếu invoice với INVOICED reservation; HTTP 202 riêng không là hoàn thành.

## Kiểm công cụ tại local

```powershell
python benchmarks/phase2/kaggle/make_notebook.py
python -m unittest discover -s benchmarks/phase2/kaggle -p test_benchmark.py -v
node --check benchmarks/phase2/kaggle/stack.mjs
```

Các test này kiểm scheduler/đánh giá/đối soát/contract và notebook; không chứng minh
apt/native stack chạy thành công trên Kaggle. Trạng thái chạy thật xem STATUS và
evidence, không suy kết quả từ việc notebook hợp lệ cú pháp.

Nguồn nền tảng: [Kaggle Notebooks](https://www.kaggle.com/docs/notebooks),
[RabbitMQ configuration](https://www.rabbitmq.com/docs/configure),
[RabbitMQ Erlang cookie](https://www.rabbitmq.com/docs/clustering).
