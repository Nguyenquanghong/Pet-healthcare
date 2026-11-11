# Chạy thử VNPay Sandbox

**Dành cho pha sau. Pha 1 hiện dùng chuyển khoản thủ công và thanh toán tại cửa hàng; không cần làm các bước bên dưới để demo pha 1.** VNPay tắt mặc định với `VNPAY_ENABLED=false`. Giữ tài liệu này để tiếp tục tích hợp khi triển khai pha sau.

Hướng dẫn cho ứng dụng hiện tại: tiền VND, hóa đơn sau khi hoàn tất dịch vụ. Sandbox không thu tiền thật. Không nhập tài khoản ngân hàng bất kỳ để thay thế mã merchant/khóa ký.

## 1. Đăng ký merchant thử nghiệm

Mở [trang đăng ký VNPay Sandbox](https://sandbox.vnpayment.vn/devreg/).

- Tên website: có thể đặt **Nipopeto Pet Healthcare Demo**.
- Địa chỉ URL: URL website thử nghiệm bạn thực sự dùng.
- Email: email bạn nhận được thư.
- Tự đặt mật khẩu cho tài khoản Sandbox, nhập lại mật khẩu và mã xác nhận.

**Nếu báo “Không đúng định dạng Url” khi nhập localhost:** quy tắc kiểm tra của biểu mẫu (đã đọc ngày 30/09/2026) yêu cầu tên miền có dấu chấm và đuôi chữ 2–10 ký tự. `http://localhost:5173` và địa chỉ IP `http://127.0.0.1:5173` không qua kiểm tra này. Với demo local, có thể nhập `http://nipopeto.localhost:5173`: địa chỉ này qua quy tắc định dạng phía trình duyệt. `.localhost` dành cho máy local, không phải website công khai; việc qua định dạng không đảm bảo yêu cầu đăng ký được VNPay duyệt. Cấu hình Return URL vẫn trỏ về origin mà bạn đăng nhập ứng dụng (mặc định `http://localhost:5173/owner/billing`), để giữ phiên đăng nhập. IPN vẫn cần địa chỉ backend công khai riêng.

Theo [tài liệu tích hợp VNPay](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html), thông tin kết nối được gửi về email đăng ký. Lấy **TmnCode** và **HashSecret** từ thông tin được cấp; không lấy khóa mẫu trên Internet.

## 2. Điền cấu hình trên máy

Từ thư mục gốc dự án, nếu chưa có file cấu hình:

```powershell
if (!(Test-Path backend/.env)) {
    Copy-Item backend/.env.example backend/.env
}
```

Mở `backend/.env`. Điền `DATABASE_URL`, `JWT_SECRET` cho môi trường của bạn, rồi thêm thông tin VNPay:

```dotenv
VNPAY_TMN_CODE=<TmnCode được cấp>
VNPAY_ENABLED=true
VNPAY_HASH_SECRET=<HashSecret được cấp>
VNPAY_RETURN_URL=http://localhost:5173/owner/billing
```

Dấu `<...>` là chỗ cần thay, không phải cấu hình để chạy. Giữ khóa trong file local đã được Git bỏ qua. Nếu dùng Compose, đặt các giá trị trong `.env.docker` theo README chính.

Kiểm tra mà không in khóa:

```powershell
npm run check:vnpay -w backend
```

Kết quả đạt chỉ xác nhận định dạng cấu hình; chưa chứng minh merchant được VNPay chấp nhận.

## 3. Chuẩn bị backend và địa chỉ nhận IPN

Áp dụng migration cho database đã cấu hình, build rồi chạy ứng dụng:

```powershell
npm run db:deploy -w backend
npm run build
npm run dev
```

Với database cũ, thực hiện kiểm tra trùng hóa đơn theo README trước khi migrate. Không seed lại database có dữ liệu cần giữ.

Backend cần một địa chỉ HTTPS công khai để VNPay gọi lại. Chỉ dùng môi trường thử nghiệm và database thử nghiệm khi đưa backend ra ngoài. URL đăng ký IPN:

```text
https://<địa chỉ backend thử nghiệm>/api/payments/vnpay/ipn
```

IPN URL trỏ tới **backend**; Return URL trỏ tới **frontend**. Cấu hình Return URL không tự đăng ký IPN URL với VNPay. Gửi/đăng ký IPN URL với VNPay theo thông tin hướng dẫn merchant được cấp.

Nếu chưa có địa chỉ backend công khai, chưa thể xác nhận bài kiểm thử IPN đầu cuối. QueryDR trong ứng dụng có thể truy vấn từ backend để đối soát nhưng không thay thế bằng chứng IPN thực tế.

## 4. Thử một hóa đơn

1. Đăng nhập admin, hoàn tất một lịch khám thử.
2. Vào **Hóa đơn → Lập hóa đơn**, chọn lịch đó. Kiểm tra khách/thú cưng tự điền, nhập dịch vụ và giá, lưu.
3. Đăng nhập đúng chủ nuôi, mở **Hóa đơn & Thanh toán**. Kiểm tra các khoản phí và tổng VND.
4. Bấm **Thanh toán VNPay**. Trang đích phải thuộc `sandbox.vnpayment.vn`.
5. Dùng thông tin thẻ/tài khoản kiểm thử theo hướng dẫn VNPay đang cung cấp. Không dùng thông tin thanh toán thật.
6. Sau khi trở về ứng dụng, chờ xác nhận và tải lại hóa đơn. Return URL riêng lẻ không làm hóa đơn thành đã thanh toán.
7. Kiểm tra hóa đơn ở cả admin và chủ nuôi: đã thanh toán, phương thức VNPay, thời điểm thu tiền. Tải lại trang để kiểm tra dữ liệu đã lưu.
8. Nếu chậm, dùng **Kiểm tra kết quả VNPay** ở trang chủ nuôi hoặc **Đối soát VNPay** ở admin.

## 5. Những trường hợp cần kiểm tra

| Trường hợp                        | Kết quả mong đợi                                               |
| --------------------------------- | -------------------------------------------------------------- |
| Chọn tại cửa hàng                 | Vẫn chờ thanh toán, admin nhận tiền rồi xác nhận               |
| Bấm VNPay nhiều lần               | Dùng lại giao dịch đang chờ, không tạo các khoản thu song song |
| Trở về trước khi IPN đến          | Không tự đánh dấu đã thanh toán                                |
| VNPay xác nhận giao dịch thất bại | Hóa đơn chưa thanh toán; khách có thể chọn lại                 |
| Chưa rõ kết quả hoặc lỗi mạng     | Giữ chờ đối soát, không thu lần hai                            |
| IPN thành công gửi lặp            | Không ghi nhận thêm tiền hoặc đổi thời điểm thu                |
| Kết quả mâu thuẫn                 | Báo admin đối soát, không tự thu thêm/hoàn tiền                |

Các ca giả chữ ký, sửa số tiền và đồng thời đã có trong `backend/tests/payments.integration.mjs`; chỉ chạy trên database local riêng có tên kết thúc `_test`.

Khi ghi nhận kết quả, phân biệt **kiểm thử nội bộ giả lập** và **giao dịch qua VNPay Sandbox đã đăng ký**. Giữ mã hóa đơn, mã giao dịch, kết quả và thời điểm; không chia sẻ HashSecret hay URL thanh toán còn nguyên chữ ký.
