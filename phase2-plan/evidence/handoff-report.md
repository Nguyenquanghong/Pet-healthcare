# Gói bàn giao chuẩn bị — chưa có tiếp nhận độc lập

Ngày 12/10/2026. Triển khai tuần tự trước mốc H. Hai thành viên chưa được
giao code hoặc ghi nhận đã chạy trên máy riêng. Gói H dưới đây giữ provenance của
**dirty workspace** trên main/add596e4488e3cac2584115874c2f65a97af7047; HEAD cũ đó
không chứa toàn bộ pha 2. Người dùng hiện đã cho phép checkpoint local trên nhánh
`phase2/service-split-checkpoint-20261012`, gồm code pha 2 và sửa kiểm tra Git root
qua junction sau khi chuyển repo sang D. Hook local giữ tài liệu Markdown ngoài
commit (trừ README gốc); runbook/evidence/STATUS này vẫn lưu local và trong gói H
theo snapshot gốc. Xem [kiểm chuyển ổ](relocation-check.md).
Checkpoint local đã tạo: `41d8a72ea69f342e278d357be27b10130e07c954` (256 file).
Chưa push hoặc có xác nhận tiếp nhận; archive H cũ không được đổi hash hay gán
kết quả test của lượt mới cho source đã đóng dấu trước đó.

## Kiểm gói H ngoài checkout — 12/10/2026

- Đã có package/manifest/receipt và runner giải nén vào OS temp mới, không .git,
  node_modules/dist/generated/env/data. Source guard không dùng Git cha và kiểm
  P7 provenance qua manifest. Gói giữ 7 file nền người dùng cần cho ứng dụng,
  loại 11 notebook/PCN/old archive/default compose khỏi gói; 18 file gốc còn nguyên.
- Machine-local exclude \*.md từng làm thiếu phần lớn runbook trong copy; đã thêm
  exceptions chỉ cho phase2-plan/evidence/deploy docs, không sửa .git/info/exclude.
- Lượt candidate 505 file/hash b0c9936b… đã cài/build/unit và P1–P7 73/73, nhưng
  E2E 17/18 nên **chưa PASS gói**. Trace xác định hai /auth/me canceled
  net::ERR_ABORTED và hai replacement 200; recorder cũ thiếu requestfailed.
  Đã ghi lifecycle thật, chỉ cho tối đa một initial /me cancellation mỗi màn
  kèm replacement finished 200; pending/failure API khác vẫn FAIL. Không đổi
  frontend, bỏ assertion hoặc retry để che lỗi. Log/receipt/clone lỗi được giữ.
- Gói đã kiểm chứng cuối và report nguồn sẽ được ghi riêng; không suy source
  mới PASS từ hash candidate. Người nhận/máy khác/remote CI vẫn chưa thực hiện.
- Ca kiểm recorder riêng sau sửa chưa chạy được: Clinic worker native exit
  3221226505 trước readiness, stdout rỗng (h-network-recorder-fixed.log). Windows
  Application log trong lookback không có node.exe event; chưa có subcode/stack.
  Đây là recurrence của known issue P6, không quy là lỗi recorder hoặc đã sửa.
  Gói mới phải kiểm toàn bộ và giữ cả FAIL này, không automatic retry/skip.
- [Receiver start](../RECEIVER-START.md), [runbook H](../../deploy/phase2/handoff-runtime.md),
  [task sau H](../POST-H-TASKS.md). Các vai trò mới là dự kiến, chưa phân công.
- Lượt thứ hai hash 66396106… vẫn E2E 17/18 vì runner H gán NODE_ENV=test cho
  Vite, tạo React development/9 request so với baseline 8. Đã bỏ override và
  ép production trong E2E build; test kiểm renderer bundleType=0, không bỏ
  StrictMode hoặc nới budget. Targeted case 1/1 exit 0 (~29,1s) dù caller
  NODE_ENV=test: 7 request, zero background/12s; chờ gói source mới chạy full.

## Gói kỹ thuật để review

Gói cuối và kết quả theo hash ở [h-source-package.json](h-source-package.json).
Archive 508 file/source hash 8f5bbfbd… không .git/env/data/build artifacts.
Full cold detached run trên source 8330475c… đạt 73 integration/18 real E2E/9 UI,
81 unit + 12 runtime/dependency/source guards; wrapper FAIL chỉ vì thiếu PATCH-NOTES.
Gói cuối chỉ khác .gitignore/PATCH-NOTES, mọi code/config/schema/lock SHA256 bằng
nhau. Source guards 6/6, fresh extraction/provenance/hash và docs chạy lại trên
gói mới. Không nói full suite đã chạy lại trên doc-only delta; report cũ giữ FAIL.

Đường dẫn archive/receipt trong report là bản review thực, source staging/hash
đóng băng. Current workspace có cập nhật checkpoint/evidence sau đóng gói; không
coi nó tự động cùng source hash hoặc tự commit/push. [Receiver](../RECEIVER-START.md)
giúp kiểm archive và source hash trước thực hiện.

| Nội dung    | Bằng chứng/cách tái hiện                                                                                                                                                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership   | Core identity/pet/hotel/billing, Clinic khám/Spa/medical/image, Notification inbox/read; own clients/DB/runtime, [P7 manifest](p7-field-manifest.json)                                                                                                           |
| Kiểm chứng  | [Test history](test-results.md), P0–P7 evidence và [STATUS](../STATUS.md); không dùng kết quả remote CI chưa chạy                                                                                                                                                |
| Runtime     | [Stack](../../deploy/phase2/README.md), [Clinic](../../deploy/phase2/clinic-runtime.md), [Notification](../../deploy/phase2/notification-runtime.md), [billing](../../deploy/phase2/billing-runtime.md), [resilience](../../deploy/phase2/resilience-runtime.md) |
| UI/contract | [Frontend runbook](../../deploy/phase2/frontend-runtime.md), backend/openapi.json, services/clinic/openapi.json, packages/contracts/events/v1/envelope.schema.json; public 69 operations, envelope schemaVersion=1                                               |
| Dữ liệu     | [Migration runbook](../../deploy/phase2/migration-runtime.md), [P7 report](p7-reconciliation.json); fixture tổng hợp sinh mới, snapshot/dump chứa dữ liệu bảo vệ giữ ignored                                                                                     |
| Cài đặt lại | npm ci + npm test + phase2:build + phase2:up + phase2:verify; Windows prepare-nginx, Chromium theo Playwright; không chạy default demo seed/integration vào DB đang dùng                                                                                         |
| Source copy | clean-local tool giữ cả dirty tracked/untracked source với SHA256, không .env/node_modules/generated/dist; 509-file copy đã qua install/build/tests trên cùng Windows host                                                                                       |
| Rollback    | Trước target open có rollback single-writer; sau open chỉ forward-fix giữ dữ liệu mới. Chưa reverse migration/PITR/live cutover                                                                                                                                  |

Checklist HANDOFF có evidence local cho nghiệp vụ/UI/role/slot/protocol/replay/auth/
replica/migration. Phần **tiếp nhận độc lập** ở mục 3 HANDOFF chưa làm. Trước chuyển
gói source phải chọn chính xác các dirty changes pha 2 và bảo toàn 18 file của người
dùng; source-copy hiện tại phục vụ kiểm cài đặt, không phải bản release đã review.
Không chia sẻ .env/keys/context/snapshot/dump thật hoặc tự commit để tạo mốc.

## Known issues và người xử lý

| Mức độ                                   | Vấn đề/giới hạn                                                                                                                                  | Người xử lý và điều kiện đóng                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Trung bình, availability/reproducibility | P6 từng native Windows exit 3221226505 và mất TCP Core; chưa biết nguyên nhân. P7 mới và cài lại cùng máy đạt, không chứng minh sửa native crash | Người tích hợp trước review; đối chiếu Linux/Windows máy khác/CI, giữ child exit logs, điều tra nếu tái hiện; không retry/skip để PASS |
| Chưa kiểm chứng vận hành                 | Live dataset/schema cổ, external payment/mail/storage, target backup sau new writes/PITR, HA và host loss                                        | Người tích hợp khi có phạm vi môi trường riêng; không dùng cutover rehearsal để suy ra live readiness                                  |
| Giới hạn công cụ                         | Snapshot memory 32 MiB/100.000 row/model; dữ liệu invoice/notification mơ hồ yêu cầu review; chưa reverse migration                              | Người tích hợp; kiểm workload/data sizing, evidence operator trước mọi export lớn/live change                                          |
| Chưa đo capacity                         | Replica correctness/pool snapshots có, không throughput/p95/workload mix                                                                         | P8 sau H; versioned workloads, warmup/repeats/raw results, không quảng cáo scale từ test correctness                                   |
| Chưa tiếp nhận                           | Chưa có người khác chạy hướng dẫn/gói source trên máy riêng hoặc remote CI result                                                                | Người nhận cùng bạn sau review; ghi lại commands/env/results và xác nhận thực tế mới DONE H                                            |

Không còn lỗi correctness tái hiện ở các suite local đã PASS; các giới hạn trên
không được chuyển thành lời hứa capacity/production readiness.

## Bước H tiếp theo

1. Review diff và gói source hiện tại; chọn mốc bàn giao theo chỉ định của bạn,
   không tự commit/push hoặc gom thay đổi local của người dùng.
2. Tái hiện trên môi trường thử riêng/máy người nhận: Clinic chạy slot + billing/
   undo; Notification/UI chạy replay + E2E; mỗi người giải thích được ownership.
3. Ghi kết quả độc lập vào report này và checklist HANDOFF; nếu lỗi thì sửa trước
   chia task. Sau đó mới giao hai vai trò Clinic và Notification/UI.
4. P8 đo workload có auth/register/read/clinic, một/nhiều replica với repeats,
   raw data, source/env/fixture/quota manifest; acceptance theo 04-validation.

Ước lượng còn 1–3 ngày công cho review/tái hiện H và 3–5 ngày cho P8/report, tùy
khả năng tái hiện native issue và môi trường. Đây là dự báo, chưa tính hai người
đã nhận việc hoặc cam kết lịch.
