# ADR-P13: Clinic tự kiểm quyền đường đọc danh sách bằng event (HOÃN)

Ngày 28/10/2026. Trạng thái: **DEFERRED**. đã chọn "hoãn, viết ADR" sau khi xem thiết kế chi tiết. Tiếp nối [ADR-P12](adr-p12-deferred-list-authorization.md). Thiết kế do agent `architect` (Opus) lập, chỉ đọc code, không sửa file.

## Bối cảnh

- **Hiện trạng sau ADR-P12.** Ba route GET `/appointments`, `/medical-records`, `/medical-records/images` chạy query trước, sau đó gọi Core **một lần** (`authorize` kèm id của trang).
- **Đây là khoản "thuế" tách service lớn nhất còn lại.** Kết quả VM 28/10 ([bridge](../bridge/README-20261028.md)): CPU phụ của H0 nằm chủ yếu ở Core, 0,27 lõi so với 0,12 của monolith.
- **Ý tưởng.** Notification đã kiểm thu hồi phiên bằng event `identity.sessions-revoked.v1`, đo được 19–30 ms ([ADR-P03](adr-p03-messaging-retry.md)). Clinic cũng đã có projection directory. Vậy Clinic có thể bỏ lời gọi Core ở đường đọc.

## Thiết kế đã cân nhắc

**Core kiểm theo thứ tự** (`backend/src/phase2/directoryApi.ts:123-136`):

1. actor đổi role → 403;
2. phiên bị thu hồi → 401 `SESSION_REVOKED`;
3. pet không tồn tại → 404;
4. sai scope → 403;
5. doctor → 422;
6. owner không tồn tại → 404.

Core trả về DTO đầy đủ của pet và owner (`:140-143`). Clinic gửi nguyên DTO đó cho frontend qua `related.pets/owners`.

**Projection hiện tại thiếu dữ liệu.** `DirectoryProjection` (`services/clinic/prisma/schema.prisma:45-59`) không có:

- role của staff;
- DTO snapshot;
- mốc thu hồi phiên.

**Chưa có tín hiệu nào cho biết projection còn mới:**

- JWT không mang version;
- header `x-clinic-min-version` đã bỏ;
- epoch `directory` ở Clinic không ai đọc;
- metric queue không nhìn thấy outbox của Core.

**Thiết kế tối thiểu để không fail-open**, gồm 8 bước, khoảng 2 ngày công:

1. Event mới `core.watermark.v1`, Core phát mỗi 500 ms. Watermark là giá trị nhỏ nhất trong ba thứ: thời điểm hiện tại, `createdAt` của dòng outbox identity/directory chưa publish, và `xact_start` của các transaction đang mở. Thành phần `xact_start` để bắt kịp một lần đổi mật khẩu chưa commit.
2. Bind `identity.sessions-revoked.v1` và `core.watermark.v1` vào **queue `clinic` có sẵn**. Không dùng queue `identity`: Notification đang consume queue đó, và nếu thêm một consumer thứ hai thì hai bên sẽ chia nhau message.
3. Ở Clinic:
   - bảng mới `SessionRevocation` và `CoreWatermark`;
   - thêm cột `role` và `snapshot JSONB` vào `DirectoryProjection`;
   - backfill các lần thu hồi đã có trước cutover.
4. Endpoint export của Core trả thêm `role`, `revokedBefore` và `snapshot`.
5. Clinic chỉ quyết định ở local khi:

   - projection đã được seed;
   - không bị chặn;
   - độ trễ ≤ 2.000 ms;
   - queue `clinic` có đúng 1 consumer, retry và DLQ rỗng.

   Khi quyết ở local, Clinic chỉ được **cho qua** hoặc **trả 401**. Mọi kết quả khác (403/404, thiếu dòng, role lệch) quay về gọi Core, để giữ thứ tự lỗi và nội dung lỗi của Core.

6. Cờ `CLINIC_LOCAL_AUTHORIZATION`, mặc định OFF. Thêm metric cho số lần cho qua, số lần trả 401 và số lần fallback.
7. Rule `arch:check` `clinic-core-calls-confined`, kèm test độ trễ thu hồi. Ngưỡng chốt trước khi đo: max ≤ 2.000 ms, p95 ≤ 500 ms.
8. Bật cờ ON, chạy hồi quy đầy đủ.

## Quyết định: hoãn

Lý do, xếp theo mức nặng:

1. **Đổi hành vi bảo mật.** nginx split đưa `/api/appointments|medical-records` **thẳng tới Clinic** (`deploy/phase2/nginx.split.conf.example:33`), không qua `currentAccount` của Core. Token bị thu hồi vì thế có thể vẫn đọc được danh sách tới 2 s, trong khi hiện nay bị chặn ngay. Test AQ-05 (`clinic.test.mjs:303-327`) phải nới từ "401 ngay" thành "401 trong 2,5 s".
2. **Thêm bản sao dữ liệu cá nhân.** DB Clinic phải giữ thêm `snapshot` có địa chỉ và `qrToken` của pet/owner, đi ngược hướng tối thiểu hóa dữ liệu.
3. **Thêm độ phức tạp vận hành.** Cần heartbeat, watermark đọc `pg_stat_activity` (chỉ thấy session cùng role), điều kiện đúng một consumer, phụ thuộc NTP giữa hai DB. DLQ không rỗng thì tắt đường local: an toàn, nhưng phải có cảnh báo.
4. **Lợi ích có trần.** Ở tải đã đo, máy chưa bão hòa (server dùng 0,56–0,65 lõi trên 7). Bỏ lời gọi Core giảm CPU và p95 cho 3 route GET, nhưng chưa có số đo; ước tính trước khi đo thì không dùng làm căn cứ.

Hoãn thì hệ thống giữ được hai bất biến đơn giản: **thu hồi phiên có hiệu lực ngay** và **Core là nguồn quyết định duy nhất về quyền**. Cái giá là mỗi đường đọc danh sách tốn một lời gọi đồng bộ, đã được giảm từ 2 xuống 1 ở ADR-P12.

## Khi nào làm lại

Chỉ làm khi có **một** trong ba điều kiện:

- (a) một lượt đo có bậc tải (study VM v2) cho thấy Core bão hòa trước Clinic ở tải cần phục vụ;
  - _Cập nhật 12/11 (K9, lượt VM v2):_ **chưa đạt.** Core nóng trước Clinic (0,85 lõi ở 400 user, 1,87 ở 800; Clinic 0,49 và 0,96) và là chỗ hẹp (nhân Core hạ p95 đọc 58% ở 800 user), nhưng không bậc nào bão hòa theo luật chốt trước: p95 đọc cao nhất 148 ms so với ngưỡng 750 ms. Chưa đo phần Core tốn cho các lời gọi `authorize` của Clinic, nên chưa biết bỏ lời gọi này giảm được bao nhiêu. Quyết định hoãn giữ nguyên.
- (b) Core phải chạy ở vùng hoặc máy khác Clinic, nên độ trễ mạng làm lời gọi đồng bộ đắt lên;
- (c) yêu cầu nghiệp vụ chấp nhận cửa sổ thu hồi ≤ 2 s và việc Clinic giữ bản sao DTO.

Khi làm, theo đúng thứ tự 8 bước ở trên, cờ mặc định OFF. Bước 1 (migration) và bước 8 (bật ON) phải có đã chốt.

## Hệ quả

- Ghép nối Clinic→Core vẫn là đồng bộ ở đường đọc. Nó được ghi rõ là đánh đổi có chủ ý, không phải thiếu sót.
- Rule `clinic-core-calls-confined` (Clinic chỉ gọi Core trong `directory.ts`, `directorySync.ts`) **vẫn đáng làm** độc lập với quyết định này. Rule giúp lời gọi đồng bộ không lan ra chỗ khác.
  - _Chú thích 7/11/2026 (K5):_ rule này đã gộp vào `service-calls-declared` (`e1dc1fa`), phủ cả ba service theo `deploy/phase2/service-calls.json`, giữ toàn bộ fixture cũ. Xem [ADR-P15](adr-p15-sync-call-cycles.md).
