import { CareNotesPanel } from "../../components/owner/booking/CareNotesPanel";
import { usePagedList } from "../../services/usePagedList";
import { Pagination } from "../../components/ui/Pagination";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CheckCircle2, Hotel, PawPrint, Plus, Ban, HeartPulse, Smile, X, MessageSquareText } from "lucide-react";
import { OwnerLayout } from "../../components/layout/owner/OwnerLayout";
import { AdditionalServicesCard } from "../../components/owner/booking/AdditionalServicesCard";
import { BookingSummary } from "../../components/owner/booking/BookingSummary";
import { RoomTypeCard } from "../../components/owner/booking/RoomTypeCard";
import { SelectPetCard } from "../../components/owner/booking/SelectPetCard";
import { StayDatesCard } from "../../components/owner/booking/StayDatesCard";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Textarea } from "../../components/ui/Textarea";
import { useAppStore } from "../../store/AppStoreProvider";
import type { HotelBooking, HotelRoomType, HotelServiceKey } from "../../types/booking";
import { calculateBookingTotal, calculateNights } from "../../utils/bookingCalculator";
import { formatCurrency } from "../../utils/formatCurrency";
import { bookingStatusLabels, eatingStatusLabels, moodLabels } from "../../utils/statusLabels";
import { compareBookingStatus } from "../../utils/bookingOrder";

const BOOKING_STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 border border-amber-200",
  confirmed: "bg-blue-50 text-blue-700 border border-blue-200",
  in_stay: "bg-indigo-50 text-indigo-700 border border-indigo-200",
  checked_out: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  rejected: "bg-rose-50 text-rose-700 border border-rose-200",
  cancelled: "bg-slate-100 text-slate-500 border border-slate-200",
};

export function HotelBookingPage() {
  const navigate = useNavigate();
  const { createHotelBooking, cancelHotelBooking, currentOwnerId, ownerPets } = useAppStore();
  const [petId, setPetId] = useState(ownerPets[0]?.id ?? "");
  const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  const nextDay = () => new Date(new Date(`${today()}T00:00:00.000Z`).getTime() + 86_400_000).toISOString().slice(0, 10);
  const [checkIn, setCheckIn] = useState(today);
  const [checkOut, setCheckOut] = useState(nextDay);
  const [roomType, setRoomType] = useState<HotelRoomType>("deluxe");
  const [serviceKeys, setServiceKeys] = useState<HotelServiceKey[]>(["special_diet"]);
  const [ownerNote, setOwnerNote] = useState("");
  const [bookingError, setBookingError] = useState("");
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const request = useRef<{ payload: string; key: string } | null>(null);

  const [cancelTarget, setCancelTarget] = useState<HotelBooking | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [feedbackMsg, setFeedbackMsg] = useState("");

  useEffect(() => {
    if (!ownerPets.some((pet) => pet.id === petId)) setPetId(ownerPets[0]?.id ?? "");
  }, [ownerPets, petId]);

  const nights = calculateNights(checkIn, checkOut);
  const datesValid = /^\d{4}-\d{2}-\d{2}$/.test(checkIn) && /^\d{4}-\d{2}-\d{2}$/.test(checkOut)
    && checkIn >= today() && nights >= 1;
  const total = datesValid ? calculateBookingTotal(roomType, serviceKeys, nights) : 0;
  const selectedPet = ownerPets.find((p) => p.id === petId);
  const list = usePagedList<HotelBooking>("/hotel-bookings");
  const ownerBookings = list.items;


  const toggleService = (key: HotelServiceKey) =>
    setServiceKeys((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));

  const handleSubmit = async () => {
    if (!petId || !datesValid || sending.current) return;
    const input = { petId, checkIn, checkOut, roomType, serviceKeys, ownerNote };
    const payload = JSON.stringify({ ...input, serviceKeys: [...serviceKeys].sort() });
    if (request.current?.payload !== payload) request.current = { payload, key: crypto.randomUUID() };
    sending.current = true; setPending(true); setBookingError("");
    try {
      const result = await createHotelBooking(input, request.current.key);
      navigate(`/owner/hotel-bookings/${result.booking.id}`, { replace: true, state: { booking: result.booking, refreshWarning: !result.refreshed } });
    } catch (reason) { setBookingError(reason instanceof Error ? reason.message : "Không thể gửi yêu cầu đặt phòng."); }
    finally { sending.current = false; setPending(false); }
  };

  const handleConfirmCancel = async () => {
    if (!cancelTarget || sending.current) return;
    sending.current = true; setPending(true); setBookingError("");
    try {
      const refreshed = await cancelHotelBooking(cancelTarget.id, cancelReason.trim() || undefined, cancelTarget.statusRevision);
      setCancelTarget(null); setCancelReason("");
      setFeedbackMsg(refreshed ? "Đã hủy đặt chỗ khách sạn." : "Đã hủy; danh sách chưa tải lại được. Hãy làm mới trang để đối chiếu.");
    } catch (reason) { setBookingError(reason instanceof Error ? reason.message : "Không thể hủy đặt phòng."); }
    finally { sending.current = false; setPending(false); }
  };

  return (
    <OwnerLayout title="Đặt chỗ khách sạn thú cưng">
      <Pagination {...list} />
      {ownerPets.length === 0 ? (
        <EmptyState
          icon={<PawPrint size={42} />}
          title="Cần thêm thú cưng trước khi đặt hotel"
          description="Booking khách sạn cần liên kết với hồ sơ thú cưng để lưu dặn dò chăm sóc, dị ứng và cập nhật lưu trú."
          action={
            <Link to="/owner/pets">
              <Button icon={<Plus size={16} />}>Thêm thú cưng</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <div>
            <section className="rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
              <h2 className="mb-5 flex items-center gap-2 text-lg font-semibold text-slate-900">
                <Hotel size={20} className="text-primary" />
                Thông tin đặt phòng
              </h2>

              {bookingError && <p role="alert" className="mb-5 rounded-md bg-rose-50 p-3 text-sm text-rose-800">{bookingError}</p>}

              {feedbackMsg && (
                <div className="mb-5 flex items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
                  <CheckCircle2 size={16} /> {feedbackMsg}
                </div>
              )}

              <div className="space-y-4">
                <SelectPetCard ownerPets={ownerPets} petId={petId} onPetChange={setPetId} />
                <StayDatesCard checkIn={checkIn} checkOut={checkOut} onCheckInChange={setCheckIn} onCheckOutChange={setCheckOut} />
                {!datesValid && <p role="alert" className="text-sm text-rose-700">Chọn ngày nhận từ hôm nay và ngày trả sau ngày nhận ít nhất một đêm.</p>}
                <RoomTypeCard roomType={roomType} onRoomTypeChange={setRoomType} />
                <AdditionalServicesCard serviceKeys={serviceKeys} onToggleService={toggleService} />
                <Textarea
                  label="Dặn dò chăm sóc"
                  value={ownerNote}
                  onChange={(event) => setOwnerNote(event.target.value)}
                  placeholder="Chế độ ăn, thuốc, thói quen, dị ứng, giờ đưa đón..."
                />
              </div>
            </section>
          </div>

          <div className="space-y-6">
            <BookingSummary
              selectedPet={selectedPet}
              nights={datesValid ? nights : 0}
              roomType={roomType}
              total={total}
              disabled={!petId || !datesValid || pending}
              onSubmit={handleSubmit}
            />

            {/* List of bookings */}
            <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className="border-b border-slate-100 px-5 py-4">
                <h3 className="font-bold text-slate-900">Booking của bạn</h3>
              </div>
              <div className="divide-y divide-slate-100">
                {ownerBookings.map((b) => {
                  const pet = list.related.pets.find((p) => p.id === b.petId);
                  const canCancel = ["pending", "confirmed"].includes(b.status);

                  return (
                    <div key={b.id} className="p-5 space-y-3.5">
                      <Link className="text-sm font-semibold text-primary underline" to={`/owner/hotel-bookings/${b.id}`}>Xem chi tiết đặt phòng</Link>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-bold text-slate-900">{pet?.name ?? b.petId}</p>
                          <p className="text-sm text-slate-500 mt-0.5">
                            {b.checkIn} &rarr; {b.checkOut} &bull; {b.nights} đêm &bull;{" "}
                            <span className="capitalize">{b.roomType}</span>
                          </p>
                          <p className="text-sm font-bold text-primary mt-1">{formatCurrency(b.totalAmount)}</p>
                          {b.ownerNote && (
                            <p className="mt-1 rounded-md border border-slate-100 bg-slate-50 p-2 text-xs text-slate-500">
                              📝 {b.ownerNote}
                            </p>
                          )}
                        </div>

                        <div className="flex flex-col items-end gap-2">
                          <span
                            className={`flex-shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold ${
                              BOOKING_STATUS_STYLES[b.status] ?? "bg-slate-100 text-slate-600"
                            }`}
                          >
                            {bookingStatusLabels[b.status] ?? b.status}
                          </span>

                          {canCancel && (
                            <button
                              onClick={() => setCancelTarget(b)}
                              className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-600 transition-colors hover:bg-rose-100 hover:text-rose-700"
                            >
                              <Ban size={12} /> Hủy booking
                            </button>
                          )}
                        </div>
                      </div>

                      <CareNotesPanel bookingId={b.id} />
                    </div>
                  );
                })}
                {ownerBookings.length === 0 && (
                  <p className="px-5 py-8 text-center text-sm text-slate-400">Chưa có booking nào.</p>
                )}
              </div>
            </section>
          </div>
        </div>
      )}

      {/* Cancel Booking Modal */}
      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md animate-scaleUp rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2 text-rose-600">
                <Ban size={20} />
                Hủy đặt chỗ khách sạn
              </h3>
              <button
                onClick={() => setCancelTarget(null)}
                className="text-slate-400 hover:text-slate-600 rounded-lg p-1"
              >
                <X size={18} />
              </button>
            </div>

            <div className="my-4 space-y-3 text-sm">
              {bookingError && <p role="alert" className="text-rose-700">{bookingError}</p>}
              <p className="text-slate-600">
                Bạn có chắc chắn muốn hủy yêu cầu lưu trú từ <strong>{cancelTarget.checkIn}</strong> đến{" "}
                <strong>{cancelTarget.checkOut}</strong> không?
              </p>
              <Textarea
                label="Lý do hủy (tùy chọn)"
                placeholder="Thay đổi lịch trình, đã có người chăm sóc..."
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
              />
            </div>

            <div className="flex gap-3 pt-2">
              <Button variant="outline" onClick={() => setCancelTarget(null)} className="flex-1">
                Quay lại
              </Button>
              <Button
                variant="danger"
                disabled={pending}
                onClick={() => void handleConfirmCancel()}
                className="flex-1 bg-rose-600 hover:bg-rose-700 text-white"
              >
                Xác nhận hủy
              </Button>
            </div>
          </div>
        </div>
      )}
    </OwnerLayout>
  );
}
