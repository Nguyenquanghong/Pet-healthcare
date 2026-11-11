# ADR-AQ09 — Ảnh y tế: Claim Check + Valet Key

Ngày 23/10/2026. Trạng thái: ACCEPTED, hiện thực trong Clinic (chưa áp lên DB chính).

## Bối cảnh

`medical_images.image_url` lưu data URL base64 tới khoảng 7 MB trong PostgreSQL của Clinic; API danh sách trả nguyên nội dung. Mỗi trang danh sách kéo theo hàng MB qua Clinic và gateway, DB phình theo ảnh.

## Quyết định

- **Claim Check:** byte ảnh nằm trong bucket S3-compatible; dòng DB chỉ giữ claim `storage_key` (`images/<id>`), `size_bytes`, `sha256`, `mime_type`. CHECK `medical_images_content_check` buộc đúng một trong hai dạng: legacy (`image_url`) hoặc claim.
- **Valet Key:** Clinic kiểm quyền như cũ (directory Core, owner chỉ thấy pet của mình), rồi ký URL GET SigV4 hết hạn sau 5 phút (`BLOB_URL_TTL_SECONDS`, 30–900). Danh sách và phản hồi tạo ảnh trả `{id, petId, title, mimeType, createdAt, sizeBytes, url, urlExpiresAt}`, không trả base64. Frontend tải lại danh sách khi URL hết hạn.
- **Upload qua API Clinic** (không dùng URL PUT ký): giữ kiểm chữ ký file ở server (validator E-a), giới hạn 7 MB data URL như cũ. Thứ tự: ghi object → ghi dòng; ghi dòng lỗi thì xóa object.
- **Xóa:** xóa dòng và ghi `blob_cleanup` trong cùng transaction, rồi xóa object; bucket lỗi thì worker Clinic thử lại với backoff (tối đa 1 giờ).
- **Dữ liệu cũ:** migration additive (expand), CHECK thêm `NOT VALID` rồi `VALIDATE` ở migration riêng (`20261023000200`) để lần quét không khóa đọc/ghi; tool `tools/phase2/migrate-medical-images.mjs` (`--dry-run`, `--run`, `--orphans [--delete-orphans]`) chỉ chạy trên DB thử có marker, đọc lại object qua URL ký và so sha256 trước khi xóa bản inline, cập nhật bằng compare-and-set. Bước contract (`deploy/phase2/medical-images-contract.sql`: bỏ `image_url`, `storage_key`/`size_bytes`/`sha256` thành NOT NULL) chỉ chạy khi `--check-contract` báo `contractReady=true`, có backup và đi cùng bản Clinic bỏ `imageUrl` khỏi schema Prisma; guard trong SQL từ chối nếu còn dòng base64.
- Quyền tối thiểu: danh tính S3 của Clinic chỉ có `Admin/Read/Write/List` trên bucket của nó (tự tạo bucket qua S3 API lúc khởi động); bucket khác trả 403. Bucket tạo bằng `weed shell` không được S3 gateway nhận (GET trả NoSuchBucket), nên không dùng cách đó.
- Signer SigV4 tự viết (node:crypto), không thêm thư viện. Blob store: SeaweedFS 3.97 (S3 API) trong compose; MinIO không còn image công khai trên Docker Hub/quay.io.
- Không cấu hình bucket: thao tác ảnh trả 503, dòng legacy vẫn liệt kê được (`url: null`).

## Số đo (test `phase2:test:clinic`, 3 ảnh khoảng 200 KB)

Payload danh sách: 800 106 byte (data URL inline như API cũ) → 1 870 byte (metadata + URL ký), nhỏ hơn khoảng 428 lần. Dung lượng cột ảnh trong DB sau khi chuyển: 0 (bảng `medical_images` 147 456 byte gồm cả index; phần TOAST cũ chỉ được trả lại sau VACUUM).

## Hệ quả

- Bucket là phụ thuộc mới của Clinic nhưng **không** nằm trong readiness: bucket lỗi chỉ làm thao tác ảnh trả 503, lịch hẹn và bệnh án vẫn phục vụ (bulkhead). Bucket thiếu khi ghi thì Clinic tạo lại một lần rồi ghi lại.
- URL được ký theo cửa sổ 60 s (TTL/5): danh sách tải lại trong cùng cửa sổ trả cùng URL nên trình duyệt không tải lại ảnh; mỗi URL còn hạn ít nhất 80% TTL.
- Truy vấn danh sách, kiểm quyền và xóa không đọc cột `image_url` (tránh kéo base64 của dòng legacy).
- URL ký là bearer trong 5 phút: ai có URL thì xem được ảnh trong thời gian đó.
- Endpoint công khai của bucket (`BLOB_PUBLIC_ENDPOINT`) phải truy cập được từ trình duyệt.
