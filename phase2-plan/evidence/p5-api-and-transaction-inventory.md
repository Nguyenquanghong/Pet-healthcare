# P5 — API/transaction delta

Baseline [API CSV](api-inventory.csv) và inventories P2–P4 là lịch sử; P5 thêm:

| Public API                | Owner dữ liệu/runtime   | Scope và dữ liệu                                                                                                                             |
| ------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /api/dashboard/core   | Core                    | Verify token + stored actor/role; owner-scoped pet/hotel preview/counts; skip mọi Clinic/Notification SQL                                    |
| GET /api/dashboard/clinic | Clinic qua Core gateway | Verify RSA + current actor/ownership qua Core directory; appointment/medical preview/counts; owner internalNote redacted                     |
| Existing Clinic lists     | Clinic                  | Optional selected-pet directory sourceVersion/projectionVersion/searchReady, searchConsistency=eventual; fresh Core DTO và quyền giữ nguyên  |
| Existing /api/bootstrap   | Core adapter            | Own Core region + private Clinic + public Notification list/count; region failure separate, unknown unread/count null; no frontend P5 caller |

Public spec/linter: **69 operations**; Clinic: **17 public + private bootstrap +
5 private billing = 23**. Dashboard GET không tạo domain write, event hoặc service
mới. Notification unread vẫn dùng endpoint P2. Contract test thêm P5 regions và
partial bootstrap; các canonical billing/dedup/event contracts P4 không đổi.

Core dashboard giữ read model BootstrapRepository đã có, bỏ foreign domain
queries; các reads và `asOf` không là distributed snapshot. Clinic counts/preview
trong RepeatableRead local SQL, sau đó lấy current directory qua HTTP ngoài SQL.
List projection version đọc cùng transaction list, fresh source đọc directory
ngoài transaction; metadata báo eventual search, không cấp quyền từ projection.

Mutation registry là frontend refresh, không transaction phân tán. Transaction
slot/revision, medical+completion/history/outbox/dedup, invoice/items/snapshot/
billing outbox và notification inbox vẫn ở owner service như P2–P4. Thay đổi
writer frontend duy nhất ngoài refresh scope là Idempotency-Key cho form bệnh án
inline từ appointment; không tạo retry operation mới khi kết quả chưa rõ.

[Evidence](p5-frontend.md), [runbook](../../deploy/phase2/frontend-runtime.md).
