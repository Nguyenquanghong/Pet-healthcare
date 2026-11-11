# Runbook migration A: gỡ móc CQRS khỏi Clinic

Áp dụng cho migration [`20261028000100_retire_cqrs_database_hooks`](../../services/clinic/prisma/migrations/20261028000100_retire_cqrs_database_hooks/migration.sql) (commit d505faa) trên stack Compose phase 2. Migration gỡ trigger `read_rebuild_fence` trên 16 bảng cùng hàm của nó, gỡ hai trigger epoch của `appointments`, thu quyền ghi của role runtime trên ba bảng projection, và đóng các dòng outbox `clinic.appointment-read-changed.v1` chưa phát. Phần broker còn lại (queue `clinic-read-v1`) do [`retire-clinic-read-queues.mjs`](../../tools/phase2/retire-clinic-read-queues.mjs) dọn.

Đây không phải rehearsal P7 ([migration-runtime.md](migration-runtime.md)): runbook đó chuyển dữ liệu giữa các DB tổng hợp, còn đây chỉ áp một migration Prisma lên DB Clinic đang có. Các lệnh dưới đây soạn từ `docker-compose.phase2.yml` và mã nguồn, **chưa được chạy trọn vẹn trên một stack deploy**.

Trong PowerShell, đặt một lần cho cả phiên:

```powershell
function dc { docker compose --env-file .env.docker -f docker-compose.yml -f docker-compose.phase2.yml @args }
```

## Các bước

1. **Chuẩn bị.**

   - Build image mới trước khi dừng gì: `dc build clinic-api clinic-worker clinic-migrate core-billing core-outbox`. Image cũ còn khai báo queue `clinic-read-v1`, nên nếu khởi động lại bằng image cũ thì queue được tạo lại.
   - Sao lưu DB Clinic: `dc exec clinic-postgres pg_dump -U clinic -Fc nipopeto_clinic > clinic-before-migration-a.dump`. Đây là đường lùi duy nhất (xem "Rollback").

2. **Drain các writer của Clinic.** Writer là `clinic-api` (HTTP), `clinic-worker` (consumer inbox, relay outbox) và `core-billing` (gọi billing API của Clinic):
   `dc stop clinic-api clinic-worker core-billing`

   - Core và Notification vẫn chạy; route Clinic ở Core trả 503 trong lúc bảo trì (khi breaker gateway mở thì kèm `X-Service-Degraded: clinic`).
   - Kiểm không còn phiên nào đang ghi: `dc exec clinic-postgres psql -U clinic -d nipopeto_clinic -c "select pid, state, now()-xact_start as age, left(query,60) from pg_stat_activity where datname='nipopeto_clinic' and pid<>pg_backend_pid() and state<>'idle'"`. Phải rỗng. Một transaction dài trên 16 bảng sẽ chặn bước sau và kéo theo mọi phiên khác xếp hàng sau nó.

3. **Chạy migration** bằng đúng service của Compose (`npm run db:deploy -w @nipopeto/clinic`, tức `prisma migrate deploy`):
   `dc run --rm clinic-migrate`

   - Mong đợi dòng `Applying migration 20261028000100_retire_cqrs_database_hooks` và `All migrations have been successfully applied`.
   - `DROP TRIGGER` xin khóa **ACCESS EXCLUSIVE** trên từng bảng trong 16 bảng, nên phải chờ mọi phiên đang dùng bảng đó. Nếu một phiên còn sót thì migration có thể chờ lâu hoặc chết vì deadlock. File migration nằm trong một `BEGIN … COMMIT`, nên lỗi giữa chừng rollback toàn bộ, không để trạng thái nửa vời.
   - Nếu migration lỗi: tìm và dừng phiên đang giữ khóa (bước 2), rồi chạy lại. Prisma đã ghi migration này là _failed_ và sẽ từ chối `deploy` với lỗi P3009 cho tới khi đánh dấu rollback: `dc run --rm clinic-migrate npm exec --workspace @nipopeto/clinic -- prisma migrate resolve --rolled-back 20261028000100_retire_cqrs_database_hooks`, sau đó lặp lại bước 3.

4. **Dọn queue.** Chạy `--dry-run` trước (mặc định), rồi `--apply`. Script chỉ xóa queue rỗng và không có consumer; queue không tồn tại được bỏ qua; queue còn message bị từ chối và script thoát mã 1. Hàng đợi `.dlq` còn message nghĩa là có event chết chưa ai xem: xem rồi mới quyết định, không ép xóa.

   - Broker của Compose không mở cổng ra host, nên chạy script trong một container có sẵn `BROKER_URL` và `BROKER_PREFIX` (service `core-outbox`; image đã có `amqplib`):
     ```powershell
     dc run --rm --no-deps -v "${PWD}/tools/phase2:/work/tools/phase2:ro" core-outbox node tools/phase2/retire-clinic-read-queues.mjs --dry-run
     dc run --rm --no-deps -v "${PWD}/tools/phase2:/work/tools/phase2:ro" core-outbox node tools/phase2/retire-clinic-read-queues.mjs --apply
     ```
   - Với broker truy cập được từ host (project test): `$env:BROKER_URL='amqp://…'; $env:BROKER_PREFIX='nipopeto.local.v1'; npm run phase2:retire-clinic-read-queues` rồi thêm `-- --apply`. Script không có prefix mặc định: thiếu `BROKER_PREFIX` là lỗi, để không báo "không có gì để dọn" trên sai namespace.
   - Dry-run thoát 0 nghĩa là `--apply` dự kiến xóa được hết. Kết quả mong đợi sau `--apply`: bảy queue ở trạng thái `deleted` hoặc `skipped`.

5. **Khởi động lại**: `dc up -d clinic-api clinic-worker core-billing`. (`up` cũng chạy lại `clinic-migrate`; lần này không còn migration nào để áp.)

6. **Kiểm health và readiness.**
   - `dc ps`: `clinic-api` phải `healthy`; `api` vẫn `healthy`.
   - Core (cổng 5000 mở ra host): `curl http://127.0.0.1:5000/health/ready` phải 200 với `status` là `ready` (hoặc `degraded` có lý do rõ: Redis, broker, backlog outbox).
   - Clinic (không mở cổng): `dc exec clinic-api node -e "fetch('http://127.0.0.1:5101/health/ready').then(async r=>console.log(r.status,await r.text()))"`. Phải 200.
   - Metric (cần `OBSERVABILITY_TOKEN`, có sẵn trong container): `dc exec clinic-api node -e "fetch('http://127.0.0.1:5101/metrics',{headers:{'x-service-token':process.env.OBSERVABILITY_TOKEN}}).then(r=>r.text()).then(t=>console.log(t.split('\n').filter(l=>/pet_(db_available|broker_available|dlq_ready|retry_ready|queue_ready|outbox_pending)\b/.test(l)).join('\n')))"`. Mong đợi `db_available` và `broker_available` bằng 1, `dlq_ready` 0 và `outbox_pending` hạ dần về 0 khi worker bắt kịp. Ngưỡng cảnh báo tương ứng ở [`alerts.json`](alerts.json), giải thích ở [10-observability](../../docs/phase2-architecture/10-observability.md).
   - Thử một ghi thật qua giao diện hoặc API (đặt hoặc hủy một lịch hẹn) để chắc chắn không còn trigger fence nào chặn ghi (lỗi cũ là `CLINIC_READ_REBUILD_FROZEN`).

## Rollback

- **Trước khi migration xong** (lỗi hoặc dừng giữa chừng): không có gì thay đổi trong DB. Xử lý như bước 3, rồi chạy lại.
- **Sau khi migration xong** không có migration lùi. Trigger, hàm fence và quyền ghi đã bị gỡ; các dòng outbox đã đóng giữ nguyên làm dấu vết (lọc bằng `envelope->>'eventType' = 'clinic.appointment-read-changed.v1'`). Quay lại nghĩa là khôi phục file `.dump` ở bước 1 **cùng với** image cũ; mọi ghi sau bước 3 sẽ mất. Không chạy image cũ trên DB đã migrate: worker projection cũ không còn quyền ghi ba bảng của nó.
- **Queue**: chỉ queue rỗng bị xóa nên không mất message. Image cũ tự khai báo lại queue và binding khi khởi động.
- Mã projection còn trong tag `cqrs-projection-archive-20261028`.
