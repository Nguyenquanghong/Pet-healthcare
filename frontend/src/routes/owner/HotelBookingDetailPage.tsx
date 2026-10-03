import { CareNotesPanel } from "../../components/owner/booking/CareNotesPanel";
import { usePagedList } from "../../services/usePagedList";
import { useApiQuery } from "../../services/useApiQuery";
import type { Pet } from "../../types/pet";
import { Link, useLocation, useParams } from "react-router-dom";
import { OwnerLayout } from "../../components/layout/owner/OwnerLayout";
import { useAppStore } from "../../store/AppStoreProvider";
import type { HotelBooking } from "../../types/booking";
import { formatCurrency } from "../../utils/formatCurrency";
import { bookingStatusLabels } from "../../utils/statusLabels";

export function HotelBookingDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const { ownerPets, currentOwner } = useAppStore();
  const query = useApiQuery<{ booking: HotelBooking }>(`/hotel-bookings/${encodeURIComponent(id ?? "")}`, { enabled: Boolean(id), refreshOnTick: true });
  const snapshot: HotelBooking | null = location.state?.booking?.id === id ? location.state.booking : null;
  const booking = query.data?.booking ?? snapshot;
  const { loading, error } = query;
  const petPage = usePagedList<Pet>("/pets", { id: booking?.petId }, Boolean(booking));
  const pet = petPage.items[0] ?? ownerPets.find(item => item.id === booking?.petId);
  return <OwnerLayout title="Chi tiết đặt phòng">
    {location.state?.refreshWarning && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-amber-800">Đã lưu đặt phòng. Danh sách chưa tải lại được; thông tin bên dưới được đọc trực tiếp từ đơn.</p>}
    {loading && <p role="status">Đang tải đặt phòng...</p>}
    {error && <p role="alert" className="rounded-lg bg-rose-50 p-4 text-rose-800">{error} {booking ? "Thông tin bên dưới là dữ liệu đã tải hoặc ghi nhận trước đó của đơn này." : `Mã cần tra cứu: ${id}`} <button className="underline" onClick={() => void query.reload().catch(() => undefined)}>Thử lại chi tiết</button></p>}
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
      <CareNotesPanel bookingId={booking.id} />
      <div className="flex flex-wrap gap-3">
        <Link className="rounded-lg border px-4 py-2" to="/owner/hotel-booking">Xem lịch đặt</Link>
        <Link className="rounded-lg border px-4 py-2" to="/owner/hotel-booking">Đặt phòng khác</Link>
        <Link className="rounded-lg border px-4 py-2" to="/owner/billing">Xem hóa đơn</Link>
      </div>
    </article>}
  </OwnerLayout>;
}
