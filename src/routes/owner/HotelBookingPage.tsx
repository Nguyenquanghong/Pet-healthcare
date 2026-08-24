import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Hotel, PawPrint, Plus } from "lucide-react";
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
import type { HotelRoomType, HotelServiceKey } from "../../types/booking";
import { calculateBookingTotal, calculateNights } from "../../utils/bookingCalculator";
import { formatCurrency } from "../../utils/formatCurrency";
import { bookingStatusLabels } from "../../utils/statusLabels";

const BOOKING_STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 border border-amber-200",
  confirmed: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  checked_in: "bg-blue-50 text-blue-700 border border-blue-200",
  completed: "bg-slate-100 text-slate-600 border border-slate-200",
  rejected: "bg-rose-50 text-rose-700 border border-rose-200",
  cancelled: "bg-slate-100 text-slate-500 border border-slate-200",
};

export function HotelBookingPage() {
  const { createHotelBooking, currentOwnerId, hotelBookings, ownerPets } = useAppStore();
  const [petId, setPetId] = useState(ownerPets[0]?.id ?? "");
  const [checkIn, setCheckIn] = useState("2026-11-10");
  const [checkOut, setCheckOut] = useState("2026-11-13");
  const [roomType, setRoomType] = useState<HotelRoomType>("deluxe");
  const [serviceKeys, setServiceKeys] = useState<HotelServiceKey[]>(["special_diet"]);
  const [ownerNote, setOwnerNote] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!ownerPets.some((pet) => pet.id === petId)) setPetId(ownerPets[0]?.id ?? "");
  }, [ownerPets, petId]);

  const nights = Math.max(calculateNights(checkIn, checkOut), 1);
  const total = calculateBookingTotal(roomType, serviceKeys, nights);
  const selectedPet = ownerPets.find(p => p.id === petId);
  const ownerBookings = useMemo(
    () => hotelBookings.filter(b => b.ownerId === currentOwnerId),
    [currentOwnerId, hotelBookings],
  );

  const toggleService = (key: HotelServiceKey) =>
    setServiceKeys(cur => cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key]);

  const handleSubmit = () => {
    if (!petId) return;
    createHotelBooking({ petId, checkIn, checkOut, roomType, serviceKeys, ownerNote });
    setOwnerNote("");
    setSuccess(true);
    setTimeout(() => setSuccess(false), 3000);
  };

  return (
    <OwnerLayout title="Đặt chỗ khách sạn thú cưng">
      {ownerPets.length === 0 ? (
        <EmptyState
          icon={<PawPrint size={42} />}
          title="Cần thêm thú cưng trước khi đặt hotel"
          description="Booking khách sạn cần liên kết với hồ sơ thú cưng để lưu dặn dò chăm sóc, dị ứng và cập nhật lưu trú."
          action={<Link to="/owner/pets"><Button icon={<Plus size={16} />}>Thêm thú cưng</Button></Link>}
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

            <div className="space-y-4">
              <SelectPetCard ownerPets={ownerPets} petId={petId} onPetChange={setPetId} />
              <StayDatesCard checkIn={checkIn} checkOut={checkOut} onCheckInChange={setCheckIn} onCheckOutChange={setCheckOut} />
              <RoomTypeCard roomType={roomType} onRoomTypeChange={setRoomType} />
              <AdditionalServicesCard serviceKeys={serviceKeys} onToggleService={toggleService} />
              <Textarea label="Dặn dò" value={ownerNote} onChange={(event) => setOwnerNote(event.target.value)} placeholder="Chế độ ăn, thuốc, thói quen, dị ứng..." />
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <BookingSummary selectedPet={selectedPet} nights={nights} roomType={roomType} total={total} disabled={!petId} onSubmit={handleSubmit} />

          <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
            <div className="border-b border-slate-100 px-5 py-4">
              <h3 className="font-bold text-slate-900">Booking của bạn</h3>
            </div>
            <div className="divide-y divide-slate-100">
              {ownerBookings.map(b => (
                <div key={b.id} className="p-5 flex items-start justify-between gap-3">
                  <div>
                    <p className="font-bold text-slate-900">
                      {ownerPets.find(p => p.id === b.petId)?.name ?? b.petId}
                    </p>
                    <p className="text-sm text-slate-500 mt-0.5">{b.checkIn} → {b.checkOut} · {b.nights} đêm</p>
                    <p className="text-sm font-bold text-primary mt-1">{formatCurrency(b.totalAmount)}</p>
                  </div>
                  <span className={`flex-shrink-0 rounded-lg px-2.5 py-1 text-xs font-bold ${BOOKING_STATUS_STYLES[b.status] ?? "bg-slate-100 text-slate-600"}`}>
                    {bookingStatusLabels[b.status]}
                  </span>
                </div>
              ))}
              {ownerBookings.length === 0 && (
                <p className="px-5 py-8 text-center text-sm text-slate-400">Chưa có booking nào.</p>
              )}
            </div>
          </div>
        </div>
      </div>
      )}
    </OwnerLayout>
  );
}