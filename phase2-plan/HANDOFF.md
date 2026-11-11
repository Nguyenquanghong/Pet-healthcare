# Mốc H — Tách xong để bàn giao cho nhóm

Giai đoạn trước mốc H: hoàn tất tách 3 service và kiểm chứng P0–P7. Giai đoạn sau mốc H: bàn giao cho các thành viên còn lại trong nhóm. Checklist kỹ thuật dưới đây đã có evidence local P0–P7; H tổng thể vẫn IN_PROGRESS vì chưa có tiếp nhận độc lập trên máy người nhận. Các ô đã đánh dấu không chứng nhận capacity/live readiness.

## 1. “Tách xong” nghĩa là gì?

Ba service đã có ownership thực và chạy được hành trình nghiệp vụ; không chỉ chuyển file vào ba thư mục. P0–P7 phải đạt, bao gồm auth/internal security và rehearsal dữ liệu thử. P8 benchmark đầy đủ và tài liệu bảo vệ có thể làm cùng nhóm sau H.

- [x] Core, Clinic và Notification build/start độc lập; DB role không truy cập chéo; gateway route read/write đúng — P1/P3/P6/P7.
- [x] Khách mới đăng ký → tạo pet → đặt khám → ghi bệnh án → invoice → notification chạy được trên UI — real E2E P5–P7.
- [x] Spa/hotel/activation và dữ liệu phân trang hiện có không bị mất chức năng — real E2E, P4/P7 historical checkout.
- [x] Không có hai appointment trùng slot; bệnh án/completion atomic; invoice-vs-undo và late commit-vs-abort có test thật — P1/P3/P4 SQL barriers.
- [x] Notification/broker dừng rồi phục hồi không mất/trùng event; inbox/outbox/retry/DLQ hoạt động — P1/P2/P6/P7.
- [x] Owner/staff scopes, JWT/internal credentials, limiter chung và auth surge guards có test — P2/P3/P6.
- [x] Bootstrap không tải lại toàn hệ thống định kỳ; UI phân biệt pending/saved/refresh failed — P5/E2E.
- [x] Migration trên dữ liệu thử giữ IDs/history/payment totals; restore và giới hạn rollback được kiểm chứng — P7 18 model/234 field.
- [x] Ít nhất hai Clinic replica đã được kiểm tra định tuyến và correctness; capacity còn P8 — P6 actual Nginx/SQL/idempotency.
- [x] API/event/schema đã chốt phiên bản; không còn stub trả thành công giả hoặc TODO trên đường chạy chính — contracts/OpenAPI/boundaries và scoped runtime source audit.
- [x] Known issues có mức độ và owner; không còn blocker correctness tái hiện ở các suite PASS; native Windows loss chưa rõ nguyên nhân/benchmark chưa đo — handoff report.

Xem [test history](evidence/test-results.md), [gói H](evidence/handoff-report.md) và
[receiver start](RECEIVER-START.md). Source là dirty snapshot có receipt/manifest;
không coi HEAD gốc hoặc các kết quả máy khác chưa chạy là code/evidence đã bàn giao.

Không chờ báo cáo trình bày đẹp hoặc tính năng mở rộng trước khi bàn giao; vẫn phải đạt correctness và khả năng chạy lại độc lập.

## 2. Gói bàn giao tối thiểu

| Thành phần    | Nội dung phải có                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Mốc code      | Branch/HEAD, mô tả dirty changes nếu có, danh sách migration và contract version; không tự commit/push nếu chưa được giao |
| Chạy local    | Prerequisite, env.example không secret, build/start/health/smoke commands đã chạy thật, ports/project name                |
| Dữ liệu       | Fixture tổng hợp cho DB mới riêng; backup/restore/migration report; cấm seed vào DB đang dùng                             |
| Contracts     | Public/internal OpenAPI, event schema, ownership và phiên bản tương thích                                                 |
| Kiểm chứng    | Test commands, PASS/FAIL/SKIP, evidence crash/race, giới hạn scale chưa đo                                                |
| Vận hành      | Cách xem log theo correlationId, DLQ/replay, operation pending/reconcile, restart service                                 |
| Backlog sau H | Task cụ thể theo thành viên, acceptance criteria, file sở hữu và dependency                                               |

Ghi gói thực tế vào `phase2-plan/evidence/handoff-report.md` khi đạt H; không tạo report PASS sẵn. Dùng `STATUS.md` làm điểm bắt đầu cho người nhận.

## 3. Buổi tiếp nhận

1. Bạn chạy demo hành trình và giải thích ranh giới dữ liệu/transaction cùng một ca lỗi.
2. Mỗi người nhận chạy bản code bàn giao trên môi trường thử riêng theo hướng dẫn; không dùng DB đang hoạt động của bạn.
3. Thành viên Clinic chạy test slot và invoice/undo; thành viên Notification/UI chạy replay và một E2E. Người nhận phải tái hiện được bằng hướng dẫn, không chỉ xem video.
4. Người nhận trình bày lại service sở hữu gì, gọi API nào, phát/nhận event nào và khi dependency lỗi thì hệ thống phản hồi ra sao.
5. Chốt task đầu tiên nhỏ, có test và một PR review trước khi mở rộng quyền sửa. Nếu chưa chạy được thì sửa runbook/môi trường, không coi bàn giao hoàn tất.

## 4. Quy tắc sau bàn giao

Bạn giữ Core và tích hợp chung. Thành viên Clinic phụ trách test/sửa lỗi/đo scale miền khám; thành viên Notification/UI phụ trách thông báo/E2E/demo. Mỗi người chịu trách nhiệm tests phần mình; benchmark và báo cáo ghép bằng cùng run manifest.

Không tự đổi API/event/schema xuyên service, xóa migration hoặc sửa shared lockfile/Compose ngoài người tích hợp. Không đẩy việc tách service chưa hoàn thành thành “task bảo trì” cho người nhận mà không ghi rõ tình trạng. Nếu nhóm muốn phân chia công việc sớm hơn mốc H, cần thống nhất và cập nhật rõ trong STATUS.md.
