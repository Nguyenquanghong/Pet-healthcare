import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { OwnerLayout } from "../../components/layout/owner/OwnerLayout";
import { apiClient } from "../../services/apiClient";
import { useAppStore } from "../../store/AppStoreProvider";
import type { HotelBooking } from "../../types/booking";
import { formatCurrency } from "../../utils/formatCurrency";
import { bookingStatusLabels } from "../../utils/statusLabels";

export function HotelBookingDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const { ownerPets, currentOwner } = useAppStore();
  const [booking, setBooking] = useState<HotelBooking | null>(location.state?.booking?.id === id ? location.state.booking : null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void apiClient.get<{ booking: HotelBooking }>(`/hotel-bookings/${id}`).then(result => {
      if (active) setBooking(result.booking);
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : "Không thể cập nhật chi tiết đặt phòng.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id]);
  const pet = ownerPets.find(item => item.id === booking?.petId);
  return <OwnerLayout title="Chi tiết đặt phòng">
    {location.state?.refreshWarning && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-amber-800">Đã lưu đặt phòng. Danh sách chưa tải lại được; thông tin bên dưới được đọc trực tiếp từ đơn.</p>}
    {loading && <p role="status">Đang tải đặt phòng...</p>}
    {error && <p role="alert" className="rounded-lg bg-rose-50 p-4 text-rose-800">{error} {booking ? "Thông tin bên dưới là kết quả đã ghi nhận khi đặt phòng." : `Mã cần tra cứu: ${id}`}</p>}
    {booking && <article className="space-y-4 rounded-xl bg-white p-6 shadow-sm">
      <h2 className="text-xl font-bold">Yêu cầu đặt phòng đã được ghi nhận</h2>
      <p>Mã đặt phòng: <strong className="break-all">{booking.id}</strong></p>
      <p>Chủ nuôi: <strong>{currentOwner.fullName}</strong></p>
      <p>Trạng thái: <strong>{bookingStatusLabels[booking.status]}</strong></p>
      <p>Thú cưng: <strong>{pet?.name ?? booking.petId}</strong></p>
      <p>Ngày nhận/trả: {booking.checkIn} → {booking.checkOut} ({booking.nights} đêm)</p>
      <p>Phòng: {booking.roomType}; dịch vụ đã chọn: {booking.serviceKeys.length ? booking.serviceKeys.join(", ") : "Không có"}</p>
      <p>Tiền dự kiến: <strong>{formatCurrency(booking.totalAmount)}</strong></p>
      <p className="text-sm text-slate-600">Cửa hàng sẽ chốt hóa đơn cùng các khoản phát sinh khi kết thúc lưu trú. Bạn chưa cần thanh toán lúc đặt phòng.</p>
      <div className="flex flex-wrap gap-3">
        <Link className="rounded-lg border px-4 py-2" to="/owner/hotel-booking">Xem lịch đặt</Link>
        <Link className="rounded-lg border px-4 py-2" to="/owner/hotel-booking">Đặt phòng khác</Link>
        <Link className="rounded-lg border px-4 py-2" to="/owner/billing">Xem hóa đơn</Link>
      </div>
    </article>}
  </OwnerLayout>;
}
