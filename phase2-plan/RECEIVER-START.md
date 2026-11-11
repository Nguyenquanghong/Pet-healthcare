# Bắt đầu từ gói source pha 2

Gói này là snapshot workspace có manifest SHA256; HEAD và các thay đổi local
được ghi trong manifest/receipt riêng của từng gói. Core, Clinic & Scheduling,
Notification giữ TypeScript/Express, database/client/credential riêng. P0–P7 có
evidence local; H chỉ DONE khi người nhận thực sự tái hiện theo HANDOFF.md.

## Chuẩn bị và xác minh

Node 24/npm 11, Docker Desktop/Compose chạy Linux containers, Git nếu dùng checkout,
tar và Chromium Playwright. Windows dùng Nginx pin của project; Linux cần nginx
và browser dependencies đã cài. Không cần copy .env/secret/dataset của người gửi.

Windows đã qua notebook và hồi quy với Node 24.16.0 portable; Node 24.15.0 đã thoát
native trong load test. Công cụ
`tools/phase2/prepare-node-windows.ps1` tải bản 24.16.0 pin SHA256 vào thư mục test
trên ổ chứa repo, không thay Node/PATH hệ thống. Evidence mới ghi rõ version; không
suy một lượt PASS là xác định hoàn toàn nguyên nhân native crash.

1. So archive SHA256 với receipt được cung cấp cùng mốc review.
2. Giải nén vào **thư mục mới**, không đè checkout hoặc DB đang dùng. Không cần .git.
3. Kiểm manifest trước cài dependencies; kiểm cả hash source đã ghi trong receipt:

```powershell
# Chạy trong thư mục source vừa giải nén.
node tools/phase2/check-handoff.mjs . <sourceHash-trong-receipt>
npm ci
npm test
npm run phase2:build
npm exec -- playwright install chromium
npm run phase2:prepare:nginx
npm run phase2:up
npm run phase2:verify
npm run phase2:test:notification-ui
node tools/phase2/check-document-links.mjs
node tools/phase2/check-handoff.mjs . <sourceHash-trong-receipt>
node tools/phase2/stop-test.mjs
```

`phase2:prepare:nginx` chỉ dành cho Windows; Linux dùng nginx đã cài. Gói không mang
node_modules/dist/generated client. Manifest không cho thiếu/đổi source, thêm file
không ghi nhận hoặc env/keys/data. Output build/log/fixture được phép trong các
thư mục generated/ignored riêng. SHA256 kiểm tính toàn vẹn so với receipt, không
phải chữ ký số hoặc chứng nhận bảo mật.

Docker test dùng exact3 `pet-phase2-p1-test`, PostgreSQL 127.0.0.1:55432,
RabbitMQ 5679, Redis 6389. Nếu đã có project đó, dữ liệu/volumes được giữ; các suite
xác minh marker/identity trước ghi và tạo fixture UUID mới. P7 tạo DB/role mới mỗi
lượt, backup restore riêng. Không dùng db:seed/db:migrate/default demo integration,
backend/.env, reset hoặc down-v. Không chạy hai proof/build đồng thời trên Windows.

Provenance P7 lấy verified manifest khi không có .git. Nó kiểm toàn bộ source trước
export, không dùng Git của thư mục cha hoặc bịa commit mới. Snapshot vẫn ghi HEAD
gốc/dirty hashes và source bundle hash. Sửa source thì phải tạo mốc/gói review mới;
không cập nhật hash để biến một lượt test cũ thành bằng chứng cho source đã đổi.

## Tái hiện theo vai trò sau review

| Vai trò dự kiến, chưa giao trước H | Lệnh/acceptance                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clinic                             | phase2:test:clinic (7 nhóm), phase2:test:billing (12 nhóm); trình bày hai thứ tự slot/prepare–undo và commit–abort, xác nhận chỉ một invoice/reservation đúng                 |
| Notification/UI                    | phase2:test:notification-runtime (8 nhóm), phase2:test:notification-ui (9), phase2:test:e2e (18); replay/DLQ/inbox, outage không logout/chặn khám và trạng thái pending/saved |
| Bạn, tích hợp Core                 | phase2:test:resilience (18), phase2:test:migration (11), contracts/OpenAPI/boundaries; key/credential/pool/rollback và invariant I01–I12                                      |

Mỗi người ghi Node/OS/Docker/source hash, command/exit/PASS/FAIL/SKIP và raw log
riêng; giải thích ownership/HTTP/event/transaction. Không ghi đã tiếp nhận từ việc
chỉ tải source hoặc xem video. [Checklist](HANDOFF.md), [gói H](evidence/handoff-report.md),
[STATUS](STATUS.md) và [runbook migration](../deploy/phase2/migration-runtime.md)
ghi known issues/giới hạn. Windows native process loss từng thấy ở P6 chưa rõ
nguyên nhân; mọi child exit bất thường phải FAIL, không retry/skip để PASS.

P8 chỉ bắt đầu sau mốc tổ chức H hoặc khi bạn chỉ định tiếp tự làm: workload có
auth/read/clinic, một/nhiều replica, repeats/raw data, không suy capacity từ các
suite correctness. Gói/source report không mang context/dump/rows/keys từ phiên
thử người gửi; raw artifacts trên máy người nhận cũng giữ ignored.
