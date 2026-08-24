import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
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

const BOOKING_STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 border border-amber-200",
  confirmed: "bg-blue-50 text-blue-700 border border-blue-200",
  in_stay: "bg-indigo-50 text-indigo-700 border border-indigo-200",
  checked_out: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  rejected: "bg-rose-50 text-rose-700 border border-rose-200",
  cancelled: "bg-slate-100 text-slate-500 border border-slate-200",
};

export function HotelBookingPage() {
  const { createHotelBooking, cancelHotelBooking, currentOwnerId, hotelBookings, dailyCareNotes, ownerPets } = useAppStore();
  const [petId, setPetId] = useState(ownerPets[0]?.id ?? "");
  const [checkIn, setCheckIn] = useState("2026-11-10");
  const [checkOut, setCheckOut] = useState("2026-11-13");
  const [roomType, setRoomType] = useState<HotelRoomType>("deluxe");
  const [serviceKeys, setServiceKeys] = useState<HotelServiceKey[]>(["special_diet"]);
  const [ownerNote, setOwnerNote] = useState("");
  const [success, setSuccess] = useState(false);

  const [cancelTarget, setCancelTarget] = useState<HotelBooking | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [feedbackMsg, setFeedbackMsg] = useState("");

  useEffect(() => {
    if (!ownerPets.some((pet) => pet.id === petId)) setPetId(ownerPets[0]?.id ?? "");
  }, [ownerPets, petId]);

  const nights = Math.max(calculateNights(checkIn, checkOut), 1);
  const total = calculateBookingTotal(roomType, serviceKeys, nights);
  const selectedPet = ownerPets.find((p) => p.id === petId);
  const ownerBookings = useMemo(
    () => hotelBookings.filter((b) => b.ownerId === currentOwnerId),
    [currentOwnerId, hotelBookings]
  );

  const toggleService = (key: HotelServiceKey) =>
    setServiceKeys((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));

  const handleSubmit = () => {
    if (!petId) return;
    createHotelBooking({ petId, checkIn, checkOut, roomType, serviceKeys, ownerNote });
    setOwnerNote("");
    setSuccess(true);
    setTimeout(() => setSuccess(false), 3000);
  };

  const handleConfirmCancel = () => {
    if (!cancelTarget) return;
    cancelHotelBooking(cancelTarget.id, cancelReason.trim() || undefined);
    setCancelTarget(null);
    setCancelReason("");
    setFeedbackMsg("Đã hủy đặt chỗ khách sạn thành công.");
    setTimeout(() => setFeedbackMsg(""), 3500);
  };

  return (
    <OwnerLayout title="Đặt chỗ khách sạn thú cưng">
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
        <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="mb-5 text-xl font-bold text-slate-900 flex items-center gap-2">
                <Hotel size={20} className="text-primary" />
                Thông tin đặt phòng
              </h2>

              {success && (
                <div className="mb-5 flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm font-semibold text-emerald-800">
                  <CheckCircle2 size={16} /> Đã gửi yêu cầu! Bệnh viện sẽ xác nhận trong thời gian sớm nhất.
                </div>
              )}

              {feedbackMsg && (
                <div className="mb-5 flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm font-semibold text-emerald-800">
                  <CheckCircle2 size={16} /> {feedbackMsg}
                </div>
              )}

              <div className="space-y-4">
                <SelectPetCard ownerPets={ownerPets} petId={petId} onPetChange={setPetId} />
                <StayDatesCard checkIn={checkIn} checkOut={checkOut} onCheckInChange={setCheckIn} onCheckOutChange={setCheckOut} />
                <RoomTypeCard roomType={roomType} onRoomTypeChange={setRoomType} />
                <AdditionalServicesCard serviceKeys={serviceKeys} onToggleService={toggleService} />
                <Textarea
                  label="Dặn dò chăm sóc"
                  value={ownerNote}
                  onChange={(event) => setOwnerNote(event.target.value)}
                  placeholder="Chế độ ăn, thuốc, thói quen, dị ứng, giờ đưa đón..."
                />
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <BookingSummary
              selectedPet={selectedPet}
              nights={nights}
              roomType={roomType}
              total={total}
              disabled={!petId}
              onSubmit={handleSubmit}
            />

            {/* List of bookings */}
            <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
              <div className="border-b border-slate-100 px-5 py-4">
                <h3 className="font-bold text-slate-900">Booking của bạn</h3>
              </div>
              <div className="divide-y divide-slate-100">
                {ownerBookings.map((b) => {
                  const pet = ownerPets.find((p) => p.id === b.petId);
                  const canCancel = ["pending", "confirmed"].includes(b.status);
                  const relatedNotes = dailyCareNotes.filter(
                    (note) => note.bookingId === b.id && note.visibleToOwner
                  );

                  return (
                    <div key={b.id} className="p-5 space-y-3.5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-bold text-slate-900">{pet?.name ?? b.petId}</p>
                          <p className="text-sm text-slate-500 mt-0.5">
                            {b.checkIn} &rarr; {b.checkOut} &bull; {b.nights} đêm &bull;{" "}
                            <span className="capitalize">{b.roomType}</span>
                          </p>
                          <p className="text-sm font-bold text-primary mt-1">{formatCurrency(b.totalAmount)}</p>
                          {b.ownerNote && (
                            <p className="text-xs text-slate-500 mt-1 bg-slate-50 border border-slate-100 rounded-lg p-2">
                              📝 {b.ownerNote}
                            </p>
                          )}
                        </div>

                        <div className="flex flex-col items-end gap-2">
                          <span
                            className={`flex-shrink-0 rounded-lg px-2.5 py-1 text-xs font-bold ${
                              BOOKING_STATUS_STYLES[b.status] ?? "bg-slate-100 text-slate-600"
                            }`}
                          >
                            {bookingStatusLabels[b.status] ?? b.status}
                          </span>

                          {canCancel && (
                            <button
                              onClick={() => setCancelTarget(b)}
                              className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 px-2.5 py-1 rounded-lg transition-colors"
                            >
                              <Ban size={12} /> Hủy booking
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Daily Care Notes Section for this Booking */}
                      {relatedNotes.length > 0 && (
                        <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-3.5 space-y-2.5">
                          <p className="text-xs font-bold uppercase tracking-wider text-indigo-900 flex items-center gap-1.5">
                            <MessageSquareText size={14} className="text-indigo-600" />
                            Nhật ký chăm sóc hàng ngày ({relatedNotes.length})
                          </p>
                          <div className="space-y-2">
                            {relatedNotes.map((note) => (
                              <div
                                key={note.id}
                                className="rounded-lg bg-white border border-indigo-100/80 p-3 text-xs shadow-xs space-y-1"
                              >
                                <div className="flex items-center justify-between text-slate-500 font-medium">
                                  <span className="font-bold text-slate-700">{note.date}</span>
                                  <div className="flex gap-1.5">
                                    <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 font-bold text-emerald-700 border border-emerald-200">
                                      <HeartPulse size={10} /> {eatingStatusLabels[note.eatingStatus]}
                                    </span>
                                    <span className="inline-flex items-center gap-1 rounded bg-indigo-50 px-2 py-0.5 font-bold text-indigo-700 border border-indigo-200">
                                      <Smile size={10} /> {moodLabels[note.mood]}
                                    </span>
                                  </div>
                                </div>
                                <p className="text-slate-700 leading-relaxed pt-1">{note.note}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {ownerBookings.length === 0 && (
                  <p className="px-5 py-8 text-center text-sm text-slate-400">Chưa có booking nào.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cancel Booking Modal */}
      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl animate-scaleUp">
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
                onClick={handleConfirmCancel}
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