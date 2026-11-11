# Benchmark CQRS đã chốt — 21/10/2026

**SPECIFICATION_LOCKED / MEASUREMENTS_NOT_RUN.** Dùng **Kaggle native, shared envelope**; không cần đổi EC2 hoặc tạo cgroup con. D0 design/protocol đã chốt, D1 functional đã PASS. Phát triển D2 không phải chờ benchmark; chạy đo cần harness/profile thật ở D5 và phạm vi thực thi được giao.

Đây là cấu hình benchmark đối chứng hiệu năng tổng hợp hoạt động Clinic. Bản máy đọc được: [benchmark-plan-20261021.json](evidence/benchmark-plan-20261021.json), [hash](evidence/benchmark-plan-20261021.sha256). [Policy v9](acceptance.frozen.json) giữ nguyên toàn bộ ngưỡng/workload activity. [V8](evidence/preregistration-v8/acceptance.frozen.json) và sidecar được giữ exact bytes. `fullyFrozen=false`, `performanceMeasurementsAllowed=false` cho tới khi có build/harness/profile thật; khóa thiết kế không phải kết quả chạy.

## 1. Ba câu hỏi, ba kết quả

| Phép đo                             | Đối chứng            | Chứng minh được gì?                                                                           | Ưu tiên                                             |
| ----------------------------------- | -------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **CQRS danh sách**                  | O / A / B            | Projection giúp đọc tốt hơn SQL cùng bản mới không; bản CQRS có tốt hơn bản trước CQRS không? | **Bài chính để trình bày với thầy về CQRS hiện có** |
| **Hồi quy nghiệp vụ qua phiên bản** | M / O / R            | Nghiệp vụ chung có hồi quy sau tách module và thêm tính năng/CQRS không?                      | Bắt buộc trước kết luận hiệu quả toàn hệ thống      |
| **Activity mới**                    | S / C / P, rồi P / L | Summary có đáng dùng hơn SQL trực tiếp/cache, sau khi tính chi phí duy trì không?             | Sau khi D2–D5 triển khai xong                       |

M=`48d01c3c95d136f808b846a66a75fe08aacd92be` trước tách module, từ ZIP nipopeto; O=`3e88d7e57fbf4f74da363d320f286244237a4389` đã tách/tối ưu request, trước CQRS. Review M (`evidence/monolith-nipopeto-20261021.md`) đã có, không cần user tìm lại notebook để xác định baseline.

**Không so trực tiếp các số p95 từ những ZIP cũ khác workload/session.** Chúng vẫn là bằng chứng lịch sử hợp lệ trong phạm vi đã ghi. Muốn công bố phần trăm cải thiện mới phải chạy nguồn đã pin với cùng workload/fixture/profile. M/O không có endpoint activity: ghi N/A cho endpoint đó.

## 2. Bài chính CQRS danh sách: O / A / B

Để đánh giá đúng CQRS đã triển khai, dùng **snapshot V1 được lưu trong source bundle Q6 v9**, không dùng binary đó trên V2 tương lai. Bundle SHA256 `2b3d7c9c3e94980386dec3e5900198f9e6e6fd7c35d80cac9146709b47bb9037`, AB source-tree SHA256 `cd52a5bd4c5c75eaf820ac1971b2b3776a28fdd615b53048254ac6bb8f7432ec`. Manifest và danh sách file trong bundle là identity của dirty snapshot, không chỉ HEAD. Pin/hash lại actual Linux builds và mọi harness overlay trước đo.

| Cấu hình | Reader danh sách                       | Thành phần nền                                  |
| -------- | -------------------------------------- | ----------------------------------------------- |
| O        | SQL authoritative, source O trước CQRS | Đúng các thành phần bản O cần                   |
| A        | SQL authoritative, snapshot CQRS V1    | Producer/projector chạy, shadow tắt             |
| B        | Projection, **cùng build với A**       | Giống A; unbilled vẫn authoritative làm control |

A/B cùng fixture, source indexes, pools, gateway/auth/limiter/timeouts và nền bảo đảm freshness. O giữ source/schema của bản trước CQRS; khác biệt index/auth/admission phải công khai và tính chi phí. Mỗi cấu hình có DB/schema/queue/process trial riêng đúng phiên bản; chỉ một cấu hình chạy trong measured window.

Đây là **nghiên cứu matched mới** `cqrs-list-matched-kaggle-v1`. Dùng collector/evaluator mới hỗ trợ Kaggle shared envelope. Không chạy `RUN_FULL=True` trên notebook Q6 v9 cũ để giả đã đáp ứng protocol mới; không sửa policy/kết luận Q6 cũ (`../evidence/q6-effectiveness-20261020.md`), hiện vẫn EFFECTIVENESS_INCONCLUSIVE.

### Workload đọc

- Fixture theo `cqrs-q0-query-heavy-v2`: **100.000 lịch**, 100 owner/pet, 5.900 reservations, 100 medical records; tháng 02/2028, trạng thái/loại/ngày và ordering giữ đúng fixture đã công bố.
- 8 operation round-robin đều nhau: owner-list, admin-list, admin-search, admin-unbilled, owner-calendar, admin-calendar, admin-filter, admin-page500.
- **12 arrivals/s, concurrency 16, warmup 120s, measured 800s** mỗi run; 1.200 mẫu dự kiến/operation, tối thiểu 1.000 thành công/operation/run. Không có writes trong bài đọc này.
- Primary duy nhất: **admin-list — `GET /api/appointments?pageSize=100`**. Search/calendar/page500 là secondary; không dùng operation thắng để cứu primary thua.
- Giữ một admin, quota actor600/phút và IP3000/phút; không thêm tài khoản để né limiter.

### Workload có ghi/kiểm chi phí

- PCN gốc `pet-healthcare-pcn-v1`: **100 users**, spawn10/s, warmup30s **sau khi đủ users**, measured1.800s, think0,5–1,5s.
- Weights: pets4, appointments2, medical2, hotel1, invoices1, notifications1, appointment-write2, rescue-write1. Không thêm task activity/calendar vào mix.
- Fixture `phase1-pcn-shape-v1`: 100 owner/pet; một appointment, medical record, hotel, invoice và notification/owner. Không đổi thành fixture100k của query-heavy rồi gọi là cùng PCN.
- PCN là closed loop: **RPS là kết quả**, không phải tải cố định100RPS. Ít nhất1.000 successful writes/cấu hình để chấm write p95; báo riêng POST appointment và POST rescue, không lấy write tổng để che thiếu mẫu appointment.
- Lưu path/generation từng response, kể cả PCN; xác nhận command đã tạo đúng business state. Calendar không có trong measured PCN: ghi N/A ở đó, báo query-heavy calendar riêng.

Với **mỗi workload**, ba block cố định: **O,A,B / B,O,A / A,B,O**. A/B tương ứng thứ tự AB / BA / AB; O lần lượt ở đầu/giữa/cuối. Mọi thành viên của mỗi block cùng kernel. Tính tỷ lệ trong từng block rồi lấy median ba tỷ lệ; báo cả worst pair, không ghép run nhanh nhất của mỗi cấu hình.

### Tiêu chí và cách phát biểu với thầy

| Kết quả                                          | Điều kiện trước đo                                                                                                                                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Đường đọc projection có lợi                      | Median p95 B/A ≤0,80; không pair nào B/A >1,10                                                                                                                                                                                                            |
| **Bản CQRS tốt hơn bản trước CQRS trên primary** | Đồng thời median p95 B/O ≤0,80; không pair nào B/O >1,10                                                                                                                                                                                                  |
| Không đánh đổi quá mức                           | Write p95 và application CPU/success so O không tăng quá10%; successful throughput không giảm quá10%; PCN appointment-list và query-heavy owner/admin-calendar p95 không tăng quá10%. Chấm từng workload/pair có đủ mẫu, không lấy trung bình che hồi quy |
| Đúng và dùng được                                | Không owner leak/mismatch/lost event; healthy errors/drops=0; đúng source/generation; đủ correctness/fallback/freshness/recovery/rebuild theo policy V1                                                                                                   |

Mục tiêu B/A20% kế thừa mức lợi ích Q6 đã đăng ký. **B/O20% là tiêu chí bổ sung của nghiên cứu mới** để câu “cải thiện so trước CQRS” có ngưỡng rõ, không chỉ nhanh hơn A vốn có overhead; không sửa ngưỡng hoặc kết quả Q6 cũ. Chọn cùng20% cho hai so sánh để tránh chọn một mức dễ thắng từ số smoke đã thấy. Không đổi primary/ngưỡng sau kết quả.

Gate calendar10% của study mới dùng **query-heavy calendar thật**, còn PCN calendar vẫn N/A. Đây là phép kiểm hồi quy được đăng ký riêng trước đo, không gán calendar preflight hoặc số query-heavy vào gate PCN calendar/Q6 cũ.

Freshness V1 theo [policy CQRS gốc](../acceptance.json): p95≤2s/p99≤5s,3×1.000 mutations; recovery3×outage60s, backlog≤300/catch-up≤120s; rebuild100k≤600s, cùng các correctness/race/replay/fallback gates gốc. Không dùng mục tiêu freshness activity5s/10s thay V1. Chỉ reuse evidence đúng source/harness/phạm vi; thiếu bằng chứng thì ghi NOT_RUN, không khuyến nghị bật B.

Nếu chỉ B/A đạt: kết luận **đổi reader giúp snapshot đó**, chưa đủ kết luận bản mới nhanh hơn O. Nếu cả B/A, B/O và các gate còn lại đạt: kết luận **cải thiện trên workload/profile đã đo**. O→B vẫn gồm thay đổi index/cache/auth/admission; riêng A↔B mới tách tác động đổi reader. Ba repeats là bằng chứng thực nghiệm, không tự được gọi là “có ý nghĩa thống kê”.

## 3. So với trước tách module: common-business bridge

Chọn **M/O/R_activity**, trong đó R là actual build sau D2–D5, list vẫn authoritative, activity summary cùng toàn bộ nền cần thiết. Đây là bài `pet-healthcare-common-business-bridge-v1` mới; **không lấy B V1 ở mục2 thay R V2 tương lai**.

Giữ tám logical tasks/weights,100 users,spawn10/s,wait0,5–1,5s,warm30s sau ramp,measured1.800s. Fixture logical `phase1-pcn-shape-v1` giống nhau, ánh xạ đúng schema từng bản. Ba block **M,O,R / R,M,O / O,R,M**, cùng kernel trong mỗi block.

Chốt semantics để xử lý bản cũ chưa phân trang:

- Một logical collection task trả **toàn bộ tập owner đang được phép đọc**. Bản có pagination đi đến hết trang; latency tính từ task start đến hoàn tất, gồm mọi HTTP request/byte. Không cắt response M thành20 dòng sau khi nhận rồi giả coi hai bản cùng công việc/rẻ như nhau.
- Cùng task sequence/think-time seed cho từng owner, một user/owner. Adapters chỉ đổi wiring/representation/transport metadata tương đương, không sửa business logic/auth/cache/weights. Preflight kiểm nonempty data, ownership, counts/order/filter và mappings thật trước timing.
- Write báo riêng thời gian HTTP accepted và **terminal business completion**; không coi202 nhanh hơn201 là cùng kết quả. Observer phải nằm trong accounting; nếu không chứng minh completion tương đương thì operation và matched acceptance INCONCLUSIVE.
- Báo p50/p95/p99 **business task**, successful business operations/s và application CPU/successful business operation; kèm physical HTTP count/bytes/rate. Không so business throughput với84RPS HTTP của ZIP M cũ. Bài này không reuse PCN wire-level ở mục2.

Tối thiểu1.000 successful samples/operation/run. Với mỗi cặp M→O,O→R,M→R: median và mọi paired p95 không tăng quá10%; CPU/business-success không tăng quá10%, business throughput không giảm quá10%, healthy errors=0. Báo từng operation, lỗi và terminal-state reconciliation. **Đó là gate hồi quy của bridge mới**, không gán tên PCN01/02 PASS cho protocol đã đổi semantics.

Nếu M khác contract đến mức không ánh xạ tương đương, giữ kết quả lịch sử, ghi đúng operation/gate chưa so được; không vá bản M thành kiến trúc mới rồi gọi là baseline cũ. Thiếu bridge không chặn kết luận latency O/A/B trong đúng scope, nhưng chặn phát biểu “toàn hệ thống đã tốt hơn cả trước tách module”. M→O bao gồm tách module và các tối ưu khác, không quy riêng cho tách module.

## 4. Activity: giữ nguyên S/C/P/L đã đăng ký

- S SQL GROUP BY tối ưu hợp lý; C cùng SQL+absolute TTL5s; P daily summary V2. Cùng build/fixture/index/auth/maintenance, **list authoritative**. Đọc source current/previous trong read-only RepeatableRead; không tải100k rows lên JS làm đối chứng yếu.
- Trước timing review plain plans/statistics/index policy; Seq Scan không tự là lỗi. Nếu thêm source index phải có lý do, cùng index trong S/C/P/L và freeze build/migration trước đo, không chỉ tối ưu phía đang thua sau khi thấy kết quả.
- 100k lịch; primary30 ngày2030-09-21..2030-10-20 và kỳ trước,10 màn hình poll15s≈0,667reads/s, writes0,1/s; warm120s+measured1.800s. Giữ nguyên ba path blocks S,C,P / P,S,C / C,P,S.
- P p95≤300ms; giảm≥30% **và≥50ms** so **cả S và C**, đủ1.000 primary successes/run, paired regression≤10%. SQL/cache vốn đủ nhanh mà summary không đạt lợi ích thì chọn simple, không đổi sang stress để cứu primary.
- Sau path blocks chọn reader L theo rule trong policy (cache chỉ khi đúng/fresh và median C/S≤0,95, không pair>1,10). Ba cost blocks P,L / L,P / P,L dùng các P repeats riêng; L là cùng candidate có **V1-only capability an toàn**, không phải commit O thiếu endpoint.
- Write/CPU/throughput≤10% regression; giữ write supplement4×5.000s, sample plan/freshness3×1.000/backend5s-10s/UI20s/recovery3×60s đúng [policy](acceptance.frozen.json). Không giảm ngưỡng/số mẫu vì bài chạy lâu.

Activity latency có thể báo riêng. Chỉ RECOMMEND_SUMMARY khi mọi gate correctness/auth/freshness/recovery/benefit/total-cost và required historical bridge đầy đủ. **Kết quả này không sửa kết luận Q6 list.** Không bật projected list để freshness dashboard chạy.

## 5. Kaggle: cách chạy đã quyết định

Không cần quota con, không lặp notebook EROFS/D1. Mỗi session mới đo lại CPU model/architecture, quota/affinity/memory envelope, live versions, process/child/role/pool, schema/marker/grants và build/fixture/trace/harness/policy hashes. Không lấy observation4CPU/30GiB cũ làm profile mới. Cùng toolchain cho các vế; nếu một source không tương thích phải ghi build issue trước đo, không âm thầm nâng major hoặc bỏ component.

**Run tuần tự, trọn matched block trong cùng notebook/kernel**. Có thể dùng notebook mới cho block tiếp theo, export raw trước khi rời session. Comparison key gồm envelope/CPU/software/replicas/pools và toàn bộ manifests/hashes; khác key thì tách strata, không pool ba block khác profile thành một kết luận matched. Mỗi stratum cần đủ ba block để nghiệm thu.

Generator rule đã khóa (collector còn phải viết):

- Open loop: calibration120s ở2×arrival rate trên no-op/loopback ngoài ứng dụng với collector/observer tương ứng. Không dùng calibration để giảm tải ứng dụng đã chốt. Lưu scheduled/dispatch/completion monotonic timestamps và mọi outcome.
- Calibration và measured: dispatch lateness p99≤100ms,max≤1s; healthy generator drops=0, planned count không đổi,≥99% arrivals dispatch trong measured window. Báo actual load và cả dispatch→completion, scheduled→completion; **scheduled latency** dùng chấm để không giấu delay phát tải.
- PCN closed loop không ép cùng RPS:100 users suốt measured window, ghi per-user task/wait/start/completion và event-loop probe10Hz, delay cùng ngưỡng100ms/1s. Không tính ramp/warmup vào measured.
- Đây là giới hạn để phát hiện generator không giữ được lịch, không phải cam kết isolation. Fail/missing timestamps/population => INVALID_ENVIRONMENT hoặc INCONCLUSIVE phần latency/throughput, giữ raw. Không đổi lịch trễ thành workload nhẹ hơn.

Application CPU gồm mọi API/worker/PG children/broker/Redis/gateway/audit; generator/controller và shared cgroup total báo riêng. CPU chỉ lấy interval trong measured, process birth/exit/boundary có ledger; thiếu coverage/unreadable CPU => **TOTAL_COST_INCONCLUSIVE**, không tự gán CPU gate PASS. RAM báo rõ RSS shared-page double counting; root memory không phải RAM riêng stack.

Block bị ngắt/invalid environment: giữ raw, cho **tối đa một replacement nguyên block**, first valid complete block được dùng. Không thay block hợp lệ chỉ vì chậm/thua. Replacement vẫn invalid thì dừng study còn thiếu. Correctness/application failure dừng sửa nguyên nhân, không coi là nhiễu để retry. Mọi attempt xuất trong report.

Mọi write/migration/seed/rebuild chỉ trên disposable trial đã guard DB/schema/marker/role/queue, đúng source version; không DB chính, không mixed consumers/V1 binary trên V2. Chốt protocol không tự cho phép chạy service hoặc full.

## 6. Số lượt, thời gian và thứ tự thực hiện

| Hạng mục              | Load runs                                                  | Thời gian warmup/ramp+measured tính được | Dự trù wall-clock                                         |
| --------------------- | ---------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------- |
| CQRS list query-heavy | 9                                                          | 9×920s =2h18                             | Gộp hàng dưới                                             |
| CQRS list PCN         | 9                                                          | 9×1.840s =4h36                           | **8–10h cho hai workload**, gồm setup/export/reset dự trù |
| M/O/R business bridge | 9                                                          | 9×1.840s =4h36                           | **6–8h** riêng                                            |
| Activity              | 9 path+6 cost+4 write supplement, freshness/recovery riêng | Khoảng15h tối thiểu                      | **17–24h** riêng, giữ estimate cũ                         |

Thời gian list/bridge chưa gồm công viết harness/adapters và drills correctness/freshness/recovery/rebuild nếu chưa có evidence phù hợp. Tổng ba nhóm load/setup dự trù31–42h, **không phải một notebook Run All**; phân chia ở ranh giới block, không giảm duration để vừa một session. Không cần chạy cả ba mới được báo riêng kết quả bài chính O/A/B. Không đưa forecast thành thời gian thực đo hoặc cam kết hardware capacity.

Thứ tự công việc đã chốt:

1. Tiếp tục **D2 source/migration files/projector + tests** giữ source default/list authoritative; không chờ child-cgroup hoặc benchmark mới để viết source.
2. D3/D4/D5 hoàn thiện summary, rebuild/freshness/reader và collector/evaluator/notebook mới. D5 kiểm parity/guards và tạo exact manifests/profile, smoke trước full. Có thể chuẩn bị/chạy study list V1 theo nhiệm vụ đo riêng; không cần đợi V2 để trả lời CQRS list.
3. Trước timing preserve policy hiện hành, tạo revision/profile/hash đầy đủ; chạy đúng study được giao và đủ readiness. Không tái mở lựa chọn Kaggle/EC2 hay ngưỡng đã chốt vì thiếu code/profile.
4. Báo cáo cho thầy theo bảng kết quả dưới; giữ các outcome không đạt và ghi lý do chọn SQL/cache/projection.

| Claim cần báo                | Bằng chứng bắt buộc                                                                                                      | Hiện tại                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| CQRS list nhanh hơn pre-CQRS | O/A/B matched full, primary ratios, per-operation raw, errors, CPU/write/throughput và V1 correctness/freshness/recovery | **NOT_RUN**; Q6 cũ vẫn INCONCLUSIVE                              |
| Không hồi quy so trước tách  | M/O/R business bridge parity và matched runs                                                                             | **NOT_RUN**; ZIP M chỉ historical observations                   |
| Activity nên dùng summary    | S/C/P + P/L, các gate policy và bridge tương ứng actual R                                                                | **NOT_RUN**; D1 SQL/cache functional đã PASS, V2 chưa triển khai |

Kết luận hợp lệ gồm WIN_IN_SCOPE / NO_MEANINGFUL_BENEFIT / REGRESSION / INCONCLUSIVE, kèm mẫu/profile/giới hạn. **Protocol tạo khả năng chứng minh hiệu quả nếu có; không bảo đảm CQRS sẽ thắng.**

## 7. Phạm vi lần chốt này

Chỉ tài liệu/policy/plan và kiểm artifact/hash/provenance/preservation. Đã kiểm cwd/branch/HEAD/status; không có AGENTS áp dụng. Đã đọc policy/source/harness/fixture và source bundle dưới dạng dữ liệu; không execute attachment. Source608, runtime/migrations/lockfiles/notebooks/ZIP/evidence cũ bảo toàn.

Lệnh thực chạy để tạo revision và kiểm bàn giao:

```powershell
python test-results/phase2/cqrs/activity/benchmark-final-20261021/prepare.py
python test-results/phase2/cqrs/activity/benchmark-final-20261021/update_docs.py
python test-results/phase2/cqrs/activity/benchmark-final-20261021/finalize.py
```

Kết quả/lệnh đầy đủ và giới hạn: [finalization manifest](evidence/benchmark-finalization-20261021.json), [hash](evidence/benchmark-finalization-20261021.sha256). Các lệnh đọc source/Git/JSON/ZIP/rg phục vụ audit không phải application tests. **NOT_RUN:** app suites/build, DB/service/notebook, integration mới, timing/load/full benchmark. Không commit/push/xóa file/agent phụ. D0 DESIGN_PROTOCOL_ACCEPTED, D1 PASS đúng scope cũ, D2 NOT_STARTED; source development là bước tiếp theo, performance readiness vẫn NOT_READY.
