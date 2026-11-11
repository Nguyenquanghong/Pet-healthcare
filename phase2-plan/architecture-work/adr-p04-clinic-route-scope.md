# ADR-P04: Clinic khai phạm vi kiểm quyền theo route

Ngày 1/11/2026. Trạng thái: **ACCEPTED**. đã chốt N1, N3 ngày 31/10; N2 giữ nguyên. Thực hiện ở K2 của lộ trình cải thiện kiến trúc, thiết kế ở k2-design (`k2-design-20261031.md`). Đề xuất gốc: P04 , viết trước [ADR-P12](adr-p12-deferred-list-authorization.md) nên không làm theo nguyên văn.

## Bối cảnh

- Một middleware trong `createApp` đoán tài nguyên từ URL bằng regex, rồi đọc Prisma để biết phải hỏi Core về pet nào. Route mới có id trên URL mà không khớp regex thì tài nguyên đó không được kiểm, và không có gì báo.
- Regex phân biệt hoa thường, Express thì không. `/api/APPOINTMENTS/<id>/cancel` bỏ qua bước tra tài nguyên, `/api/MEDICAL-RECORDS` bỏ qua cổng ghi. Chưa thấy lộ dữ liệu vì service có lớp kiểm thứ hai, và đi qua Core thì bị 404.
- Với URL không có route, Clinic vẫn đọc DB và gọi Core. `/appointments/<id>/nope` trả hai message khác nhau tùy id có tồn tại không, nên lộ việc id đó có tồn tại.

## Quyết định

1. Mỗi route là một phần tử trong registry ở `services/clinic/src/http/routes/*.ts`, kiểu `ClinicRoute` ở `http/scope.ts`. `resource` là bắt buộc; `'none'` là lựa chọn tường minh.
2. `pep(route, deps)` đọc khai báo của route đã khớp, chạy trước handler, theo đúng thứ tự cũ:
   1. `permission`, `writePermission`;
   2. body mặc định và `objectInput`;
   3. gom `petId` chung cho mọi route: GET lấy query, còn lại lấy body;
   4. tra tài nguyên qua port `ScopeLookup`;
   5. đọc trì hoãn theo ADR-P12, hoặc hỏi Core.
3. `medical-record.history`, `medical-record.restore`, `booking.manage` không lên PEP, vì chúng chạy sau 404 và sau Core.
4. `assertRoutes` làm app từ chối khởi động với `CLINIC_ROUTE_SCOPE_REQUIRED` khi: thiếu hoặc sai `resource`; `:id` đi với `resource:'none'`; không có `:id` mà khai resource; `deferred` sai chỗ; trùng route; handler không phải function.
5. `mountBilling` đứng ngoài registry, vẫn mount trước router. Giữ `authorize(..., 'clinic-activity.read')` trong handler activity, ngoài `permission` ở registry.

## Hành vi đổi có chủ ý

**N1. URL không có route trả 404, không qua Core, không đọc DB.**

- Token bị thu hồi 401 → 404. Core chết 503 → 404. Body mảng 422 → 404. Owner `POST /medical-records/x/y` 403 → 404.
- `OPTIONS` không gọi Core, trả `Allow`: owner 403 → 200, Core chết 503 → 200. Chỉ lộ header `Allow`.
- Không đổi: thiếu token vẫn 401, JSON hỏng vẫn 400, vì hai bước này chạy ở `router.use`.
- Prefix `/dashboard/clinic/activity` vẫn có `Cache-Control: no-store` trên 404, vì middleware no-store khớp theo prefix.

**N3. Biến thể URL được kiểm theo route đã khớp.**

- Biến thể hoa thường và dấu `/` cuối được tra tài nguyên và qua cổng quyền. `/APPOINTMENTS/<id>/cancel`: Core nhận `[]` → `['pet-1']`. Owner `/MEDICAL-RECORDS` với body mảng: 422 → 403.
- Đọc trì hoãn vẫn so chính xác `req.path === route.path`, nên `/appointments/` luôn đi đường eager.

**N2. HEAD giữ nguyên.** HEAD đi nhánh không phải GET: cần `medical-record.write` ở `/medical-records*`, query `petId` không gửi Core, không bao giờ trì hoãn, history không có fallback. Không thấy client nào dùng HEAD.

## Lệch nhỏ phát hiện khi review

`code-reviewer` so cũ và mới trên 63.720 tổ hợp, với fake DB và fake Core. Không có đường nào tới handler mà thiếu Core, và owner không có ca mới 2xx. Các ca dưới đây đều không rộng quyền. Bốn ca đầu đã khóa trong nhóm `changed` của golden. Phần `old` của chúng lấy từ build thật của `6d42c3f`; build đó tái tạo đúng 463 ca `stable` và 47 ca `old`.

| Ca                                                  | Cũ                                                                | Mới                                            | Vì sao chấp nhận                                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `PATCH /appointments/%63alendar/status`, admin      | 404, không qua Core                                               | Core `[]`, vào handler, 404                    | `RESERVED_IDS` nay so id đã decode. Y hệt ca `stable` `/appointments/calendar/status`              |
| `PATCH /appointments/images/status`, admin          | regex nuốt `images/`, tra id `status`, DB thật 404 không qua Core | `:id='images'`, Core `[]`, vào handler, 404    | Handler không ghi gì. Owner vẫn bị chặn ở quyền của service                                        |
| `PATCH /medical-records/%E0%A4%A`, owner            | 403                                                               | 500, Core 0, bảng 0                            | Express ném lỗi decode khi khớp layer, PEP không chạy. Vẫn fail-closed                             |
| `PATCH /medical-records/%E0%A4%A`, admin, body `[]` | 422                                                               | 500, Core 0, bảng 0                            | Như trên. GET id hỏng vốn đã 500 trước K2                                                          |
| `HEAD /medical-records`, body `{petId:' p '}`       | Core `['p']`                                                      | Core `[' p ']`                                 | `trimBodyPetId` chỉ khai trên POST. Chưa khóa trong golden, không thấy client nào gửi HEAD có body |
| `GET /medical-records/images/history`               | tra image `history`, 404 không qua Core                           | `:id='images'`, gọi Core; staff 404, owner 403 | Ca lệch thiết kế đã dự kiến                                                                        |

**Nhãn metric, không đổi response:** `POST /medical-records/images/:id/restore` và `GET /dashboard/clinic/activity` trước đây có nhãn `unknown`, nay có nhãn riêng (`http/routeLabel.ts`). Không alert hay file deploy nào dựa vào nhãn `unknown` của hai route này.

## Đánh đổi

- **Chưa làm:** id không decode được vẫn trả 500 thay vì 400. Vá ở `errorHandler` sẽ đổi ca `stable`, nên cần quyết riêng.
- **Giữ `RESERVED_IDS`:** bỏ đi thì chặt và gọn hơn, nhưng đổi các ca `stable` của kịch bản id dành riêng. Không làm trong K2.
- **`add('')`:** hàng có `petId` rỗng không thêm pet nào vào `petIds`, giống hệt code cũ. PEP kiểm `pet === null` chứ không phải `!pet`, nên giữ được hành vi này. Chưa thấy đường tạo hàng như vậy.

## Kiểm chứng

- `tools/phase2/clinic-scope.test.mjs`: 514 ca, gồm 463 `stable` ghi trên code trước khi đổi và không sửa, 51 `changed`.
- `tools/phase2/clinic-routes.test.mjs`: khóa khai báo của 21 route, mọi input xấu của `assertRoutes`, PEP được gắn cho mọi route.
- Rule `service-layering`, `clinic-routes-declare-scope`, `deferred-reads-via-authorized-read`, chỉ số S7.
- Cổng Đủ trên `1634d23`, lần đầu, không chạy lại suite nào: integration 16, clinic 19, migration 11, resilience 19, billing 12, notification-runtime 15, notification 6, clinic-relay 8, core-relay 4, e2e 18, notification-ui 24, đều 0 fail. `arch:check` 14/14, `npm test` PASS.
- Đột biến đã chạy thật, đều bị bắt: `resource:'none'` cho cancel; bỏ `writePermission`; `deferred:true` trên POST; bỏ `req.path === route.path`; breaker luôn đúng; bỏ `pep` khỏi `mountRoutes`.
