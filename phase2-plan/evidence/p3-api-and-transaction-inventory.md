# P3 — API và transaction sau tách Clinic

Baseline API P0 giữ nguyên trong CSV lịch sử. Khi `CLINIC_SERVICE_URL` được cấu
hình, các operations sau có **Clinic** là service owner; Core chỉ gateway HTTP.

| Public operation                      | Read/write và transaction                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| GET /appointments                     | Filter/search/scope/count trước pagination trên Clinic; Core lookup cho page related, owner redaction |
| GET /appointments/calendar            | Group theo ngày/category/scope Clinic; current actor được Core xác minh                               |
| POST /appointments                    | RequestDedup + appointment + outbox cùng transaction; partial unique slot dùng chung khám/Spa         |
| PATCH /appointments/{id}/status       | Row lock + reservation + revision; mutation/history/outbox cùng transaction                           |
| PATCH /appointments/{id}/reschedule   | Scope/slot + row lock/revision/reservation; mutation/history/outbox cùng transaction                  |
| PATCH /appointments/{id}/cancel       | Scope + row lock/revision/reservation; mutation/history/outbox cùng transaction                       |
| GET /appointments/{id}/status-history | Staff-only, Clinic history; Core current role/source                                                  |
| POST /appointments/{id}/undo-status   | Row lock + revision + dependencies/reservation; reversal/history/outbox atomic                        |
| POST /appointments/{id}/reminder      | Staff + source authorization; một outbox insert atomic, không gọi Notification HTTP                   |
| GET /medical-records                  | Scope/search/count/pagination Clinic; related pet/owner và appointment; redact internalNote cho owner |
| POST /medical-records                 | Validated canonical dedup + record + linked appointment lock/completion/history + outbox atomic       |
| PATCH /medical-records/{id}           | Staff; liên kết bất biến; row lock appointment/reservation + update                                   |
| DELETE /medical-records/{id}          | Staff; row lock appointment/reservation + delete                                                      |
| GET /medical-records/images           | Owner snapshot filter trước count/page; Core xác minh pet/owner của page                              |
| POST /medical-records/images          | Staff, Core pet source; insert ảnh + owner snapshot vào Clinic                                        |
| DELETE /medical-records/images/{id}   | Staff/current Core role/source; Clinic delete                                                         |

Private Core directory authorize/lookup: credential + actor JWT, current role,
bounded IDs, RepeatableRead source snapshot. Export: service credential, keyset
kind/cursor hoặc exact id; minimal search fields/current revision/tombstone.
User/Pet insert/update/delete trigger ghi source revision/directory outbox trong
Core transaction, mọi writer đều đi cùng đường này.

Private Clinic GET /internal/clinic/bootstrap: credential + actor JWT/current
Core authorization; Clinic RepeatableRead lấy clinical region và totals/status
counts, Core HTTP lookup cho related. Public Core /bootstrap dùng adapter với
Core bootstrap repository bật skipClinic: không còn query clinical tables ở Core
trong cấu hình tách service. Notification bootstrap/header legacy thuộc P5.

Core hotel/identity/pet/invoice/payment ownership giữ nguyên. Appointment invoice
create/checkout bị chặn 503 trong split mode trước P4, tránh lập hóa đơn từ nguồn
stale. Core legacy clinical schema còn giữ để P7 migration/history và cấu hình
chưa cutover; P3 không xóa dữ liệu, drop schema hay bật traffic đang sử dụng.
