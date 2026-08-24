import type { HotelRoomType } from "../../../types/booking";
import type { Pet } from "../../../types/pet";
import { ROOM_PRICES } from "../../../utils/bookingCalculator";
import { formatCurrency } from "../../../utils/formatCurrency";
import { Button } from "../../ui/Button";

interface BookingSummaryProps {
  selectedPet?: Pet;
  nights: number;
  roomType: HotelRoomType;
  total: number;
  disabled?: boolean;
  onSubmit: () => void;
}

export function BookingSummary({ selectedPet, nights, roomType, total, disabled = false, onSubmit }: BookingSummaryProps) {
  const roomTotal = ROOM_PRICES[roomType] * nights;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="mb-5 text-xl font-bold text-slate-900">Tóm tắt đặt phòng</h2>
      <div className="space-y-3 text-sm">
        <div className="flex justify-between"><span className="text-slate-500">Thú cưng</span><span className="font-semibold text-slate-900">{selectedPet?.name ?? "Chưa chọn"}</span></div>
        <div className="flex justify-between"><span className="text-slate-500">Thời gian</span><span className="font-semibold text-slate-900">{nights} đêm</span></div>
        <div className="flex justify-between"><span className="text-slate-500">Phòng</span><span className="font-semibold text-slate-900">{formatCurrency(roomTotal)}</span></div>
        <div className="flex justify-between"><span className="text-slate-500">Dịch vụ thêm</span><span className="font-semibold text-slate-900">{formatCurrency(total - roomTotal)}</span></div>
        <div className="border-t border-slate-100 pt-3 flex justify-between text-xl font-black"><span>Tổng</span><span className="text-primary">{formatCurrency(total)}</span></div>
      </div>
      <Button onClick={onSubmit} disabled={disabled} className="mt-5 w-full">Xác nhận đặt phòng</Button>
    </div>
  );
}