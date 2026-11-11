# ADR-AQ09-R — Ảnh y tế: xóa có thời hạn giữ, khôi phục và nhật ký không sửa được

Ngày 23/10/2026. Trạng thái: ACCEPTED (user duyệt đề xuất: giữ 30 ngày rồi xóa hẳn). Bổ sung cho [ADR AQ-09](../cqrs/evidence/adr-aq09-medical-images.md) (Claim Check + Valet Key).

## Bối cảnh

- Sau Claim Check, xóa ảnh là xóa hẳn: dòng DB mất ngay và object bị xóa ngay qua `blob_cleanup`. Xóa nhầm không khôi phục được, và không có dấu vết ai xóa tài liệu y tế nào.
- Verification của AQ-09 yêu cầu "delete/retention and restore tests". Review gốc dặn không thêm soft-delete vĩnh viễn.

## Quyết định

1. **Tombstone có thời hạn.** Xóa thì đặt `deleted_at` và `deleted_by` trên `medical_images`.
   - Mọi danh sách và số đếm bỏ qua tombstone, nên không ký URL mới cho ảnh đã xóa. URL đã phát trước đó vẫn dùng được đến hết hạn ký (tối đa 5 phút).
   - Trong cùng transaction: hàng chờ `blob_cleanup` của object được hẹn chạy tại `deleted_at + MEDICAL_IMAGE_RETENTION_DAYS` (mặc định 30, cho phép 1–3650; giá trị sai thì Clinic dừng ngay khi khởi động), và một dòng nhật ký được ghi.
2. **Khôi phục.** `POST /api/medical-records/images/{id}/restore` chỉ cho admin, qua quyền mới `medical-record.restore` trong ma trận AQ-05.
   - Khôi phục được khi tombstone còn trong thời hạn: xóa `deleted_at` và `deleted_by`, hủy hàng chờ dọn, ghi nhật ký.
   - Quá hạn trả 409. Ảnh chưa bị xóa, hoặc đã bị purge, trả 404.
3. **Purge.** Worker `drainBlobCleanup` xử lý theo thứ tự:
   - Khóa dòng ảnh (`FOR UPDATE`), ghi nhật ký `purge` và xóa dòng (commit), rồi mới xóa object và hàng chờ.
   - Nếu dòng đã được khôi phục thì giữ object, chỉ bỏ hàng chờ.
   - Khôi phục cũng lấy cùng khóa dòng đó, nên mỗi lần chỉ một trong hai (khôi phục hoặc purge) thắng, và ảnh đã khôi phục không bao giờ mất object.
   - Ảnh legacy (base64 trong DB, không có object) được purge theo tuổi của `deleted_at`.
4. **Nhật ký.** Bảng `medical_image_deletions` chỉ cho thêm: delete, restore, purge, kèm `storage_key`, sha256, kích thước, pet, owner, người làm và role.
   - Trigger chặn UPDATE và DELETE, kể cả với schema owner.
   - P7 chỉ cấp INSERT và SELECT cho runtime; rule `runtime-grants-cover-every-model` buộc phải có grant này.

## Bằng chứng

- `phase2:test:clinic`, trên Core, Clinic, Postgres và bucket S3 thật:
  - Xóa: danh sách còn 0 ảnh, tombstone có người xóa, hàng chờ hẹn đúng hạn (sai số dưới 1 giây), object vẫn tải được.
  - Xóa lần hai trả 404. Staff khôi phục trả 403; doctor trả 403 với thông điệp của quyền `restore`; admin trả 204, ảnh trở lại danh sách và hàng chờ bị hủy.
  - Trong thời hạn, `drain` không làm gì. Gọi `drain` với đồng hồ sau hạn thì dòng và object đều mất, và khôi phục sau đó trả 404.
  - Nhật ký có đủ delete, restore, delete, purge, kèm sha256; sửa hoặc xóa nhật ký bị trigger chặn.
  - Race có kiểm xác định: purge đến khi một transaction khôi phục đang giữ khóa thì purge chờ, rồi thấy ảnh đã sống lại và giữ object.
  - Mutation: bỏ `FOR UPDATE` của purge trong `dist` thì ảnh vừa khôi phục bị xóa mất, test FAIL.
- Test unit:
  - `blob-cleanup.test.mjs`: dòng bị xóa trước object, ảnh đã khôi phục giữ object, ảnh legacy được purge theo tuổi, backoff giữ như cũ.
  - `medical-image-content.test.mjs`: xóa không gọi bucket; chỉ admin khôi phục được.
  - `medical-lists.test.mjs`: danh sách lọc `deletedAt: null`.
- `permission-matrix.test.mjs` có probe cho `medical-record.restore`. Trước khi thêm probe, test coverage FAIL, nghĩa là fitness function bắt được quyền mới chưa có test.
- OpenAPI của Clinic và Core có thêm thao tác restore; inventory tăng lên 72 thao tác (Clinic 26).

## Trade-off

- Trong 30 ngày, dung lượng bucket chưa được giải phóng. Nhật ký giữ vĩnh viễn, nhưng chỉ gồm metadata, không giữ nội dung ảnh.
- Purge cần worker có cấu hình bucket (`blobStoreConfigured`). Môi trường không có bucket sẽ không purge tombstone legacy cho tới khi bật bucket.
- Chưa có giao diện khôi phục: admin gọi API, hoặc thêm nút sau nếu nghiệp vụ cần.
- Bản một backend (Pha 1) vẫn xóa hẳn. Retention chỉ áp dụng cho Clinic của Pha 2, nơi sở hữu ảnh y tế.
