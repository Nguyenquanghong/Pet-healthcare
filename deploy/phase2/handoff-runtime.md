# H — Đóng gói và kiểm bản source để tiếp nhận

Không commit/push hoặc gửi source cho người khác bằng các lệnh này. Gói dùng dirty
workspace được review với SHA256; HEAD gốc không chứa mọi thay đổi pha 2. Chỉ Core,
Clinic & Scheduling và Notification, không thêm service. Đọc
[receiver start](../../phase2-plan/RECEIVER-START.md) sau giải nén.

```powershell
npm run phase2:test:source
npm run phase2:handoff:package
# Chỉ giải nén/kiểm checksum, không cài thêm dependencies hoặc chứng nhận runtime:
npm run phase2:handoff:integrity -- test-results/phase2/handoff-<UUID>/receipt.json
# Dùng đúng receipt.json được lệnh trên trả về; stack thử phải đang chạy.
npm run phase2:up
npm run phase2:handoff:verify -- test-results/phase2/handoff-<UUID>/receipt.json
```

Package tạo source staging, manifest từng path/size/SHA256 và .tgz trong ignored
test-results/phase2. SHA archive phải khớp receipt trước giải nén. Verify tạo một
thư mục mới ngoài checkout trong OS temp, không .git và không copy dependencies,
dist, generated client, env, keys, dumps, uploads hoặc raw test artifacts. Giữ
files nền người dùng mà code cần và ghi rõ chúng trong receipt. Gói mới gồm hai
Dockerfile, hai file Compose local, helper Docker và notebook `benchmarks/phase2`.
Notebook/PCN Kaggle và plan ZIP cũ không thuộc gói; fixtureData dùng bởi unit được
giữ. Không xóa hoặc sửa các file gốc bị loại. Những file baseline được sửa có chủ
đích sau checkpoint được pin cả hash cũ/mới và lý do trong
`phase2-plan/evidence/baseline-revisions.json`; drift ngoài các byte đã review vẫn
bị từ chối, không thay hash baseline lịch sử.

Tài liệu phase2-plan/_.md, evidence/_.md và deploy/phase2/_.md có exception rõ
trong .gitignore để machine-local exclude _.md không làm mất runbook/checkpoint.
Không sửa .git/info/exclude của người dùng. Stage kiểm source bytes khớp manifest;
receiver kiểm cả file thiếu/đổi, path traversal và source/env mới không ghi nhận.
Output npm/Prisma/build/log chỉ được phép ở các thư mục generated/ignored.

Runner cài npm ci, npm test, build ba service, Chromium, Windows Nginx riêng;
chạy phase2:verify (contracts, boundaries, P1–P7 và real E2E), 9 UI intercept và
documentation links. Kiểm source hash lại sau chạy. Nginx cache zip pin được so
hash rồi giải nén mới, không mượn executable từ checkout gốc. Profile .env không
được copy; test DB/broker/Redis và ephemeral keys do harness tự cấp.

P7 lấy verified source manifest nếu không có .git; không vô tình dùng Git cha.
Snapshot ghi HEAD/dirty hashes nguồn và bundle/manifest hash. Có manifest mà source
đã đổi phải FAIL, không fallback Git hoặc cập nhật hash để dùng test evidence cũ.
Đây là checksum so receipt, không chữ ký số.

Verify giữ log/raw artifacts/thư mục temp khi PASS hoặc FAIL, ghi từng command/exit/
duration trong verification-UUID.json cạnh receipt. Cuối lượt guard exact3 và stop
stack thử, giữ DB/role/row/queue/volumes. Không automatic retry/skip/per-case restart
để che lỗi native; nếu FAIL, sửa đúng lỗi rồi tạo gói/source hash mới.

Chạy ngoài checkout trên cùng Windows host chứng minh gói tự chứa source và hướng
dẫn cài đặt; vẫn dùng cùng Docker test volumes. Nó không thay thế máy khác, remote
CI hoặc người nhận độc lập. WSL hiện chỉ có docker-desktop nội bộ, không cài thêm
distro hoặc thay Docker settings trong H. Các mốc local/độc lập được ghi riêng ở
[report H](../../phase2-plan/evidence/handoff-report.md) và
[STATUS](../../phase2-plan/STATUS.md).
