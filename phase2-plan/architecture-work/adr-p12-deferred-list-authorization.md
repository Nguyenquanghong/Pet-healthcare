# ADR-P12 — Danh sách Clinic hỏi Core một lần, sau khi biết trang dữ liệu

Ngày 28/10/2026. Trạng thái: ACCEPTED (tối ưu đường đọc danh sách Clinic). Commit `0abe74f`.

## Bối cảnh

- Kết quả đo bridge M/H ([bridge/README-20261028.md](../bridge/README-20261028.md)): H chậm hơn bản monolith ở mọi thao tác (p95 4,96×); GET appointments là thao tác tệ nhất (11,9×).
- Mỗi GET danh sách ở Clinic gọi Core hai lần:

  - `authorize` trong middleware, chạy trước khi đọc dữ liệu;
  - `lookup` để lấy tên pet và chủ của trang.

  Mỗi lần gọi là một transaction RepeatableRead tương tác. Core đã chạy ở mức khoảng 0,88 lõi.

- ADR-05 yêu cầu quyền luôn được kiểm tại nguồn. Vì vậy không dùng cache có TTL, cũng không bỏ bước kiểm thu hồi phiên.

## Quyết định

1. **Authorize trì hoãn** áp dụng cho các GET đúng các đường dẫn `/appointments`, `/medical-records`, `/medical-records/images`, khi breaker đang đóng:
   - Clinic đọc DB trước.
   - Sau đó Clinic gọi **một** lần `authorize`, kèm petId ban đầu và các petId/ownerId của trang. Core trả quyết định và snapshot tên trong cùng một lần đọc.
   - Code liên quan: `DeferredDirectory` và `failClosed` ở `services/clinic/src/infrastructure/core/directory.ts`; `authorizedRead` ở `http/respond.ts`; cổng ở `pep` (`http/scope.ts`), khai bằng `deferred: true` trên route ([ADR-P04](adr-p04-clinic-route-scope.md)).
2. **Lỗi từ Core được ưu tiên** hơn lỗi local:
   - Error handler phải settle trước khi trả lỗi.
   - Một response 2xx mà chưa settle thì đổi thành 503 (fail-closed).
   - Các trường hợp sau vẫn đi đường cũ (authorize trước): đường ghi, route có id, `/calendar`, HEAD, và khi breaker không đóng.
3. **Gom query thành batch**, giữ nguyên snapshot RepeatableRead:
   - Directory handler ở Core: không có id nào thì chỉ chạy một `findUnique`.
   - Danh sách appointments không có `q`: groupBy, count, page và projection gom vào cùng một batch.
4. Fitness rule `deferred-reads-via-authorized-read` bảo đảm cả ba route đều đi qua `authorizedRead`. Từ K2 rule đọc registry route và cổng trong `http/scope.ts`: đúng 3 path, chỉ GET, cổng là một `if` nối đủ bốn vế bằng `&&` (GET, `route.deferred`, đúng path, breaker đóng), có `failClosed`, và `mountRoutes` gắn `pep`.

## Đánh đổi

- Token đã bị thu hồi, hoặc tài khoản đã đổi role nhưng chữ ký vẫn hợp lệ, giờ tốn một lần đọc DB Clinic trước khi nhận 401/403. Không có dữ liệu nào lọt ra; phần chặn sớm chỉ còn breaker và limiter ở gateway.
- Các header đọc (`X-Clinic-Read-*`) được đặt trước khi Core trả lời, nên vẫn xuất hiện trên response 401/403/503. Đây là metadata, không có dòng dữ liệu nào.
- Thứ tự owners do Core trả về đổi theo thứ tự id được yêu cầu. `RequestDirectory.lookup` tự sắp xếp lại, nên không có ai bị ảnh hưởng.
- Fitness rule chỉ kiểm theo chữ trong source: một handler gọi `res.json` rồi mới gọi `authorizedRead` vẫn qua được. Khi đó chặn fail-closed ở bước 2 là lớp đỡ cuối.

## Bằng chứng

- `npm test` 104/104 (có unit mới `backend/tests/directory-api.test.mjs`: thứ tự kiểm, so sánh với logic cũ, query plan).
- `arch:check` 10/10; `directory-cache` 8/8 (1 lần gọi Core cho mỗi GET danh sách; bảng 3 route × 7 ca).
- `phase2:test:clinic` 15/15 (ca AQ-05 mới: token bị thu hồi → 401 trên cả ba danh sách; owner A dùng petId của owner B → 403).
- integration 16/16, resilience 18/18, notification-runtime 14/14, billing 12/12, E2E 18/18.
- `code-reviewer` (Opus): PASS, không có lỗi nghiêm trọng.
- **Hiệu quả đo trên VM FPT (28/10, study `bridge-m-h-vm-v1`, [kết quả](../bridge/README-20261028.md#kết-quả-vm-2810-benchmarksphase2resultsbridge-vm-v1)):** H1 (`2841d1b`) so với H0 (`e0e8937`, trước B+D), cùng VM, cùng tải, thứ tự cân bằng, hai agent tính lại độc lập khớp nhau:
  - GET appointments p95 **0,603** (hai cặp 0,600 và 0,606); p95 toàn bộ 0,868; CPU mỗi request 0,884; RAM 0,988.
  - CPU của process Core giảm từ 0,272 và 0,277 lõi xuống 0,221 và 0,225 lõi, khoảng 70–72% mức giảm CPU tổng. Phù hợp với việc mỗi GET danh sách còn một lời gọi Core thay vì hai.
  - **Không quy riêng cho ADR này:** H1/H0 gộp B+D, gỡ CQRS (`be2267b`), migration A (`d505faa`) và mọi thay đổi giữa hai commit; phép đo không tách riêng được. CPU/request cách ngưỡng 0,9 khoảng 1,8%, cùng cỡ độ lệch 1–5% giữa hai lượt của cùng một cấu hình.
  - Trong ba route trì hoãn, chỉ `/appointments` cải thiện rõ. `GET /medical-records?petId=` (operation "GET medical by pet") có p95 0,984 (hai cặp 0,961 và 1,008): tương đương, không thấy lợi ích đo được. `/medical-records/images` không có trong workload PCN nên chưa có số đo.
  - Chưa giải thích: POST rescue report ở H1 chậm hơn H0 (p95 1,165; p50 không đổi). Route này không đi qua đường trì hoãn của ADR; xem mục "Tiếp theo" của README bridge.
  - Trên VM, Core chỉ dùng 0,22–0,28 lõi, nên lập luận "Core ở mức khoảng 0,88 lõi" ở mục Bối cảnh là số của Kaggle, không phải của VM.
