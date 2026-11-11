# Kaggle Run All / native Linux proof / commit — 14/10/2026

Người dùng yêu cầu tự commit và chỉnh để chỉ import notebook lên Kaggle rồi chạy.
Branch `phase2/service-split-checkpoint-20261012`, parent `fa428b3`;.

## Hành vi và commit

Notebook mặc định MODE=auto, Git URL/ref đã đặt sẵn. Anonymous `git ls-remote` đọc
được nhánh public, không cần token. Quy trình tự động Smoke mixed1/2Clinic trước,
rồi18lượt measured (3profile ×2topology ×3repeat), warmup120s/steady300s. Rate
read20/mixed30/write10RPS nằm dưới write-IP quota cho case phù hợp. Fault probe và
login-policy riêng; graph/CSV/JSON/ZIP vẫn xuất khi một case lỗi. Failed smoke,
generator/reconciliation hoặc fault probe dừng quy trình, không retry để PASS.

Commit `58811549225692ec7e765031151ca5f47aed4b56`:
`feat(benchmarks): automate Kaggle phase2 load testing`, đúng8file code/notebook/
policy JSON. Không lấy README backend/frontend có sẵn; đối chiếu SHA256 trước/sau
đều khớp. Không bypass hook `.git/hooks/pre-commit`: hook cấm Markdown; tài liệu
thiết kế/evidence/README hướng dẫn vẫn giữ local, policy máy đọc có trong commit.

Lệnh push ban đầu **bị automatic approval review từ chối** vì cần xác nhận rõ
payload/đích của remote write. Người dùng sau đó đã trả lời: “Cho phép push đúng
commit và nhánh trên”. Đã xác minh HEAD/origin và push chính xác SHA5881154 lên
`refs/heads/phase2/service-split-checkpoint-20261012`, exit0, không force/main.
Không đổi API hay remote để lách review; thao tác được thực hiện sau xác nhận.

Đã kiểm anonymous `ls-remote` trả đúng full SHA, tải notebook/workflow từ raw
GitHub tại commit và đối chiếu byte với Git object. Mọi code cell compile,
outputs rỗng, MODE=auto. Notebook SHA256
`bd8960a18179b4bc639328f970ccb7719f0d1c9a1a93a10dcdea51c364a34ca6`.
Report `test-results/phase2/kaggle-ready-20261014/remote-verified.json` ghi rõ
`kaggle_execution=false`; kiểm remote không thay thế chạy Deep trên Kaggle.

## Kiểm thử thực sự đã chạy

- Python tools14/14 trên Windows và Linux, exit0. Gồm gate Smoke→Deep, đủ ba lượt
  thực, giữ lỗi/fault FAIL và ngừng tăng tải, scheduler/backoff/contract/đối soát.
- Runner local12/12 exit0; notebook mọi code cell compile, không saved outputs;
  Node syntax check exit0. Test Windows dùng require_escalated vì sandbox chặn
  ACL của thư mục tempfile; bản chạy trong sandbox thất bại được giữ trong unit.log,
  không sửa test để bỏ assertions. Bản cuối unit-final.log đạt.
- Container riêng, source bind read-only, reuse image Clinic build có sẵn; cài
  native packages bên trong container, không build image hoặc copy node_modules.
  Core/Clinic runtime reuse Linux build trước đó; build Notification từ source.
  Đây không phải clean npm-ci của Git checkout mới hoặc chính Kaggle image.
- Node24.16.0 Linux tải chính thức và kiểm SHA256 từ SHASUMS; PG15.19,
  RabbitMQ3.10.8, Redis7.0.15, Nginx1.22.1. Mỗi case initdb/ba DB/role mới,
  data-directory+marker guard, sáu CONNECT chéo bị từ chối, migration/runtime thật.
- `native-final-1`: mixed2RPS, 2swarmup/5ssteady,8owner,1Clinic: COMPLETE,
  generator valid, đối soát PASS_IN_SCOPE, không missing/unknown/duplicate/exit lạ.
- `native-final-2`: cùng tải,2Clinic qua Nginx; cùng kết quả đúng. Billing10/10,
  same-key replay và invoice/INVOICED khớp; p95~139,37ms. Xác nhận lịch→owner notice
  10/10, p95 upper bound~731,25ms. Consumer outage60s,30appointment/60event hợp lệ,
  nhận30/30 owner notice trong~1,303s sau restart, 0notice trùng. Tất cả probe
  PASS_IN_SCOPE; parent/container exit0 sau teardown.

Raw evidence ignored: `test-results/phase2/kaggle-ready-20261014/` chứa linux.log,
unit-final.log,local-runner.log và native-final-1/2/{summary,requests,metrics,
resources}. Không public fixture/context/DB/token/runtime logs riêng trong `/tmp`.

## Lỗi tìm được và giới hạn

1. Native lượt đầu xử lý HTTP/đối soát đúng nhưng FAILED lúc teardown do parent
   còn giữ stdin mở. Sửa close pipe ở controller và pause stdin ở Node sau cleanup.
2. Native-fixed2 có billing PASS nhưng notification FAIL: owner đặt lịch thông báo
   admin theo contract; observer sai khi chờ owner. Sửa probe thành owner đặt lịch
   → admin xác nhận (revision guard) → owner notice; đo từ request xác nhận.
   Không đổi business recipient hoặc nới p95/recovery threshold. Inspect có filter
   appointmentIds để observer không copy toàn bộ dataset mỗi poll.

Giữ tất cả report FAIL ở native-1 và native-fixed-2, không ghi đè. Container
`phase2-kaggle-native-smoke-20261014` Exited0, writable~1,21GiB ở Docker data trênD;
giữ fixture cũ/volumes. Không khởi động stack DB của người dùng, không reset/seed/
down-v, không mở public endpoint.

Chưa chạy chính Kaggle, chưa Deep18lượt, chưa B0/B2/B3 cưỡng chế ngân sách, full
journey10/20/70, hotel interference, pool histograms hay đủ sample/repeats cho
fault NFR. Các p95/recovery trên là screening, không chứng nhận capacity. Notebook
luôn ghi capacity_accepted=false. MốcH vẫn cần người nhận độc lập.
