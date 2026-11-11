# ADR-CQRS-04 — Rebuild có freeze và rollback authoritative

Ngày 14/10/2026, cập nhật 15/10. **IMPLEMENTED Q3 trong trial**; evidence rebuild/shadow (`q3-rebuild-shadow.md`). Chưa live cutover hoặc phục vụ projected query cho người dùng.

MVP rebuild từ source hiện tại trong cùng Clinic DB dưới freeze, không replay outbox làm lịch sử đầy đủ và không dùng MAX(outbox ID), timestamp hoặc UUID làm commit watermark. Tool phải dry-run và kiểm run UUID/DB/host/queue/Redis namespace/marker khớp manifest trước mutation. Không lấy credential/DB chính từ `.env.docker`.

Trên trial: chuyển đọc authoritative; chặn tất cả Clinic API writers trong inventory (`writer-query-inventory.md`), Core billing mới, import/fixture tools; dừng billing inbox và HTTP reconcile sau drain transaction. Directory stream không quyết định ACL, nhưng phải ổn định trong snapshot/search reconciliation. Dừng projector cũ sau drain, không purge broker/outbox. Không xác minh freeze được thì abort.

Tạo generation BUILDING mới, backfill registry thiếu và rows theo keyset, không OFFSET trên source đang đổi; checkpoint chỉ tiến độ copy. Batch/resume idempotent; interruption giữ BUILDING. Đối soát toàn ID/version/DTO hash/tombstone, owner scope/counts/list/calendar/billing flags dưới dữ liệu đứng yên rồi mới READY.

Switch control pointer bằng compare-and-set/transaction khi source còn freeze và projector dừng. Restart projector với inbox namespace generation mới; late/duplicate event hydrate source hiện tại không hạ version. Mở writers theo thứ tự rehearsal, kiểm catch-up/queue/DLQ/freshness rồi mới có thể phục vụ projection sau Q2–Q6 gates.

Lỗi bất kỳ giữ hoặc chuyển authoritative; không xóa schema, restore source từ read rows hoặc undo command đã commit. Generation cũ đã ngừng cập nhật không được tự phục vụ trở lại. Registry/tombstone/outbox và artifacts chỉ dọn theo allowlist/retention đã giao riêng. Không thực hiện Q7 hoặc live migration từ yêu cầu Q0–Q1. Runbook: 05-operations-and-rollback.md (`../05-operations-and-rollback.md`).

Q3 dùng durable `ReadRebuildRun` và schema-scoped advisory lock trên guarded trial: writer shared transaction lock, operator exclusive session lock/pool1; trigger chặn ghi trong freeze. Table fence chờ reader drain tối đa 1000ms; quá hạn thì giữ durable fence và báo lỗi. Crash giữ checkpoint/fence, resume kiểm fingerprint; drift phải inspect hoặc explicit abort. Runtime chỉ SELECT metadata, không tự tạo/chuyển fence. Miễn trừ operator cần cả PID và exclusive lock, không dựa chỉ PID.

Full row reconciliation và 164 ca query matrix được kiểm trên trial; rebuild100k dùng keyset batch500. Pair shadow query cùng RepeatableRead snapshot, budget tối đa1 sample/replica, statement200ms/transaction1000ms/admission50ms, sample mỗi20 request mặc định. Không thêm HTTP Core cho shadow; chỉ dùng DTO request đã xác minh. Log hash/count, lag không được tính thành PASS và cần so lại sau catch-up. Mode projection vẫn đóng tới Q4–Q6.
