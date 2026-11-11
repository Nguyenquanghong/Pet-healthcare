# ADR-activity-01 — Contract activity và invariant projection V2

**Protocol hiện hành21/10:** [ADR-activity-02](adr-activity-02.md) và policy v6 thay phần bắt buộc quota riêng/gate D0 environment bằng hai resource class, chọn Kaggle shared envelope và tách design acceptance/performance readiness. Contract/V2/invariants của ADR này giữ nguyên. Các nhãn v5/PARTIAL/NOT_RUN phía dưới giữ mốc lịch sử; không phải yêu cầu chuyển EC2 hoặc lặp notebook D1.

**Execution mới nhất21/10:** trial v3 run4d002a50 (`d1-kaggle-result-4d002a50-20261021.md`) đóng đủ PG/query-plan/warm-cache-role/browser-gateway coverage: **D1 PASS_IN_FUNCTIONAL_SCOPE_10K_SOURCE_CACHED_API_UI**. D0 vẫn PARTIAL_ENVIRONMENT và benchmark bị chặn. Không đổi quyết định source default, contract, policy hoặc triển khai V2; các trạng thái PARTIAL/NOT_RUN phía dưới giữ mốc của các addendum trước.

**Evidence cập nhật21/10:** trial Kaggle ab923b0f (`d1-kaggle-result-ab923b0f-20261021.md`) đạt PG/API-gateway functional trong scope10k, không phải performance/full deployment. D1 overall PARTIAL_REMAINING_COVERAGE, D0 PARTIAL_ENVIRONMENT; các quyết định source default/V2 chưa triển khai và gate đo không đổi. Phần mô tả local/NOT_RUN bên dưới giữ mốc của ADR trước trial.

Ngày **20/10/2026**, addendum **21/10/2026**. **ACCEPTED_FOR_DESIGN / D1_SQL_CACHE_IMPLEMENTED / V2_NOT_IMPLEMENTED**. D0 **PARTIAL_ENVIRONMENT**, D1 **IMPLEMENTED_PARTIAL**. Dựa source checkpoint `c4102b55a652dc8e4faa93eeada4d76cbe0753ef`, inventory (`d0-inventory.md`) và [manifest D0](d0-source-manifest.json); chưa có performance measurement mới. User override cho phép phát triển D1 sớm; evidence D1 (`d1-source-cache-20261021.md`) và [manifest mới](d1-development-manifest.json) ghi local validation, không thay gate môi trường/PG thật.

## 1. Quyết định và điều kiện tiếp tục

Làm D1 source SQL + bounded cache trước, cùng một contract admin activity. Tiếp tục thử event summary V2 theo D2–D5 vì đã có revision/outbox/inbox/generation/fence hữu ích, **chưa chọn summary làm default**. Đánh giá S/C/P để so đường đọc và L để so tổng chi phí. Nếu SQL/cache đáp ứng và P không đủ lợi ích hoặc chi phí vượt gate, chọn phương án đơn giản; thiếu evidence thì INCONCLUSIVE. Default activity source; list authoritative.

Lựa chọn loại: không dùng Event Sourcing, DB/service mới hoặc refresh định kỳ trong MVP. Periodic refresh là phương án khác nếu sau này chấp nhận stale phút, cần publication protocol và policy riêng. Không đẩy summary vào command transaction để né worker rồi đánh giá như phương án async hiện tại. Không thay kết luận/policy/endpoint Q6 danh sách cũ.

## 2. Contract chuẩn cho S/C/P/L

Route **GET `/api/dashboard/clinic/activity`**, đặt dưới prefix Core proxy/Nginx example đã kiểm trên source. Handler và OpenAPI đã thêm ở D1; HTTP direct+Core proxy local đã kiểm với DB doubles, Nginx/public gateway trial chưa chạy. Chỉ support split Clinic; không âm thầm đọc legacy/Core để giả endpoint hoạt động.

- Chỉ nhận `from`, `to` bắt buộc YYYY-MM-DD và `groupBy=day|month` (default day), `category=all|clinic|spa` (default all). Reject unknown keys, repeated/array/object values, whitespace dư, ngày không tồn tại, from>to, >366 ngày inclusive bằng422. Chấp nhận năm1000..9999 nếu cả kỳ trước cũng biểu diễn được trong phạm vi đó; không parse theo locale host.
- Ngày nghiệp vụ Asia/Ho_Chi_Minh, dựa SQL DATE appointmentDate, không createdAt. `from/to` inclusive, SQL range bound bằng parameter; trước đó là cùng số ngày lịch liền kề: prev.to=from−1 ngày, prev.from=from−N ngày. Month bucket cắt theo tháng lịch và clip đầu/cuối kỳ. Fill0 mọi ngày/tháng rỗng theo thứ tự tăng.
- Total = appointments **đang tồn tại** có ngày hẹn trong kỳ/filter, gồm cancelled/no_show. Status là trạng thái hiện tại, không history tại cuối kỳ. Reschedule chuyển contribution sang ngày mới, undo phản ánh trạng thái sau undo; hai kỳ cũ có thể đổi sau thao tác hiện tại.
- Status keys đầy đủ: pending, confirmed, checked_in, in_progress, completed, cancelled, no_show. Type enum đủ10: general_checkup, vaccination, dental, dermatology, surgery, hotel_consultation, spa_bath, spa_grooming, spa_combo, other. Spa=3 spa types; clinic=7 type còn lại, bao gồm hotel_consultation vì vẫn là Appointment; không lẫn HotelBooking. Nếu enum đổi phải cập nhật mapping/contract và test trước deploy.
- cancellationRate=cancelled/total, noShowRate=no_show/total, ratio[0,1]; total0→null, UI “—”. totalDelta=current−previous; totalDeltaPercent=delta/previous×100; previous0→null kể cả current0. Không làm tròn ở backend. Không thêm comparison rates ngoài DTO đã định.
- DTO business theo mục3 của 02: period/previousPeriod; current total/byStatus/rates/byType/buckets; previous total/byStatus/rates; comparison totalDelta/totalDeltaPercent. byType theo thứ tự enum đủ10, type bị category loại có total0; buckets chứa from/to/total/byStatus đầy đủ. S/C/P/L business payload phải bằng nhau khi snapshot/catch-up tương đương.
- Count/counter BigInt SQL, check integer0..MAX_SAFE_INTEGER trước serialize cả bucket/total/type/status; overflow fail response503 có reason chẩn đoán, không âm thầm Number(bigint). Delta count có thể âm nhưng cũng phải safe integer.
- Current và previous trong **một RepeatableRead read-only snapshot**. Cache lưu toàn DTO business cùng snapshot; fallback cả response, không current summary/previous source. Không dùng directory/medical/billing joins làm yếu baseline khi semantics không cần chúng.

Metadata: source=`source|cached|summary`, generation chỉ có khi summary (source/cache=null), generatedAt là response time, cacheComputedAt từ snapshot-start khi cached, freshness.state=`current|within-policy|unknown`, checkedAt/observedLagMs theo evidence thật; degraded/reason rõ. Source `current` nghĩa authoritative snapshot, không phải không có commit sau snapshot. Cache hit không được tự cập nhật cacheComputedAt; generatedAt không là watermark. Header HTTP `Cache-Control: no-store`; source/generation headers dùng existing forwarded names nếu thêm, body metadata là contract cho mọi entrypoint.

Auth mỗi request trước cache/selector: JWT hợp lệ + Core current actor validation như middleware hiện có, rồi actor.role===admin. Chưa đăng nhập401; role khác hoặc role đã thay đổi403; Core auth service unavailable503. Không cache authorization, không dựa summary/DirectoryProjection xác định quyền; không fallback vượt401/403. Owner/staff/doctor không xem activity qua direct Clinic, proxy hay giả query/header. Không nhận ownerId/clinicId/doctorId/q/status/servingMode từ client.

## 3. UI và drilldown MVP

Thêm section vào AdminDashboardPage, không thay dashboard Core/hotel/notification. Default30 ngày đến Vietnam today; preset12 tháng là từ đầu tháng của11 tháng trước đến hôm nay. Hiển thị kỳ đối chiếu thật và nhãn “ngày hẹn / trạng thái hiện tại”. Không hiện queue/generation/SQL cho người dùng.

Activity một poll15s khi visible/online, dừng/clear khi session/logout, một in-flight/key, abort/filter sequence guard theo pattern useApiQuery. Hook hiện có jitter/backoff; giữ behavior hữu ích và đo UI target thực, không hứa mọi màn hình cập nhật trong5s. Không thêm activity vào useDashboard(5000) hoặc nhân poll cũ vô tình; poll hiện hữu báo là background chung khi đo UI.

Chốt **drilldown theo ngày** cho MVP: click daily bucket hoặc daily status mở `/admin/appointments` với date và category tương đương (clinic→medical, spa→spa, all→omit), status nếu đã chọn, dùng authoritative consistency. D1 bổ sung đọc/validate URL filter vì UI hiện giữ state cục bộ. Total toàn kỳ/month bucket/byType không link sang list mất lọc; nếu cần click, UI cho chọn một ngày và ghi rõ phạm vi trước mở list. Không thêm from/to/type vào list trong D1 chỉ để ép mọi ô click được. Danh sách có thể mới hơn summary; giải thích “Số liệu tổng hợp đang cập nhật”.

## 4. V2 dùng cùng generation

`ReadProjectionGeneration.schemaVersion=2` biểu thị **rows và daily summary cùng invariant**, không đổi shape row tùy tiện. Tạo UUID generation mới; không sửa in-place V1 ACTIVE thành2. PK summary `(generation,appointmentDate,type,status)`, appointmentCount BigInt≥0 SQL CHECK, FK generation RESTRICT; giữ zero rows, normalize khi compare. Không ownerId/notes/PII/billing trong summary. PK generation/date đủ khởi điểm, thêm index chỉ sau EXPLAIN fixture.

Giữ một active pointer `ReadProjectionControl('appointments')`. Thêm `ClinicActivityControl` singleton operator-owned với mode source/cached/summary default source, trỏ **gián tiếp** qua pointer appointments; không pointer riêng. V1=row-only, V2=row+summary. Code mới hiểu có chủ ý V1/V2; helper supported versions nhỏ. List V2 compatibility regression bắt buộc nhưng serving list vẫn authoritative; activity summary chỉ ACTIVE verified V2 non-frozen có evidence đủ.

Projection schemaVersion2 **khác** envelope/event schemaVersion1. Giữ event type/payload hiện tại. Giữ transport queue `<prefix>.clinic-read-v1` và ConsumerName allowlist hiện tại vì event unchanged; inbox generation V2=`clinic-read-v2:<generation>`. Capability `projectionVersions=[1,2]` và summary-enabled phải xuất ở startup/manifest để nhận diện binary; tên queue hoặc broker consumerCount không chứng minh capability.

## 5. Transaction counter và concurrency

Notification có thể mang version2 nhưng hydrate source7; không apply event như delta/history. Trong cùng ReadCommitted transaction: registry lock → control lock → hydrate latest source/version/tombstone → các generation theo ID → inbox → đọc **old full contribution** → row+summary. Old row.sourceVersion>source revision fail; same version không đổi count; source missing/registry mismatch fail, không ACK bỏ.

Contribution old nếu live row là1 vào date/type/status, new nếu source còn tồn tại là1 vào key mới, deleted→none. Gộp negative/positive, bỏ0; note/billing/doctor change không chạm counter khi key không đổi nhưng row/version/inbox vẫn cập nhật. Sort toàn bộ touched keys `(generation,date,type,status)` giống nhau cho mọi writer để tránh A→B/B→A khóa ngược. Atomic UPDATE decrement có guard count đủ; atomic upsert increment. Missing negative bucket/underflow/check fail rollback, không clamp0.

**Row + summary + generation inbox commit cùng transaction**; ACK chỉ sau commit. Crash/retry/duplicate eventId/khác eventId cùng state không double count. Deadlock/serialization retry toàn transaction bằng bounded transport replay hiện hữu (tối đa2 retry trước DLQ); không retry nửa transaction hoặc nuốt lỗi summary. Giữ pool/prefetch trước khi đo; lock contention global epoch/counter tính vào command p95 và CPU.

## 6. Worker cutover có dừng, rebuild frozen

Không mixed binary V1/V2 trên queue: worker V1 hiện chỉ target V1 và có thể ACK event mà chưa cập nhật V2. Deploy compatibility code/migration additive trong **trial**, activity về source và list authoritative; stop/drain API/medical/billing/import writers và Clinic/read consumers theo guard, ghi identities/version cùng ready/unacked counts. Giữ backlog để replay, không purge. Broker consumerCount0 là bước kiểm drain, không thay kiểm binary capability lúc restart.

Operator private connection_limit1 claim advisory lock+durable fence; drain tables, fingerprint/checkpoint như hiện có. Thêm summary/activity control vào fence/ACL/drain list. Backfill **read rows**, sau đó build summary canonical `GROUP BY` từ generation rows với replacement của generation BUILDING trong transaction (operator), không vừa increment per-row vừa GROUP BY cộng thêm. Crash trước READY có thể lặp replacement summary, không resume cộng counter từ checkpoint không đủ thông tin.

Verify source↔rows full allowlist/version và rows↔summary từng key (zero normalize), kiểm sum/diffs0; V2 READY chỉ khi đủ. Activate lặp fingerprint/reconcile trước CAS expected pointer, target ACTIVE/old RETIRED/run complete/fence false atomically. Không sử dụng cached verification bị source drift. UI có thể bị ACCESS EXCLUSIVE block, phải đo freeze, không claim online/zero downtime.

Sau switch khởi động **duy nhất binary có V2 capability**; writer resume và replay theo guard (fence còn bảo vệ đến activation). Backlog event hydrate nguồn đã backfill cùng version→delta0. Catch-up + reconciliation + evidence hợp lệ rồi mới activity summary trial. Rollback serving về source/cache; rollback binary V1 phải stop/drain và khôi phục generation/protocol V1 được verify riêng, không chạy V1 lên V2 hoặc down-migrate đang phục vụ.

## 7. Freshness tách khỏi serving danh sách

Không bật list projection để dashboard hoạt động. Tách generation evidence sampler khỏi list selector; `index.ts` phải start/close sampler khi **activity summary hoặc list projection** cần, trong budget explicit. List selector giữ env+DB mode/token/version/freshness contract cũ. Shared evidence phải gắn generation, schemaVersion và capability để V1 healthy không nâng thành V2 summary healthy.

Baseline audit registry↔rows bounded giữ cadence2s, sample timeout750ms/tx1500ms/maxWait50ms, TTL6s và lag guard5s. Thêm summary verified/reconciliation evidence: periodic rows↔summary **30s**, evidence TTL60s, 1 in-flight, statement timeout1500ms/tx2500ms/maxWait50ms, max_parallel_workers_per_gather0, dùng cùng audit pool1; chưa chạy được trong budget thì unknown/fallback và revise trước performance measurement, không tự tăng pool để PASS. Full source↔rows↔summary chạy sau rebuild, fault và catch-up ngoài measured window. Cost audit định kỳ cần trong S/C/P measured; L không có summary audit.

Counter check fail/drift, frozen, wrong generation/schema, broker unavailable/DLQ>0, old worker/capability unknown, stale/timeout/clock anomaly → summary ineligible. Không queue-empty/heartbeat/MAX(version)/MAX(projectedAt) làm proof. `changedAt` là thay đổi mới nhất của aggregate, không được gọi oldest unapplied commit chính xác. Atomicity + initial reconciliation là cơ sở dùng row evidence cho summary; periodic reconciliation chỉ phát hiện drift có cửa sổ, không bảo đảm tuyệt đối stale≤5s.

Fallback toàn response về source, tối đa2 concurrent/replica, không queue vô hạn; SQL1500ms, tx2500ms,maxWait50ms; hết budget503 Retry-After1. Metadata actual source, degraded reason; healthy P fallback200 vẫn fail source gate. 401/403/422 không fallback. Activity cache max128, 1 compute active/replica, ≤4 bounded waiters (deadline source còn lại), coalesce key gồm DB/contract/admin scope/normalized filters; absolute TTL5000ms từ snapshot-start, query quá TTL không publish. Auth không ở cache; không tái dùng sliding epoch list cache làm bằng chứng TTL freshness activity.

## 8. Quyền, đối chứng và hậu quả

API activity chỉ SELECT summary/control/evidence theo vai trò DB của nó, projector được DML summary/rows/inbox và lock registry/control đủ dùng; operator đổi pointer/mode/fence. Schema owner trial không là evidence grants production; D2 phải test role thật. Quyền DB hiện tại và danh sách P7 runtimeTables chưa bao gồm bảng mới. Summary tuyệt đối không dùng cho auth, billing, command validation, owner list hoặc arbitrary search.

S/C/P đều V2 maintenance/audit giống nhau; L là cùng source binary với config V1-only (TO IMPLEMENT), SQL/cache endpoint vẫn có, tách schema/process/queue trial. Giữ V1 infrastructure cũ còn cần và ghi chi phí; không chạy summary V2 ẩn ở L. Nếu không thực hiện an toàn không đóng total-cost gate. Chọn source/cache L theo rule trong policy trước full, không lựa chọn baseline yếu sau kết quả.

Giữ nguyên ngưỡng draft vì chưa có measured evidence cho endpoint này để đổi: p95≤300ms; P cải thiện≥30% và≥50ms so cả S/C, không pair regression>10%; write/CPU/throughput regression≤10% soL; backend freshness5s/10s, visible UI20s; recovery60s/≤300 events/≤120s/diff0; correctness/auth/errors/fallback/drop0. Những mức này là tiêu chí workstream, không kết luận endpoint hiện tại đã chậm. Sample insufficiency/no resource parity→INCONCLUSIVE/INVALID_ENVIRONMENT, không chuyển mục tiêu sang metric đẹp hơn.

Policy [frozen](../acceptance.frozen.json) hiện **chỉ khóa thresholds và contract/protocol**, chưa khóa trial resource profile. D0 PARTIAL cho tới environment checklist trong inventory/STATUS được chứng minh; performance measurement bị gate. Tại phiên D0 ban đầu không migration/runtime/test application. Addendum D1 chỉ triển khai source/cache/UI và local tests theo override; không summary, migration, worker cutover, projected list hay DB writes.
