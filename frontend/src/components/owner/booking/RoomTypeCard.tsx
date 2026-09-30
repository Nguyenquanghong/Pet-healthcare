import type { HotelRoomType } from "../../../types/booking";
import { ROOM_PRICES } from "../../../utils/bookingCalculator";
import { formatCurrency } from "../../../utils/formatCurrency";

interface RoomTypeCardProps {
  roomType: HotelRoomType;
  onRoomTypeChange: (value: HotelRoomType) => void;
}

export function RoomTypeCard({ roomType, onRoomTypeChange }: RoomTypeCardProps) {
  return (
    <div>
      <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">Loại phòng</label>
      <div className="grid gap-3 sm:grid-cols-3">
        {(["standard", "deluxe", "vip"] as HotelRoomType[]).map((room) => (
          <button
            key={room}
            type="button"
            onClick={() => onRoomTypeChange(room)}
            className={`min-h-20 rounded-md border p-4 text-left transition-colors ${
              roomType === room ? "border-primary bg-primary/5" : "border-slate-200 hover:border-slate-300"
            }`}
          >
            <p className={`font-bold capitalize ${roomType === room ? "text-primary" : "text-slate-800"}`}>
              {room === "standard" ? "Standard Cabin" : room === "deluxe" ? "Deluxe Suite" : "VIP Suite"}
            </p>
            <p className="text-sm text-slate-500 mt-0.5">{formatCurrency(ROOM_PRICES[room])}/đêm</p>
          </button>
        ))}
      </div>
    </div>
  );
}
