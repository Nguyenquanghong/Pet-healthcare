# NIPONETO — Manual Test Checklist

Sử dụng checklist này để kiểm thử hồi quy (regression testing) sau mỗi lần cập nhật tính năng quan trọng.

> **Tài khoản Demo:**
> - Owner: SĐT `0901234567` (Nguyễn Văn A — pet Mochi & Yuki)
> - Admin: Username `admin` / Password `admin123`

---

## ✅ Luồng Owner

### 1. Owner — Đăng ký tài khoản mới
- [ ] Vào trang `/register`
- [ ] Điền đầy đủ thông tin (họ tên, SĐT, địa chỉ)
- [ ] Nhấn **Đăng ký** → Chuyển sang luồng thêm thú cưng
- [ ] Thêm thú cưng đầu tiên → Chuyển hướng về `/owner/dashboard`
- [ ] Dashboard hiển thị pet vừa tạo (không còn Empty state)

---

### 2. Owner — Thêm thú cưng mới
- [ ] Vào `/owner/pets`
- [ ] Nhấn **Thêm thú cưng mới**
- [ ] Điền tên, giống, loài, giới tính, cân nặng
- [ ] Lưu → Pet mới xuất hiện trong danh sách
- [ ] Badge tên hiển thị đúng loài (Chó / Mèo)

---

### 3. Owner — Chỉnh sửa thú cưng
- [ ] Vào `/owner/pets` → Mở pet bất kỳ
- [ ] Nhấn **Chỉnh sửa**
- [ ] Thay đổi cân nặng hoặc ghi chú dị ứng
- [ ] Lưu → Dữ liệu cập nhật đúng ngay trên thẻ Pet

---

### 4. Owner — Đặt lịch khám
- [ ] Vào `/owner/appointments` → Nhấn **Đặt lịch mới**
- [ ] Chọn thú cưng, dịch vụ, ngày, giờ
- [ ] Nhấn **Xác nhận đặt lịch**
- [ ] Lịch khám mới xuất hiện với trạng thái `Chờ xác nhận`
- [ ] Thông báo "Đã gửi yêu cầu đặt lịch" hiển thị trong `/owner/notifications`
- [ ] Admin nhận được thông báo "Lịch khám mới" trong `/admin/notifications`

---

### 5. Owner — Hủy lịch khám
- [ ] Vào `/owner/appointments` → Chọn lịch có trạng thái `Chờ xác nhận` hoặc `Đã xác nhận`
- [ ] Nhấn **Hủy lịch** → Modal xác nhận mở
- [ ] Nhập lý do hủy → Nhấn **Xác nhận hủy**
- [ ] Trạng thái lịch chuyển sang `Đã hủy`
- [ ] Thông báo hủy xuất hiện trong `/owner/notifications`

---

### 6. Owner — Dời lịch khám
- [ ] Vào `/owner/appointments` → Chọn lịch chưa hủy
- [ ] Nhấn **Dời lịch** → Modal nhập ngày/giờ mới mở
- [ ] Chọn ngày, giờ mới → Nhấn **Xác nhận dời lịch**
- [ ] Lịch cập nhật ngày/giờ mới, trạng thái về `Chờ xác nhận`
- [ ] Thông báo dời lịch xuất hiện trong `/owner/notifications`

---

## ✅ Luồng Admin — Quản lý Lịch khám

### 7. Admin — Xác nhận lịch khám
- [ ] Đăng nhập admin → Vào `/admin/appointments`
- [ ] Tìm lịch có trạng thái `Chờ xác nhận`
- [ ] Nhấn **Xác nhận** → Trạng thái chuyển sang `Đã xác nhận`
- [ ] Owner nhận thông báo "Lịch khám đã được xác nhận"

---

### 8. Admin — Hoàn thành lịch khám
- [ ] Từ lịch đã xác nhận → Chuyển qua `Đang khám` (checked_in → in_progress)
- [ ] Nhấn **Hoàn thành** → Trạng thái chuyển `Đã hoàn thành`
- [ ] Owner nhận thông báo "Lịch khám đã hoàn thành"

---

### 9. Admin — Tạo hồ sơ bệnh án nhanh
- [ ] Từ lịch vừa hoàn thành → Nhấn **Tạo bệnh án**
- [ ] Modal tạo bệnh án mở với thông tin thú cưng pre-filled
- [ ] Điền triệu chứng, chẩn đoán, điều trị → Nhấn **Lưu bệnh án**
- [ ] Hồ sơ mới xuất hiện tại `/admin/medical-records`
- [ ] Owner nhận thông báo "Hồ sơ y tế mới đã được cập nhật"

---

### 10. Owner — Xem bệnh án theo thú cưng
- [ ] Đăng nhập Owner → Vào `/owner/medical-records`
- [ ] Bấm vào thú cưng để lọc bệnh án theo pet
- [ ] Bấm vào bệnh án → Hiển thị chi tiết đầy đủ (sinh hiệu, điều trị, vaccine, ngày tái khám)

---

## ✅ Luồng Hotel Booking

### 11. Owner — Đặt phòng Hotel
- [ ] Vào `/owner/hotel-booking` → Nhấn **Đặt phòng mới**
- [ ] Chọn thú cưng, loại phòng, ngày check-in/out, dịch vụ kèm
- [ ] Xác nhận → Booking mới xuất hiện với trạng thái `Chờ xác nhận`
- [ ] Thông báo gửi tới Owner và Admin

---

### 12. Admin — Xác nhận Hotel Booking
- [ ] Vào `/admin/hotel-bookings` → Tìm booking `Chờ xác nhận`
- [ ] Nhấn **Xác nhận** → Trạng thái chuyển `Đã xác nhận`
- [ ] Owner nhận thông báo "Hotel booking đã được xác nhận"

---

### 13. Admin — Thêm nhật ký chăm sóc hàng ngày
- [ ] Từ booking đang `In Stay` → Nhấn **Thêm nhật ký**
- [ ] Chọn mức độ ăn uống, tâm trạng, nhập ghi chú
- [ ] Lưu → Nhật ký xuất hiện trong lịch sử chăm sóc của booking
- [ ] Owner nhận thông báo cập nhật

---

### 14. Owner — Xem nhật ký chăm sóc hàng ngày
- [ ] Đăng nhập Owner → Vào `/owner/hotel-booking`
- [ ] Mở booking đang `In Stay` → Xem tab Nhật ký chăm sóc
- [ ] Các ghi chú hiển thị đúng (ngày, mức ăn, tâm trạng, nội dung)

---

### 15. Admin — Check-out Booking
- [ ] Từ booking `In Stay` → Nhấn **Check-out**
- [ ] Trạng thái chuyển `Đã trả phòng`
- [ ] Owner nhận thông báo "Hoàn tất lưu trú khách sạn"
- [ ] Hóa đơn của booking xuất hiện trong `/admin/billing` với trạng thái `Đã thanh toán`

---

## ✅ Kiểm thử Chức năng Phụ

### 16. Reset Mock Data (Admin Settings)
- [ ] Vào `/admin/settings` → Nhấn **Khôi phục dữ liệu gốc**
- [ ] Xác nhận → Toàn bộ dữ liệu tự tạo bị xóa, dữ liệu mẫu ban đầu được khôi phục
- [ ] Đăng nhập lại bằng tài khoản demo vẫn hoạt động

### 17. Notification Badge Count
- [ ] Sau khi thực hiện các hành động → Badge số đếm chưa đọc hiển thị đúng trên Topbar và Sidebar
- [ ] Bấm vào thông báo → Badge giảm số đếm, trang điều hướng đúng

### 18. Admin Analytics
- [ ] Vào `/admin/analytics` → Thẻ KPI hiển thị số liệu thực từ store
- [ ] Progress bar tỷ lệ lịch khám cập nhật theo dữ liệu thật

### 19. Admin Billing / Invoice Print
- [ ] Vào `/admin/billing` → Danh sách hóa đơn tổng hợp từ lịch khám + hotel
- [ ] Bấm **Xem / In** → Modal hóa đơn hiển thị đầy đủ thông tin
- [ ] Bấm **In Hóa đơn** → Browser Print Dialog mở

---

*Checklist version: Phase 8 — 2026-08-25*
