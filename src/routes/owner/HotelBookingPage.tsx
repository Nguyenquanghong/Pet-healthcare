import { useMemo, useState } from "react";
import { AppLayout } from "../../components/layout/AppLayout";
import { Card } from "../../components/ui/Card";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { useAppStore } from "../../store/AppStoreProvider";
import type { HotelRoomType, HotelServiceKey } from "../../types/booking";
import { calculateBookingTotal, calculateNights, HOTEL_SERVICE_PRICES, ROOM_PRICES } from "../../utils/bookingCalculator";
import { formatCurrency } from "../../utils/formatCurrency";
import { bookingStatusLabels } from "../../utils/statusLabels";

export function HotelBookingPage() {
  const { createHotelBooking, currentOwnerId, hotelBookings, ownerPets } = useAppStore();
  const [petId, setPetId] = useState(ownerPets[0]?.id ?? "");
  const [checkIn, setCheckIn] = useState("2026-11-10");
  const [checkOut, setCheckOut] = useState("2026-11-13");
  const [roomType, setRoomType] = useState<HotelRoomType>("deluxe");
  const [serviceKeys, setServiceKeys] = useState<HotelServiceKey[]>(["special_diet"]);
  const [ownerNote, setOwnerNote] = useState("");
  const nights = Math.max(calculateNights(checkIn, checkOut), 1);
  const total = calculateBookingTotal(roomType, serviceKeys, nights);
  const selectedPet = ownerPets.find((pet) => pet.id === petId);
  const ownerBookings = useMemo(() => hotelBookings.filter((booking) => booking.ownerId === currentOwnerId), [currentOwnerId, hotelBookings]);

  const toggleService = (serviceKey: HotelServiceKey) => setServiceKeys((current) => current.includes(serviceKey) ? current.filter((key) => key !== serviceKey) : [...current, serviceKey]);
  const submitBooking = () => {
    if (!petId) return;
    createHotelBooking({ petId, checkIn, checkOut, roomType, serviceKeys, ownerNote });
  };

  return <AppLayout type="owner" title="Đặt chỗ khách sạn thú cưng"><div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]"><Card title="Booking Form"><div className="grid gap-4 md:grid-cols-2"><label className="block"><span className="text-sm font-bold text-slate-600">Check-in</span><input type="date" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" value={checkIn} onChange={(event) => setCheckIn(event.target.value)} /></label><label className="block"><span className="text-sm font-bold text-slate-600">Check-out</span><input type="date" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" value={checkOut} onChange={(event) => setCheckOut(event.target.value)} /></label><label className="block"><span className="text-sm font-bold text-slate-600">Pet</span><select className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" value={petId} onChange={(event) => setPetId(event.target.value)}>{ownerPets.map((pet) => <option key={pet.id} value={pet.id}>{pet.name} - {pet.breed}</option>)}</select></label><label className="block"><span className="text-sm font-bold text-slate-600">Room</span><select className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" value={roomType} onChange={(event) => setRoomType(event.target.value as HotelRoomType)}><option value="standard">Standard Cabin - {formatCurrency(ROOM_PRICES.standard)}/đêm</option><option value="deluxe">Deluxe Suite - {formatCurrency(ROOM_PRICES.deluxe)}/đêm</option></select></label></div><div className="mt-5"><p className="mb-3 text-sm font-bold text-slate-600">Dịch vụ thêm</p><div className="grid gap-3 md:grid-cols-2">{Object.entries(HOTEL_SERVICE_PRICES).map(([key, service]) => <label key={key} className="flex items-center gap-3 rounded-xl border border-slate-200 p-3 text-sm"><input type="checkbox" checked={serviceKeys.includes(key as HotelServiceKey)} onChange={() => toggleService(key as HotelServiceKey)} /><span>{service.label} · {formatCurrency(service.price)}{service.unit === "day" ? "/ngày" : ""}</span></label>)}</div></div><label className="mt-5 block"><span className="text-sm font-bold text-slate-600">Ghi chú</span><textarea className="mt-2 min-h-24 w-full rounded-xl border border-slate-200 px-4 py-3" value={ownerNote} onChange={(event) => setOwnerNote(event.target.value)} placeholder="Dặn dò ăn uống, thuốc, thói quen..." /></label></Card><Card title="Booking Summary"><SummaryRow label="Guest" value={selectedPet?.name ?? "Chưa chọn"} /><SummaryRow label="Duration" value={`${nights} nights`} /><SummaryRow label="Room" value={formatCurrency(ROOM_PRICES[roomType] * nights)} /><SummaryRow label="Services" value={formatCurrency(total - ROOM_PRICES[roomType] * nights)} /><div className="mt-4 border-t pt-4"><SummaryRow label="Total" value={formatCurrency(total)} bold /></div><button onClick={submitBooking} className="mt-5 w-full rounded-xl bg-primary px-4 py-3 font-bold text-white">Confirm Booking</button></Card><Card title="Booking của bạn" className="xl:col-span-2"><div className="grid gap-3 md:grid-cols-2">{ownerBookings.map((booking) => <div key={booking.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-bold">{ownerPets.find((pet) => pet.id === booking.petId)?.name ?? booking.petId}</p><p className="text-sm text-slate-500">{booking.checkIn} → {booking.checkOut} · {booking.nights} đêm</p></div><StatusBadge status={booking.status}>{bookingStatusLabels[booking.status]}</StatusBadge></div><p className="mt-3 text-sm font-bold text-primary">{formatCurrency(booking.totalAmount)}</p></div>)}</div></Card></div></AppLayout>;
}

function SummaryRow({ label, value, bold = false }: { label: string; value: string; bold?: boolean }) { return <div className={`flex justify-between py-2 ${bold ? "text-xl font-black" : "text-sm"}`}><span>{label}</span><span>{value}</span></div>; }