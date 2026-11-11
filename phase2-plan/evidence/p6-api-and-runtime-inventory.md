# P6 API, transaction và runtime inventory

11–12/10/2026. Public business paths/body/status/idempotency và Prisma migrations
giữ nguyên P5 (Core OpenAPI 69 operations). P6 thêm private runtime observation,
admission headers và 429/503 từ trước use case. Không đổi service owner.

| Component                  | Delta                                                                                        | SQL/transaction ảnh hưởng                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Core auth                  | Redis account/IP quota riêng; bounded PBKDF2; strict RS256/kid                               | Hash/activation/profile transactions hiện có; không hạ iterations hoặc đổi ownerId               |
| Core composition           | Custom auth trước owned domains, sanitized errors, URL strict và normalized proxy path guard | Split writers vẫn Core-only; không bật legacy Clinic/Notification writer khi target config thiếu |
| Clinic public API          | Shared per-service read/write quota, deadline/correlation                                    | Durable dedup/slot/revision/medical atomicity hiện có không đổi                                  |
| Notification public API    | Shared quota/deadline/correlation                                                            | Inbox+notice atomic và HTTP dedup/read/delete không đổi                                          |
| Notification event tracing | Request correlation persisted, confirm/effect/ACK JSON metadata                              | Outbox payload business không đổi; log sau confirm/commit, không ACK sớm                         |
| Billing operation tracing  | RequestId→operationId result log, terminal event correlation bền vững                        | Giữ operation lock/terminal states, không đổi commit/abort/undo protocol                         |
| /health/live (3 API)       | 200 process liveness                                                                         | Không query SQL                                                                                  |
| /health/ready (3 API)      | Own DB+expected migration; Redis/broker/backlog degraded                                     | Own-role read transaction, SET LOCAL statement_timeout; không sửa business rows                  |
| /metrics (3 API)           | Private token, bounded route labels/resources/backlog/queues                                 | Own DB probes, passive broker checkQueue; không declare/consume/ACK                              |
| Internal service API       | Cùng X-Service-Token header, credential riêng theo scope                                     | Giữ actor/source evidence checks và operation/reservation lock protocol                          |
| Core outbox/billing worker | Pool limit/configured scoped billing token                                                   | Leased claim/mark/reconcile transactions hiện có                                                 |
| Clinic/Notification worker | Pool budget + graceful parent IPC                                                            | Chờ pending effect commit rồi ACK; không ACK khi còn chờ SQL                                     |

Limiter Lua transaction chỉ ở Redis, không tham gia SQL distributed transaction.
Admission trước use case có thể trả 429/503. Timeout 503 có thể có kết quả commit
muộn; same-key retry vẫn dùng SQL durable result. Core/Clinic outbox còn cùng
transaction với business; broker outage không biến producer thành HTTP best effort.

Header mới: X-Request-Id UUID, X-Service-Instance, RateLimit-Limit/Remaining,
Retry-After trên quota/admission/deadline, X-Service-Degraded=redis khi fallback
read. Không expose peer URL/secret hoặc raw medical/request data qua metrics/logs.
Gateway private routes luôn 404. Runbook nêu policy/bounds/credential mapping và
token migration: [resilience-runtime](../../deploy/phase2/resilience-runtime.md).

Không có migration/data export/import/cutover P6. P7 phải review schema/index,
backup/restore, reservation backfill và ownership switch. P6 không chứng minh
khả năng rollback dữ liệu lịch sử, HA hoặc capacity benchmark.
