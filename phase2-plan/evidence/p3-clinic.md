# P3 — Clinic: bằng chứng triển khai

11/10/2026; main/add596e4488e3cac2584115874c2f65a97af7047; một coding session. 18 SHA256 local ban đầu vẫn khớp; app.ts giữ
nguyên. [Runbook](../../deploy/phase2/clinic-runtime.md),
[API/transaction delta](p3-api-and-transaction-inventory.md).

## Kết quả thực tế

- Own full schema/client/index cho appointment, record, image, history, local
  reservation và request dedup; proof tables giữ nguyên. Core source revisions/
  directory outbox triggers. Migrations 006/007 chỉ deploy DB thử có marker.
- 16 public operations port vào Clinic, Core gateway opt-in; bootstrap adapter
  lấy clinical region từ Clinic và không query Core clinical tables. Auth RS256
  public key + Core current actor/pet/owner HTTP; projection chỉ để search.
- Durable create dedup dùng canonical field/default/date/number validation,
  cùng transaction với effects/outbox. UI khám/Spa/admin create/bệnh án giữ key
  qua timeout, khóa double submit và xử lý saved/reload failed. Owner form bỏ
  doctor ID hardcode để staff phân công theo nguồn hợp lệ.
- Core keyset snapshot + durable queue catch-up; inbox version/tombstone guard.
  Wire event nhỏ, hydrate full search fields ngoài SQL transaction: tên dài,
  owner email/phone, breed/microchip đều được tìm trước count/page. Event upsert
  cũ sau source delete hydrate durable tombstone, không đưa nguồn đã xóa trở lại.
- Public Core owner/pet DTO trả directoryVersion; P5 có thể đối chiếu projection
  sau write. Chưa triển khai UI chờ version/search-sync ở P3.
- HELD/INVOICED check dưới appointment lock cho lifecycle/medical liên kết.
  Public appointment billing fail closed trước P4; không claim P4 runtime đạt.

## Test đã chạy

`npm run phase2:test:clinic`: **7/7, 0 skip**, PostgreSQL/RabbitMQ thật, Core HTTP,
hai process Clinic build, worker Clinic/Notification build; không mock domain DB.
Lần cuối sau bổ sung directoryVersion, fixture legacy/search và body validation
đạt ~23,2s. Các nhóm kiểm chứng:

1. Tám create đồng thời qua hai process, durable dedup/canonical trim, key reuse
   khác nội dung, owner scope và HTTP body bị bỏ sau commit rồi retry cùng ID.
2. Khám/Spa tranh cùng slot: một 201/một 409; revision race một winner; undo/
   history/reschedule/cancel. Barrier quan sát **pg_stat_activity lock waiter**
   trước khi insert HELD dưới lock, undo và linked medical create đều 409.
3. Hai process create bệnh án cùng key chỉ một record/completion/history;
   đổi visitDate với key cũ 409. Constraint outbox SQL thật làm rollback record,
   completion, history, dedup. Ngày/vitals/link bất hợp lệ bị từ chối; INVOICED
   chặn linked medical edit/delete.
4. Scope/pagination/filter/status counts/related/redaction, image create/list/
   delete, staff history/record mutations, Core clinical row không tăng; dashboard
   lấy Clinic totals/regions; split appointment invoice trả 503.
5. Search lag trước catch-up, long name/email/microchip sau catch-up; backfill
   update xen giữa page; version cũ và tombstone replay không hồi sinh; forged
   projection ownership không cấp quyền; source delete + old queued upsert.
6. Missing/invalid JWT/current role withdrawal/Core credential gate; Core outage
   protected reads/create đều 503 và không ghi dedup; hồi phục đọc được. New owner
   token không replay được response bệnh án private khi actor bị hạ quyền;
   committed inbox duplicate không cần gọi Core lại lúc outage.
7. Broker stop vẫn commit appointment/reminder và pending outbox; built worker
   catch-up Notification; broker replay cùng event ID không tạo notification trùng;
   process logs không có credential URLs.

`npm run phase2:verify` đã đạt exit 0 ở kiểm tra cuối: build toàn workspace,
contracts **6/6**, boundaries/writer audit, P1 **12/12**, P2 API **5/5**, P2 runtime
**8/8**, P3 **7/7**, không skip. P1 ~25,0s, P2 runtime ~27,0s, P3 ~22,9s.
Kiểm tra bổ sung sau wrapper cho public directoryVersion, legacy long-name fixture,
duplicate inbox/Core outage và hạ quyền replay được ghi tại
[test-results](test-results.md); không dùng kết quả skip làm PASS.

`npm test`: exit 0, backend/frontend build, **81/81** unit, architecture **90**
files, public OpenAPI **66** operations. `phase2:test:notification-ui`: **6/6**
Chromium (3 Clinic + 3 Notification), frontend build thật, tất cả API intercept.
`verify-local`: 18 SHA256 PASS; `git diff --check`: exit 0.

## Lỗi đã gặp và sửa

- Fixture đầu thiếu passwordHash/Salt bắt buộc nên setup fail trước domain tests;
  bổ sung giá trị synthetic, guard cleanup không query queue chưa khai báo.
- Sandbox Windows chặn spawn Node test runner (EPERM); chạy lệnh test được
  auto-review cho phép ngoài sandbox, không bỏ/skip test.
- Clinic pure port còn hotel branches làm TypeScript narrow status sai; giới hạn
  port/lifecycle cho appointment, hotel tiếp tục thuộc Core.
- UI test đầu chưa khớp vùng feedback bệnh án; vùng form error có role=alert,
  kiểm lại retry key/saved warning và tất cả sáu test đạt. Không ghi FAIL thành PASS.
- Hồi quy bổ sung P1 phát hiện race hai unique indexes ở Core begin cùng key:
  SQL ON CONFLICT chỉ target actor/key có thể lỗi active appointment index.
  Đổi sang tất cả unique arbiters, đọc lại durable actor/key; key khác giữ nguồn
  trả SOURCE_BUSY. Test barrier SQL đợi cả hai INSERT bị khóa trước khi cho chạy,
  kiểm cùng operation ID và khác key bị từ chối; kết quả ghi tại test-results.
- Fixture bổ sung public directoryVersion thử gửi tên pet >200 qua public API,
  bị 422 đúng giới hạn baseline. Sửa fixture: PATCH tên hợp lệ và assert version,
  rồi SQL trên DB thử tạo tên dài legacy để kiểm export/search, giữ validation.

## Chưa kiểm chứng / giới hạn

Không live cutover, import toàn bộ dữ liệu legacy, backup/restore, remote CI,
full UI đi qua các backend thật, HA/load/auth surge/shared limiter hoặc benchmark.
Không tự reset/migrate DB đang dùng. Projection search là eventual; Core outage
fail closed. Owner relation bất biến theo API baseline; thêm chuyển chủ cần thiết
kế mới. Billing operation public/reconciler/crash matrix thuộc P4; bootstrap/
global polling/header Notification còn phần P5. Network isolation/keys/metrics/
dependency advisories thuộc P6. H chưa đạt, chưa bàn giao.
