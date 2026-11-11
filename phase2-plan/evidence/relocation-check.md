# Kiểm chuyển Documents từ C sang D — 12/10/2026

Người dùng cho phép kiểm tra và commit local, chọn nhánh riêng hoặc main.
Nhánh được chọn: `phase2/service-split-checkpoint-20261012`, từ main
`add596e4488e3cac2584115874c2f65a97af7047`. Không push hay thay dữ liệu đang dùng.
Commit đã tạo: `41d8a72ea69f342e278d357be27b10130e07c954`, 256 file;
pre-commit hook chạy bình thường, không bypass. Index trống sau commit, main giữ
nguyên; 18 original SHA256 và archive H hash kiểm lại sau commit đều khớp.

## Đường dẫn và lỗi đã sửa

- `C:\Users\<user>\Documents` là junction tới `D:\Documents` (đường dẫn máy người chạy, lược bỏ tên người dùng).
- `fs.realpathSync` của repo qua C và D đều cho cùng một đường dẫn trên ổ D (`D:\Documents\...\Pet-healthcare`).
- Cả 8 junction trong `node_modules` resolve đúng; không cần cài lại dependencies.
- Node còn có thể báo cwd ở C, trong khi `git rev-parse --show-toplevel` báo D.
  Công cụ `source-provenance.mjs` trước đây từ chối hai đường dẫn này với lỗi
  `SOURCE_GIT_ROOT_OR_MANIFEST_REQUIRED`. Lỗi được tái hiện khi Git chạy thực sự,
  không lấy sandbox EPERM làm bằng chứng lỗi junction.
- Sửa so sánh Git root bằng `realpathSync`. Test mới tạo repo thử và junction/
  directory symlink, xác nhận hai đường dẫn cùng chọn source; thư mục con không
  có manifest vẫn bị từ chối, không dùng provenance của repo cha.
- Kiểm trên repo thật: danh sách source, checksum source và provenance qua C/D
  giống nhau. Không sửa các đường dẫn khảo sát cũ vì chúng là metadata lịch sử.

## Kiểm thực sự đã chạy

| Lệnh/kiểm                                                | Kết quả                                                                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `npm test`                                               | Exit 0; build Core/frontend/shared packages; unit 81/81, runtime 4/4, dependency 2/2, source 7/7          |
| Backend architecture/OpenAPI trong `npm test`            | PASS; 96 source files, 69 operations                                                                      |
| Build `@nipopeto/clinic`, `@nipopeto/notification`       | Cả hai exit 0; generate client/build, không migrate                                                       |
| `npm test -w @nipopeto/contracts`                        | Exit 0; 8/8                                                                                               |
| `check-boundaries.mjs`, `check-notification-writers.mjs` | PASS                                                                                                      |
| `npm run phase2:test:notification-ui`                    | Exit 0; 9/9 browser tests với API intercept, 21,8 giây                                                    |
| `check-document-links.mjs`                               | PASS sau cập nhật; 40 tài liệu, 186 local links                                                           |
| `verify-local.mjs`                                       | 18/18 SHA256 của các thay đổi ban đầu PASS                                                                |
| Kiểm manifest gói H 508 file                             | PASS; source hash `8f5bbfbd2dc740d1e8cc6f99c5cfbf90f6e64ac82c6eb76ae731d59669a8dcab`                      |
| `git diff --check`, `git diff --cached --check`          | Working tree PASS; staged check phát hiện 3 dòng trống thừa cuối file mới, đã bỏ và kiểm lại trước commit |

Log mới nằm trong `test-results/phase2/relocation-npm-test.log`,
`relocation-services-build.log`, `relocation-ui.log`; là artifact local bị ignore.
Lệnh kiểm docs đầu tiên gọi nhầm tên `check-doc-links.mjs` và không chạy; đã sửa
thành `check-document-links.mjs`, không tính lượt gọi sai là PASS.

## Phạm vi checkpoint và phần chưa kiểm

Checkpoint bao gồm code/config/schema/migrations/tests và báo cáo máy đọc pha 2,
cùng các thay đổi có sẵn liên quan backend/frontend cần để source chạy đúng.
Hook `.git/hooks/pre-commit` có quy tắc `docs/*|*.md|*.mmd` bị chặn, trừ README
gốc. Không bypass hay sửa hook; các file Markdown đã stage trong lượt này được
unstage, giữ nguyên working copy. STATUS/runbooks/evidence Markdown vẫn lưu local;
người nhận không được suy ra chúng có trong Git chỉ từ tên nhánh checkpoint.
Các notebook/PCN benchmark ngoài scope được giữ nguyên,
không stage. Env thật, generated clients, build outputs, node_modules, log/dump và
các bản cài thử không được đưa vào commit.

Không tạo bản npm ci/source copy mới trong lượt này. Bốn bản cài thử đã dọn ở lượt
trước giữ source/log/dump trong `test-results/phase2/disk-cleanup-20261012`; biên
nhận local ghi khoảng 2,646 GB được thu hồi sau khi bảo toàn 50,8 MB.

73 integration và 18 real E2E không chạy lại sau chuyển ổ; kết quả H trước đó vẫn
thuộc source/hash ghi trong báo cáo H. Gói H cũ được giữ nguyên, không chứa sửa
junction mới. Chưa kiểm máy độc lập/remote CI/live cutover; native Windows crash
chưa có root cause. H vẫn IN_PROGRESS và P8 vẫn TODO.
