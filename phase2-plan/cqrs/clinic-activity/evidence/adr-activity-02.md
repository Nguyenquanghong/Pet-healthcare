# ADR-activity-02 — D0 và đối chứng trên ngân sách Kaggle dùng chung

**Bổ sung sau v6:** [ADR-activity-03](adr-activity-03.md)/policy v7 thêm requirement M/O/R để so với trước CQRS và trước tách module. Resource classes/stage split của ADR02 giữ nguyên; comparison lịch sử còn pending, không sửa kết luận Q6 cũ.

Ngày **21/10/2026 UTC+7**. **ACCEPTED_FOR_PROTOCOL** theo user “oke chốt”, sau đề xuất bốn điểm: hai loại môi trường, kiểm soát cách chạy trên Kaggle, tách gate phát triển/đo và giữ tiêu chuẩn kết quả. Branch `phase2/clinic-activity-d0-20261020`, HEAD `c4102b55a652dc8e4faa93eeada4d76cbe0753ef`.

ADR này thay yêu cầu môi trường/gate trong policy v5 và các tài liệu 04/06; không thay ADR-activity-01 về source/cache, contract, V2/generation/atomicity/rebuild/freshness/ACL. **D0 DESIGN_PROTOCOL_ACCEPTED; performance readiness NOT_READY; D1 functional PASS; D2 NOT_STARTED.** Không gọi đây là D0 full-environment PASS hoặc kết quả nghiệm thu hiệu năng.

## Bối cảnh và lý do trước đo

D1 v3 (`d1-kaggle-result-4d002a50-20261021.md`) đã chạy PostgreSQL/SQL source/cache/API/UI thật trong trial10k. Probe D0 run34de33f5 (`d0-kaggle-environment-result-34de33f5-20261021.md`) ghi trần4CPU/30GiB và mkdir cgroup con EROFS/errno30. Kết quả đó chứng minh đường cgroup hiện tại không cung cấp cách chia quota đã đề xuất; không chứng minh mọi so sánh trên Kaggle vô giá trị. Không có application performance measurement mới của activity.

Protocol trước bắt buộc quota riêng stack/generator và live full-stack proof ngay ở D0. Điều đó trộn quyết định thiết kế với nghiệm thu một runtime V2 chưa triển khai, đồng thời biến một cơ chế enforcement thành điều kiện duy nhất. Sửa trước measurement để phù hợp mục tiêu đối chứng trong môi trường thực có thể sử dụng. Không đổi vì một phương án đã thắng/thua latency; không sửa kết luận Q6.

## Hai loại môi trường được chấp nhận

| Resource class                           | Điều kiện                                                                                                                                                                   | Phạm vi kết luận                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `controlled_separate_budgets`            | Chứng minh giới hạn tổng stack gồm mọi child, generator giới hạn riêng; live profile/coverage/identity/grants đầy đủ                                                        | Workload trong các quota đã ghi nhận; không suy có máy vật lý riêng                                                                    |
| `kaggle_shared_envelope` — **đang chọn** | Stack, generator và notebook/controller dùng chung trần kernel quan sát được; same-kernel matched blocks, profile/accounting/load evidence đầy đủ; không bắt tạo cgroup con | So sánh trong Kaggle envelope/workload đó, với generator cùng máy; không claim stack có quota2CPU/8GiB riêng hay generator được cô lập |

Quota con không khả dụng là một giới hạn phải ghi của class thứ hai, không còn tự động chặn thiết kế/phát triển. Không suy quota được enforce chỉ từ UID0/affinity/flags hoặc tổng CPU/RAM đã khai báo. Không remount/sudo/escape để né giới hạn kernel Kaggle; không tự thuê EC2/cài WSL. Hai class không được trộn vào cùng một phép so sánh.

Trần4CPU/30GiB trong ZIP là **quan sát lịch sử**, chưa phải profile khóa cho các run tương lai. Proposal stack2CPU/8GiB +generator1CPU/2GiB được giữ nguyên bytes làm lịch sử của hướng enforcement, không phải cấu hình hiện áp dụng. Mỗi session mới phải đọc lại envelope và profile thực trước đo.

## Đối chứng bắt buộc trong class Kaggle

1. Một cấu hình chạy tại một thời điểm. S/C/P cùng source, source indexes, fixture/trace, live versions, auth/limiter/timeouts/pools; cùng producer/projector/audit theo ADR01. L là runtime đơn giản V1-only an toàn, không chạy binary cũ trên V2. Đổi reader không đồng nghĩa đổi ngân sách âm thầm.
2. Mọi thành viên của một path block S/C/P hoặc cost block P/L ở **cùng notebook kernel/session**, không restart kernel giữa hai vế. Giữ nguyên thứ tự ba block, repetitions, measured/warmup durations, sample gates và L-selection rule trong policy. Reset/rebuild theo trace chỉ trong trial đã guard.
3. Trước timing phải chốt session packing và profile comparison key: envelope/affinity/CPU model/architecture/live software, source/fixture/trace/harness hashes, replicas/pools và IO/background observations. Chụp profile trước/sau từng run. Khác profile không được âm thầm gộp thành một matrix matched; giữ artifact và báo môi trường không tương đương/strata còn thiếu.
4. Giữ trọn block khi phân chia nhiều notebook mới. Tổng kế hoạch17–24h vẫn là ước lượng, không yêu cầu nhồi vào một session hoặc giảm duration để vừa session. Export block đã hoàn thành; kernel chết giữa block => block incomplete, giữ raw, không nối hai nửa qua session hoặc chỉ giữ vế đẹp. Chốt quy tắc resume/replacement trước timing.
5. Thu application CPU của API, mọi worker/child, PostgreSQL children, broker/Erlang, Redis, gateway và audit. Generator và notebook/controller báo riêng; shared-cgroup totals là chỉ số chung, không đổi nhãn thành application CPU. Phải chỉ rõ short-lived/unreadable processes, sample boundary và coverage. RAM phải ghi giới hạn shared-page/double-counting nếu cộng theo process; host/cgroup memory không được gọi là RAM riêng của ứng dụng.
6. Raw generator có scheduled/dispatch/completion monotonic timestamps, arrival plan, actual offered load, dispatch lateness, requests/errors/timeouts/drops. Không thay lịch request trễ bằng một lịch nhẹ hơn rồi gọi là cùng workload. D5 phải triển khai và chốt calibration/validity rule trước timing; hiện **TO_IMPLEMENT**, không bịa đã đo generator khỏe.
7. Quan sát throttling, memory pressure, IO/background interference và unknowns trong khả năng kernel cho phép. Đo và đảo thứ tự giúp phát hiện nhiễu, không biến shared envelope thành isolation proof. Nếu nhiễu lớn hơn effect hoặc offered load không đáng tin, dùng INCONCLUSIVE/INVALID_ENVIRONMENT, không chọn riêng lượt đẹp.

## Tách gate theo chặng

| Gate                         | Nội dung                                                                                                                                                                   | Trạng thái hiện tại                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| D0 design/protocol           | Source/writer/version/fence/ACL/gateway map; metric/date/rate/admin contract; V2/rebuild ADR; S/C/P/L, resource class, ngưỡng/sample plan và policy/version/hash           | **DESIGN_PROTOCOL_ACCEPTED** theo inventory/ADR01/D1 evidence và quyết định này; không phải full environment PASS |
| Trial integration từng chặng | DB/schema/marker/queue, role/grants, version và source đúng scope trước write/test; bằng chứng thật cho transaction/replay/rebuild theo chặng                              | D1 functional đã PASS; D2+ NOT_STARTED, không mượn D1 để PASS chúng                                               |
| Performance readiness        | Fresh full trial/PID/pool/build/fixture/trace/profile; collector/evaluator/generator validity rule; session plan; policy/profile frozen trước timing và scope đo được giao | **NOT_READY**, benchmark vẫn chặn                                                                                 |
| Kết luận hiệu quả            | Đủ primary/sample/CPU/write/throughput/correctness/freshness/recovery theo policy và đúng source                                                                           | NOT_RUN; không có recommendation mới                                                                              |

D0 không phải chờ runtime V2 chưa tồn tại để chốt thiết kế. Development của chặng được giao có thể tiếp tục theo gate này; integration gate còn thiếu của chính chặng vẫn phải ghi PARTIAL/NOT_RUN. Không cần một override môi trường mới cho mỗi chỉnh source độc lập. Quyền chạy migration/trial writes, benchmark hoặc cutover vẫn theo phạm vi user giao, không suy từ một gate thiết kế.

Trước phép đo hiệu năng đầu tiên cần readiness/profile/policy được đóng băng. Các phép đo freshness/recovery có timing thực hiện trong chặng được giao, sau khi đủ readiness; kết quả đó cần cho recommendation cuối. Không đặt vòng lặp “phải có kết quả timing mới cho phép timing”. D6 vẫn yêu cầu D5 đạt và ngân sách/ủy quyền full rõ ràng. Lượt sửa protocol này không giao triển khai D2, chạy service/DB, migration hoặc bất kỳ benchmark nào.

## Giữ nguyên tiêu chuẩn và cách kết luận

Không đổi contract ngày/kỳ/rate/admin-only, DTO/source metadata/cache TTL; primary p95≤300ms, lợi≥30% và≥50ms trước cả S/C, paired regression≤10%, write/CPU/throughput gates, số mẫu/thời lượng/trace, correctness/auth/freshness/recovery hoặc fault tests. Không bỏ mandatory tests vì chuyển resource class.

Latency có thể có kết luận riêng nếu source, samples, workload và environment evidence đủ. Nếu thiếu tổng application CPU/coverage thì **TOTAL_COST_INCONCLUSIVE**: không claim CPU regression≤10% hoặc RECOMMEND_SUMMARY chỉ từ latency. Generator không phát đúng tải hoặc timing không đáng tin làm mất hiệu lực latency/throughput tương ứng. Không có số liệu thì NOT_RUN; có số liệu nhưng thiếu bằng chứng thì INCONCLUSIVE, không ép thành PASS.

Mọi recommendation phải ghi `resourceClass`, envelope, session/profile key, generator cùng máy hay riêng và các giới hạn. `RECOMMEND_SUMMARY` vẫn yêu cầu đủ mọi gate hiện có; kết quả Kaggle chỉ áp dụng cho workload/envelope đã quan sát, không chứng minh capacity production hoặc causal benefit phổ quát của CQRS.

## Policy, provenance và công việc còn lại

V5 cùng sidecar giữ exact bytes trong [preregistration-v5](preregistration-v5/acceptance.frozen.json), SHA256 `96f51be71168fb8b4f8ab78eaf09035bd12b48a2c6fbe5bc02ea9badce65d181`. Policy hiện hành chuyển **v6**, có sidecar mới và revision reason/time trước measurement; `fullyFrozen=false`, `performanceMeasurementsAllowed=false`. Chỉ khi readiness thực đủ mới preserve v6 và tạo version/profile/hash tiếp theo trước timing.

Các ZIP/manifests/notebooks D1 và probe D0 giữ nguyên; policy-at-build v4/v5 của chúng vẫn đúng lịch sử, không sửa thành v6. Source608 không đổi. Packaging/evaluator tương lai phải hiểu version/resource class và hash policy thật mới; harness v3 hiện **không chứng minh hỗ trợ protocol v6**. Không rebuild/overwrite notebook cũ để giả cập nhật provenance.

Còn lại ở D2–D5: implementation V2/L an toàn và tests đúng chặng; shared-envelope full-stack collector, generator timing/validity và evaluator; fresh live profile/guards; session/run plan và hashes. Không yêu cầu chạy lại notebook EROFS hay D1 chỉ để lặp evidence đã có. Q6 list cũ cùng policy/kết luận giữ nguyên.
