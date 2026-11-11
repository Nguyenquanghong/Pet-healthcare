# P2 API and transaction delta, 11/10/2026

P0 api-inventory.csv remains the historical 65-operation baseline. Current public
contract has 66 operations, mechanically checked against Core legacy routers plus
six Notification paths through Core composition; check-openapi passed.

| Operation                                                 | Runtime owner | Boundary/test                                                       |
| --------------------------------------------------------- | ------------- | ------------------------------------------------------------------- |
| GET /api/notifications                                    | Notification  | Repeatable-read page/count/scope, P2 API                            |
| GET /api/notifications/unread-count (new)                 | Notification  | Count/asOf snapshot, unavailable 503; API and UI                    |
| PATCH /api/notifications/read-all                         | Notification  | Scoped updateMany; API                                              |
| PATCH /api/notifications/:id/read                         | Notification  | Scoped write/result transaction; API                                |
| DELETE /api/notifications/:id                             | Notification  | Scoped delete, retain inbox; real broker replay                     |
| POST /api/notifications/send                              | Notification  | Core authorization then atomic dedup/effect/cache; two-process HTTP |
| POST /internal/notifications/authorize-send (new/private) | Core          | Own User lookup only, service credential + bound actor; runtime     |

Core gateway has a fixed service origin, no Notification SQL. Missing config is 503. Send requires Idempotency-Key in frontend/public/service specs; changed
validated content is 409, temporary failure 503 retry same key. Reminder/rescue
keep HTTP 201 but their message now says request accepted, not delivered.

| Producer adapter           | Domain and outbox transaction                               |
| -------------------------- | ----------------------------------------------------------- |
| appointmentRepository      | Create/reschedule/cancel UoW; reminder alone inserts outbox |
| bookingLifecycleRepository | Status/revision/history/outbox under same booking lock      |
| medicalRepository          | Record/linked completion/history/outbox UoW                 |
| hotelRepository            | Booking/request dedup or care note and outbox UoW           |
| invoiceRepository          | Issue/pay/transfer report/reject/history/outbox transaction |
| paymentRepository          | Attempt/event/invoice confirm or review/outbox transaction  |
| publicRescueRepository     | Report/outbox UoW                                           |
| Clinic notificationOutbox  | Proof appointment/outbox success and rollback, real PG      |

Runtime audit checks all Core src excluding generated: zero
notification.create/createMany/upsert. Only two legitimate Notification creators:
inbox.ts (inbox/effect) and manualSend.ts (dedup/effect/cache). CLI/test fixtures
intentionally create source/collision rows outside application runtime, guarded.

Core legacy Notification model/read/mutation adapters remain for old factory and
bootstrap, but index composition intercepts all /api/notifications before local
routers, and manual local fallback explicitly fails closed. Remove remaining
legacy reads/adapters after P5/P7. Regex audit supplements review: rg also found
no raw Core INSERT notifications. Runtime checks Core fixture owner notification
count stays zero before intentional offline migration source fixtures; every
domain producer emits an outbox.
