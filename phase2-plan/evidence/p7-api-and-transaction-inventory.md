# P7 — API/transaction delta

Không thêm/sửa public business API, event schemaVersion=1 hoặc Prisma migration
lịch sử. Core vẫn 69 public operations (gateway các miền chuyển); Clinic 17 public
operations + bootstrap/private billing; Notification sáu public operations, gồm
manual send có JWT và kiểm quyền hiện tại qua Core private authorization. Đối chiếu
hợp đồng bằng contracts/OpenAPI và hồi quy P1–P6/E2E.

| Công cụ                  | Read/write và transaction                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| init                     | Tạo DB/role/schema/marker mới, deploy migration hiện có bằng bootstrap; runtime chỉ SELECT ban đầu, source được DML riêng                                |
| freeze                   | Source transaction FOR UPDATE ledger; exclusive lock tất cả bảng business, revoke DML/sequence USAGE rồi FROZEN; đợi in-flight hoặc fail timeout         |
| backup-restore           | Source FROZEN; custom archive, tạo restore DB mới, restore một transaction; không overwrite/clean                                                        |
| export                   | Source/restore RepeatableRead; catalog+mọi row+sequence; tạo file exclusive, không ghi bảng business                                                     |
| dry-run                  | Validate checksum/shape/relations/time/financial/history/evidence; đọc source frozen và target empty/exact; không ghi                                    |
| import                   | Advisory cutover lock nguồn; mỗi DB một transaction/advisory journal lock; inserts+hash comparison+journal cùng commit; source IMPORTED sau mọi đích đạt |
| validate                 | Đọc toàn bộ model đích và FK; đối chiếu exact snapshot đã biến đổi trước mở ghi; sau write mới dùng đối soát hiện tại thay hash cũ                       |
| rollback-before-open     | Source ledger FOR UPDATE; revoke mọi target write trước khi source DML được grant; chỉ FROZEN/IMPORTED và chưa opened_at                                 |
| open-target              | Source freeze/target exact, commit opened_at/TARGET_OPEN trước grant target DML; source không được cấp lại quyền                                         |
| pause-target/forward-fix | Serialize qua nguồn; revoke/grant target đúng ownership, đổi ledger; giữ mọi business row/terminal/outbox/inbox                                          |

`withCutoverLock` giữ một transaction nguồn riêng để serialize các transaction
thành phần; không phải distributed atomic transaction. Crash giữa component grants
giữ maintenance và forward-fix. Công cụ migration dùng bootstrap, runtime service
không có credential bootstrap hoặc query DB khác. API/worker readiness dùng bảng
migration sở hữu; runtime Role không tự GRANT vì không sở hữu bảng.

Gateway maintenance/drain và dừng source workers/jobs là bước operator/harness;
CLI không tự tìm/kill process hoặc đổi gateway người dùng. Rehearsal có Nginx/PID/
port riêng và chỉ dừng process được tạo bởi lượt thử. Không giao thông báo/email
cho người khác hoặc cutover thật trong P7.
