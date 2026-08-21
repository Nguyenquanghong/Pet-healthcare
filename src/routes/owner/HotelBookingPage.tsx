import { AppLayout } from "../../components/layout/AppLayout";
import { Card } from "../../components/ui/Card";
import { formatCurrency } from "../../utils/formatCurrency";

export function HotelBookingPage() {
  const total = 5500 * 3 + 1200 * 3;
  return <AppLayout type="owner" title="Đặt chỗ khách sạn thú cưng"><div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]"><Card title="Booking Form"><div className="grid gap-4 md:grid-cols-2"><Field label="Check-in" value="2026-11-10" /><Field label="Check-out" value="2026-11-13" /><Field label="Pet" value="Yuki - Shiba Inu" /><Field label="Room" value="Deluxe Suite" /></div></Card><Card title="Booking Summary"><SummaryRow label="Guest" value="Yuki" /><SummaryRow label="Duration" value="3 nights" /><SummaryRow label="Room" value={formatCurrency(16500)} /><SummaryRow label="Special Diet" value={formatCurrency(3600)} /><div className="mt-4 border-t pt-4"><SummaryRow label="Total" value={formatCurrency(total)} bold /></div><button className="mt-5 w-full rounded-xl bg-primary px-4 py-3 font-bold text-white">Confirm Booking</button></Card></div></AppLayout>;
}

function Field({ label, value }: { label: string; value: string }) { return <label className="block"><span className="text-sm font-bold text-slate-600">{label}</span><input className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3" defaultValue={value} /></label>; }
function SummaryRow({ label, value, bold = false }: { label: string; value: string; bold?: boolean }) { return <div className={`flex justify-between py-2 ${bold ? "text-xl font-black" : "text-sm"}`}><span>{label}</span><span>{value}</span></div>; }