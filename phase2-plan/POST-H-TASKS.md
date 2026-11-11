# Task nhỏ sau tiếp nhận H — chưa phân công người

Chỉ bắt đầu sau review và người nhận tái hiện theo HANDOFF. Bạn giữ Core/tích hợp,
không giả định hai người đang code. Không đổi contract/schema/shared lockfile hoặc
mở rộng service từ các task này. P8 cần manifest/repeats/raw data, không gọi test
correctness là capacity.

| Vai trò dự kiến          | Task đầu tiên review được                                                                                      | Acceptance                                                                                                                                                             | File sở hữu / dependency                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clinic                   | Chạy và ghi lại test slot, prepare–undo, commit–abort trên máy riêng; thêm một regression nếu có lỗi tái hiện  | clinic 7/7 + billing 12/12, không skip; SQL barrier/winner và invoice/reservation có raw evidence, source hash/OS/Node/DB scope rõ                                     | services/clinic, tools/phase2/clinic.test.mjs; không sửa Core protocol hoặc packages/contracts nếu chưa review tích hợp                            |
| Notification/UI          | Tái hiện replay sau read/delete và notification outage trên UI                                                 | runtime 8/8 + UI 9/9 + real E2E 18/18; không hồi sinh/trùng notice, giữ phiên/ghi Clinic, logs không payload/secret                                                    | services/notification, frontend vùng notification/query; dùng Core authorization contract đã chốt                                                  |
| Bạn, tích hợp Core       | Review gói dirty source, source receipt và phân loại baseline local; đối chiếu known native process-loss issue | Chọn mốc review rõ, giữ 18 file gốc, không tự commit/push; child exit bất thường FAIL, có kết quả máy khác/CI trước đóng mục chưa kiểm chứng                           | backend, packages, deploy, shared lockfile và STATUS; tiếp nhận hai report độc lập                                                                 |
| Cả nhóm sau H, chưa giao | P8 screening rồi workload B0/B1/B2/B3 có auth/register/read/clinic và hotel/billing nền                        | Đếm hoàn thành nghiệp vụ/202→terminal, p50/p95/p99/429/503/CPU/pool/lag, cùng resource budget và fixture; ít nhất 3 repeats steady theo 04 hoặc ghi screening/giới hạn | tools benchmark mới theo manifest chung; baseline tham khảo từ benchmarks hiện có phải port có review, không sửa notebook/PCN local của người dùng |

PR đầu tiên nhỏ và có review; các miền thay đổi liên quan phải có cùng contract
version. Không nhận task tách service còn dang dở dưới tên bảo trì; trạng thái đã
kiểm chứng và chưa kiểm chứng nằm ở [STATUS](STATUS.md). Reverse migration, live
cutover, HA/mail/ngân hàng thật hoặc Identity service mới chưa được giao từ bảng này.
