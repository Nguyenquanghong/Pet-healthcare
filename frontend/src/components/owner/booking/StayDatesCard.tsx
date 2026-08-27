import { Input } from "../../ui/Input";

interface StayDatesCardProps {
  checkIn: string;
  checkOut: string;
  onCheckInChange: (value: string) => void;
  onCheckOutChange: (value: string) => void;
}

export function StayDatesCard({ checkIn, checkOut, onCheckInChange, onCheckOutChange }: StayDatesCardProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Input type="date" label="Ngày nhận phòng" value={checkIn} onChange={(event) => onCheckInChange(event.target.value)} />
      <Input type="date" label="Ngày trả phòng" value={checkOut} onChange={(event) => onCheckOutChange(event.target.value)} />
    </div>
  );
}
