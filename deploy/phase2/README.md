# P1 isolated proof stack

P7 đã có rehearsal migration/backup restore/ownership/gateway/rollback trên DB
tổng hợp riêng. Xem [runbook P7](migration-runtime.md) và chạy
`npm run phase2:test:migration`; gói install/test lại cùng máy dùng
`npm run phase2:verify:clean-local`. Kết quả chốt ở
[STATUS](../../phase2-plan/STATUS.md), không phải live cutover.

Triển khai migration A (gỡ móc CQRS khỏi Clinic, dọn queue `clinic-read-v1`) trên stack
Compose: [runbook migration A](migration-a-runbook.md). Ngưỡng cảnh báo vận hành:
[`alerts.json`](alerts.json), giải thích ở
[10-observability](../../docs/phase2-architecture/10-observability.md).

Gói H có source manifest/receipt và hướng dẫn chạy không .git ở
[handoff runbook](handoff-runtime.md) / [receiver start](../../phase2-plan/RECEIVER-START.md).
Gói đã review và phạm vi kết quả nằm ở
[package evidence](../../phase2-plan/evidence/h-source-package.json); không coi HEAD
gốc hoặc dirty workspace mới thay đổi tự động cùng hash gói đã kiểm.

P2 continuation: Notification public API/manual send, Core RSA/gateway/runtime
outbox and guarded legacy fixture import are implemented and tested. See the
[P2 runbook](notification-runtime.md). The sections below describe the P1 proof
schema/worker; do not run the Core proof worker on the full runtime schema.

This project is a synthetic P1 environment, not the traffic/data cutover. Legacy
Compose and `.env` remain unchanged. Fixture credentials are for localhost tests only.

```powershell
npm ci
npm run phase2:build
npm run phase2:up
npm run phase2:test:contracts
npm run phase2:test:architecture
npm run phase2:test:integration
```

The integration runner checks Docker project labels, then database/user identity and
the bootstrap marker in every DB **before** migrations or test writes. It never
loads the legacy connection string. Each test uses fresh synthetic IDs. It retains
rows and volumes; no reset, truncate, seed or `down -v`. Only its unique test queue
is deleted after delivery checks. PostgreSQL at localhost:55432, RabbitMQ at 5679,
Redis at 6389. The three databases have separate non-superuser credentials and
PUBLIC CONNECT revoked. One PostgreSQL instance still shares CPU/IO.

Clinic and Notification are independently runnable after migrations from the proof
test. Set `DATABASE_URL` explicitly to their fixture DB and `PORT` to an unused port,
then `npm run start:built -w @nipopeto/clinic` or `@nipopeto/notification`.
Liveness is `/health/live`, readiness `/health/ready`. Clinic still provides its
P1 health runtime; Notification now has six P2 paths and requires public-key auth.
Clinic public use cases move in P3, billing HTTP authorization/reconciler in P4.

Built workers run with explicitly assigned `DATABASE_URL` **including
`?schema=p1_proof`** and `BROKER_URL`; they do not load legacy `.env`:

```powershell
npm run worker:built -w backend
npm run worker:built -w @nipopeto/clinic
npm run worker:built -w @nipopeto/notification
```

`BROKER_PREFIX` defaults to `nipopeto.v1`; tests use unique prefixes. The durable
topic exchange `<prefix>.events` binds `notification.requested.v1` to Notification
and `directory.#`/`billing.#` to Clinic, with separate durable queues and DLQs.
Core/Clinic own their outbox adapters and clients; `packages/messaging` contains
transport helpers only. Lease claims use unique tokens; failed confirms retain
pending rows with bounded backoff and a safe error code. Workers reconnect after
broker loss. Optional `OUTBOX_AGGREGATE_ID` confines a proof worker to its synthetic
fixture; omit it when processing the entire outbox.

Inbox/effects share a transaction; ACK follows commit. Transient failures retry
with 1/2-second backoff then DLQ; invalid schema goes straight to DLQ. Replacement
publication must be confirmed before original ACK. No automatic broker DLX is used.
Fault callbacks are test-only and are not exposed by HTTP/env. Logs use fixed codes.

Replay exactly one valid selected event at the DLQ head, preserving eventId:

```powershell
# Set BROKER_URL explicitly for the test broker first.
node tools/phase2/replay-event.mjs <consumer-queue> <eventId>
```

Mismatched/invalid heads stay in the DLQ. Replay confirms before ACK, is bounded to
one event and returns an audit result without payload. Operational authorization
is P6/P7 work; do not replay a queue wholesale.

Clinic's proof inbox applies directory source versions monotonically, preserving
tombstones against stale upserts, and finalizes/releases billing reservations
under the appointment lock. Projection does not grant user authorization. Actual
directory endpoints, source revision producers and authentication remain P3/P4
work; seven P1 internal paths remain reserved contracts. P2 adds Core's implemented
private Notification send-authorization path, described in the internal OpenAPI.

`backend/prisma/phase2` is a **proof-only Core schema** with a separate generated
client. The legacy Core schema stays intact for baseline compatibility. Do not
deploy proof tables over existing production models or treat `ProofInvoice` as a
completed invoice port. All generated clients are ignored and rebuilt locally.

Stop only the test infrastructure when finished:

```powershell
docker compose -f deploy/phase2/compose.test.yml stop
```

Restart preserves synthetic rows/broker volumes. Rollback here means stopping the
test project and reverting code after review; no live data migration has occurred.
New DB migration files are additive initial migrations, not edits to old migrations.
The integration suite temporarily stops/restarts only this project's RabbitMQ and
verifies actual AMQP handshake readiness and volume-backed catch-up. Failed proof
runs retain nonempty queues and synthetic DB rows; no resets are used to force PASS.

## Windows: `core-api` thoát với `0xC0000409` (lỗi chập chờn của môi trường)

Trên Windows, suite `phase2:test:migration` thỉnh thoảng thất bại vì `core-api` thoát với mã `0xC0000409` (3221226505, ngoại lệ fail-fast của Windows) đúng lúc process tắt. Coi đây là lỗi môi trường (Node trên Windows), không phải hành vi của ứng dụng: các lần ghi nhận đều chỉ ở Windows, log không có stack hay mã phụ, nguyên nhân gốc chưa xác định ([test-results](../../phase2-plan/evidence/test-results.md)).

- **Cách xử lý:** chạy lại suite đúng một lần. PASS ở lần hai thì ghi cả hai kết quả (lần đầu FAIL do `0xC0000409`, lần hai PASS), không xóa log lần đầu. FAIL lần hai thì coi là lỗi thật và điều tra.
- **Chuẩn kết luận:** CI Linux (GitHub Actions). Kết quả Windows chỉ là tham khảo cục bộ.
- **Số lần gặp:** repo chưa có bộ đếm. Các lần đã ghi: Clinic worker lúc khởi động trong E2E (nhật ký kiểm thử, chạy lại 18/18); Clinic dưới tải 8 owner/8 VU trên Node 24.15.0 ([finish-20261013](../../phase2-plan/evidence/finish-20261013.md), giữ FAIL); `core-api` lúc tắt trong suite migration ngày 28/10, một lần, chạy lại PASS ([STATUS.md](../../phase2-plan/STATUS.md)). Đây là các bản ghi tìm thấy, không phải tổng số.
