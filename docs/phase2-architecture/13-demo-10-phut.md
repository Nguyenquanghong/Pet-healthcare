# Kịch bản demo 10 phút

Dành cho người trình bày, chạy trên một máy Windows có Docker Desktop. Mọi lệnh ở mục 2 đã diễn tập ngày 31/10/2026 trên commit `f438101`, trên project test cô lập `pet-phase2-p1-test`: không đọc `.env.docker`, không đụng dữ liệu thật. Số thời gian dưới đây là của lần diễn tập, không phải số đo hiệu năng.

Demo chạy trên stack của E2E (`tools/phase2/e2e-server.mjs`): các service thật chạy như process Node, kèm PostgreSQL, RabbitMQ, Redis và bucket trong Docker. Lý do: repo không có tài khoản admin hay seed cho stack đã tách, còn stack E2E tự tạo admin, owner và 21 pet.

| Phút       | Phần             | Thông điệp                                                                                              |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| 0:00–1:00  | Mở đầu           | Ba service, ba DB, sơ đồ [02](02-c4-containers.md)                                                      |
| 1:00–3:30  | 1. Đặt lịch      | Một lệnh ghi đi qua hai service bằng event; quyền và chống trùng do service sở hữu dữ liệu quyết định   |
| 3:30–5:00  | 2. Thu hồi phiên | Đổi mật khẩu thì token cũ chết ngay ở cả Clinic và Notification                                         |
| 5:00–7:30  | 3. Service dừng  | Notification tắt thì đặt lịch vẫn chạy; Core dừng thì Clinic cũng ngừng đọc, và đó là đánh đổi có chủ ý |
| 7:30–8:30  | 4. Claim Check   | Ảnh nằm ở bucket, API chỉ trả metadata và URL ký                                                        |
| 8:30–10:00 | 5. Cái giá đã đo | Vì sao vẫn giữ kiến trúc tách                                                                           |

## 1. Chuẩn bị (trước buổi, khoảng 10 phút)

Mở Docker Desktop, rồi ở thư mục gốc của repo:

```powershell
npm run phase2:up
npm run phase2:build
Set-Location frontend
node ../node_modules/typescript/bin/tsc -b
$env:NODE_ENV='production'; $env:VITE_API_BASE_URL='/api'
node ../node_modules/vite/bin/vite.js build
Remove-Item Env:NODE_ENV, Env:VITE_API_BASE_URL
Set-Location ..
```

**Terminal 1**, để nguyên suốt buổi. Chờ tới dòng `P5 isolated real-service UI ready`:

```powershell
$env:PHASE2_TEST_CONFIRM='pet-phase2-p1-test'
node --import tsx tools/phase2/e2e-server.mjs
```

**Chạy probe P03 trước buổi**, ở terminal khác, vì mất khoảng 1,5 phút. Kết quả ở `test-results/phase2/p03-demo/result.json`:

```powershell
node --import tsx tools/phase2/messaging-retry.probe.mjs demo
```

**Terminal 2**, dùng để trình diễn. Dán khối hàm trợ giúp này một lần:

```powershell
# Helper
$base = 'http://127.0.0.1:5189/api'
$f = Get-Content test-results\phase2\p5-e2e-fixture.json -Raw | ConvertFrom-Json
function Api($method, $path, $token, $body, $key) {
  $headers = @{}
  if ($token) { $headers.Authorization = "Bearer $token" }
  if ($key) { $headers['Idempotency-Key'] = $key }
  $params = @{ Uri = "$base$path"; Method = $method; Headers = $headers; UseBasicParsing = $true; TimeoutSec = 20 }
  if ($null -ne $body) { $params.ContentType = 'application/json; charset=utf-8'; $params.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 6 -Compress)) }
  try {
    $r = Invoke-WebRequest @params
    [pscustomobject]@{ Status = [int]$r.StatusCode; Body = $(if ($r.Content) { $r.Content | ConvertFrom-Json }); Length = $r.RawContentLength }
  } catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    if (-not $resp) { return [pscustomobject]@{ Status = 0; Body = $null; Length = 0 } }
    $text = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
    [pscustomobject]@{ Status = [int]$resp.StatusCode; Body = $(try { $text | ConvertFrom-Json } catch { $text }); Length = $text.Length }
  }
}
function Control($values) {
  $o = @{ run = $f.run }; foreach ($k in $values.Keys) { $o[$k] = $values[$k] }
  [IO.File]::WriteAllText("$PWD\test-results\phase2\p5-e2e-controls.json", ($o | ConvertTo-Json -Compress))
}
$admin = (Api POST /auth/admin/login $null @{ username = $f.admin.username; password = $f.password }).Body.token
$owner = (Api POST /auth/owner/login $null @{ email = $f.owner.email; password = $f.password }).Body.token
$other = (Api POST /auth/owner/login $null @{ email = $f.other.email; password = $f.password }).Body.token
"owner: $($f.owner.email)  admin: $($f.admin.username)  password: $($f.password)"
"da dang nhap: admin=$([bool]$admin) owner=$([bool]$owner) other=$([bool]$other)"
```

Trình duyệt: mở `http://127.0.0.1:5189/login`, đăng nhập bằng tài khoản owner vừa in ra, để thấy ứng dụng thật. Trang admin ở `/admin/login`. Phần bấm giao diện không có trong lần diễn tập này; cùng các luồng đó đã có E2E (`npm run phase2:test:e2e`). Các phần dưới dùng lệnh để không phụ thuộc thao tác tay.

**Mỗi buổi phải chạy mới terminal 1.** Phần 2 đổi mật khẩu của `other`, nên chạy lại trên cùng stack sẽ không đăng nhập được.

## 2. Trình diễn

### Phần 1: Đặt lịch (2 phút 30)

```powershell
# Phần 1
$before = (Api GET /notifications/unread-count $owner).Body.unread
$slot = @{ petId = $f.pets[3].id; type = 'spa_bath'; serviceName = 'Demo tam'; date = '2040-03-05'; time = '10:30' }
$book = Api POST /appointments $owner $slot ([guid]::NewGuid().ToString())
$a = $book.Body.appointment
"tao lich: $($book.Status), trang thai $($a.status)"
$conf = Api PATCH "/appointments/$($a.id)/status" $admin @{ status = 'confirmed'; expectedRevision = $a.statusRevision }
"xac nhan: $($conf.Status)"
$sw = [Diagnostics.Stopwatch]::StartNew()
do { Start-Sleep -Milliseconds 100; $u = (Api GET /notifications/unread-count $owner).Body.unread } until ($u -gt $before -or $sw.ElapsedMilliseconds -gt 10000)
"thong bao chua doc: $before -> $u sau $($sw.ElapsedMilliseconds) ms"
"trung gio cung pet: $((Api POST /appointments $owner $slot ([guid]::NewGuid().ToString())).Status)"
"sua bang revision cu: $((Api PATCH "/appointments/$($a.id)/status" $admin @{ status = 'checked_in'; expectedRevision = $a.statusRevision }).Status)"
"owner khac doc pet nay: $((Api GET "/appointments?petId=$($f.pets[3].id)" $other).Status)"
```

**Kết quả kỳ vọng:** tạo lịch 201, xác nhận 200, thông báo chưa đọc tăng từ 0 lên 1 sau khoảng 0,3 s, trùng giờ 409, revision cũ 409, owner khác 403.

**Nói:** Lịch ghi vào DB Clinic cùng một dòng outbox trong một transaction. Relay đẩy event qua RabbitMQ, Notification ghi vào DB riêng. API không chờ broker. Trùng giờ do trigger trong DB chặn, nên đúng cả khi đồng thời. Quyền của owner khác do Clinic hỏi Core ở mỗi request.

### Phần 2: Thu hồi phiên (1 phút 30)

```powershell
# Phần 2
"truoc: clinic $((Api GET '/appointments?pageSize=5' $other).Status), notification $((Api GET /notifications/unread-count $other).Status)"
$new = 'Demo-Doi-Mat-Khau-2026!'
"doi mat khau: $((Api POST /auth/me/password $other @{ currentPassword = $f.password; newPassword = $new; confirmPassword = $new }).Status)"
"clinic voi token cu: $((Api GET '/appointments?pageSize=5' $other).Status)"
$sw = [Diagnostics.Stopwatch]::StartNew()
do { $n = Api GET /notifications/unread-count $other; if ($n.Status -ne 401) { Start-Sleep -Milliseconds 20 } } until ($n.Status -eq 401 -or $sw.ElapsedMilliseconds -gt 5000)
"notification voi token cu: $($n.Status) sau $($sw.ElapsedMilliseconds) ms"
```

**Kết quả kỳ vọng:** trước đó 200 và 200; đổi mật khẩu 204; Clinic 401 ngay; Notification 401 trong vài chục ms.

**Nói:** Hai service dùng hai cách. Clinic hỏi Core mỗi request nên chặn ngay, cái giá là một lời gọi đồng bộ. Notification nhận event `identity.sessions-revoked.v1` trên queue riêng, nên không xếp sau hàng thông báo. ADR-P13 đã xem xét đưa Clinic sang cách của Notification và hoãn lại, vì sẽ mở cửa sổ token đã thu hồi vẫn đọc được tới 2 s.

### Phần 3: Service dừng (2 phút 30)

```powershell
# Phần 3a
$u = (Api GET /notifications/unread-count $owner).Body.unread
Control @{ stopNotification = $true }
do { Start-Sleep -Milliseconds 200; $o = Get-Content test-results\phase2\p5-e2e-observed.json -Raw | ConvertFrom-Json } until ($o.notificationStopped)
"notification dang tat: $((Api GET /notifications/unread-count $owner).Status)"
$b = Api POST /appointments $owner @{ petId = $f.pets[4].id; type = 'spa_bath'; serviceName = 'Demo khi Notification tat'; date = '2040-03-06'; time = '10:30' } ([guid]::NewGuid().ToString())
"dat lich luc Notification tat: $($b.Status)"
$a2 = $b.Body.appointment
"xac nhan luc Notification tat: $((Api PATCH "/appointments/$($a2.id)/status" $admin @{ status = 'confirmed'; expectedRevision = $a2.statusRevision }).Status)"
Control @{}
$sw = [Diagnostics.Stopwatch]::StartNew()
do { Start-Sleep -Milliseconds 200; $n = Api GET /notifications/unread-count $owner } until (($n.Status -eq 200 -and $n.Body.unread -gt $u) -or $sw.ElapsedMilliseconds -gt 20000)
"notification bat lai: $($n.Status), chua doc $u -> $($n.Body.unread) sau $($sw.ElapsedMilliseconds) ms"
```

**Kết quả kỳ vọng:** Notification 503; đặt lịch 201; xác nhận 200; bật lại sau khoảng 6 s thì trả 200 và thông báo mới xuất hiện.

```powershell
# Phần 3b
Control @{ restartCore = "demo-$(Get-Date -Format HHmmss)" }
$sw = [Diagnostics.Stopwatch]::StartNew(); $last = ''
while ($sw.ElapsedMilliseconds -lt 15000) {
  $state = "pets $((Api GET '/pets?pageSize=1' $owner).Status), appointments $((Api GET '/appointments?pageSize=1' $owner).Status)"
  if ($state -ne $last) { "$($sw.ElapsedMilliseconds) ms: $state"; $last = $state }
  Start-Sleep -Milliseconds 100
}
```

**Kết quả kỳ vọng:** đang 200/200 thì chuyển 503/503, rồi về 200/200. Qua 12 lần đo sau `e138bd3`, thời gian 503 là 1,7–2,3 s, phần lớn là thời gian Core khởi động. Trước commit đó, 3/12 lần mất khoảng 12 s vì client polling giữ kết nối keep-alive, khiến drain phải chờ deadline 10 s. Nếu thầy hỏi thì đây là một lỗi thật mà demo đã giúp phát hiện. Vòng lặp chờ đủ 15 s nên vẫn thấy hết.

**Nói, phải nói rõ phần này:**

- Tách service cô lập được lỗi của Notification. **Không** cô lập được lỗi của Core: Core dừng thì danh sách của Clinic cũng 503, vì quyền luôn hỏi Core. Chọn fail-closed: thà 503 còn hơn trả dữ liệu chưa kiểm quyền.
- Ở stack demo, mọi request đi qua Core, nên `/appointments` 503 còn vì mất đường proxy. Với gateway tách, request vào thẳng Clinic và vẫn 503 vì không xác nhận được quyền (`directory-cache.test.mjs`).
- Thời gian 503 ở đây là của stack demo, gồm cả drain, không phải SLO.

**Không mất event:** mở `test-results/phase2/p03-demo/result.json`. Kết quả diễn tập: 50 event đến trong lúc Core trả 503 suốt 10 s, tất cả được áp dụng sau khoảng 37 s, 0 event vào DLQ, nhờ delay queue. **Phải nói đây là probe dùng Core giả trả 503**, không restart process thật. Bằng chứng dùng process thật là `phase2:test:billing` (kill Core giữa lúc lập hóa đơn) và `phase2:test:integration` (dừng broker thật).

### Phần 4: Claim Check và Valet Key (1 phút)

```powershell
# Phần 4
$png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
"upload: $((Api POST /medical-records/images $admin @{ petId = $f.pets[5].id; mimeType = 'image/png'; imageUrl = "data:image/png;base64,$png"; title = 'demo' }).Status)"
$lst = Api GET "/medical-records/images?petId=$($f.pets[5].id)" $admin
$item = $lst.Body.items[0]
"danh sach: $($lst.Status), $($lst.Length) byte, co url ky: $([bool]$item.url), het han: $($item.urlExpiresAt)"
$got = Invoke-WebRequest $item.url -UseBasicParsing
"tai truc tiep tu bucket: $($got.StatusCode), $($got.RawContentLength) byte, cong $(([uri]$item.url).Port)"
try { $t = (Invoke-WebRequest ($item.url -replace 'X-Amz-Signature=[0-9a-f]{4}', 'X-Amz-Signature=0000') -UseBasicParsing).StatusCode } catch { $t = [int]$_.Exception.Response.StatusCode }
"sua chu ky: $t"
```

**Kết quả kỳ vọng:** upload 201; danh sách 200 chỉ có metadata và URL ký; tải trực tiếp 200 ở cổng bucket 55333, không qua API; sửa chữ ký 403.

**Nói:** Ảnh không còn nằm trong PostgreSQL. Payload danh sách 3 ảnh khoảng 200 KB giảm từ 800 106 byte xuống 1 870 byte. URL ký sống 5 phút và là bearer trong thời gian đó, đây là cái giá phải chấp nhận.

### Phần 5: Cái giá đã đo (1 phút 30, slide)

| Lượt VM (cùng máy, 100 user) | H0 so với M | H1 so với H0 |
| ---------------------------- | ----------- | ------------ |
| p95 toàn bộ                  | 2,78×       | 0,868×       |
| CPU mỗi request              | 4,72×       | 0,884×       |
| RAM server                   | 3,30×       | 0,988×       |

**Nói:**

- "Thí nghiệm so sánh có kiểm soát giữa các phương án kiến trúc trên cùng phần cứng, không phải benchmark năng lực production. Môi trường một máy loopback còn có lợi cho microservice, nên chi phí thật của việc tách service ít nhất bằng con số đo được."
- Tách service đắt hơn, và tối ưu không xóa được khoảng cách. H0 gộp cả tính năng thêm sau monolith, nên 2,78× không phải toàn bộ là giá của việc tách.
- Giữ vì ranh giới dữ liệu, cô lập lỗi có phạm vi rõ, và đơn vị bàn giao; không phải vì hiệu năng. Có điều kiện quay lại monolith ([ADR-P14](../../phase2-plan/architecture-work/adr-p14-keep-service-split.md)).
- Dự án cũng đã gỡ CQRS sau khi đo thấy không có lợi: quyết định theo dữ liệu.

## 3. Câu hỏi có thể gặp

| Câu hỏi                            | Trả lời ngắn                                                                             | Nguồn                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Sao không quay lại monolith?       | Được về hiệu năng; giữ vì các lý do khác, có điều kiện quay lại                          | [ADR-P14](../../phase2-plan/architecture-work/adr-p14-keep-service-split.md) |
| Core chạy 2 instance có lợi không? | Ở tải đã đo thì không (H2/H1 0,980 và 1,027), máy mới dùng 8–9% CPU. Chưa đo khi bão hòa | [Bridge](../../phase2-plan/bridge/README-20261028.md)                        |
| Sao số VM khác số Kaggle (4,96)?   | Khác môi trường và cấu hình; không chia cho nhau                                         | [Bridge](../../phase2-plan/bridge/README-20261028.md)                        |
| Sao gỡ CQRS?                       | Đo thấy không có lợi cho danh sách này                                                   | [12](12-pattern-tradeoffs-20261028.md) dòng 10                               |
| Code hiện tại đã đo chưa?          | Chưa. Số VM là của `2841d1b`, các thay đổi sau đó chưa đo                                | [12](12-pattern-tradeoffs-20261028.md)                                       |

## 4. Khi có sự cố và kết thúc

- Terminal 1 thoát với lỗi `0xC0000409`: lỗi chập chờn đã biết trên Windows. Chạy lại lệnh ở terminal 1, rồi dán lại khối hàm trợ giúp.
- Stack không lên kịp: dùng kết quả có sẵn, [`p03-after-20261029/result.json`](../../benchmarks/phase2/Results/p03-after-20261029/result.json), và chạy tiếp phần 5.
- Kết thúc: Ctrl+C ở terminal 1, rồi:

```powershell
docker compose -f deploy/phase2/compose.test.yml stop
docker desktop stop
```

Không dùng `down -v`.
