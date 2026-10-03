import { useCallback, useEffect, useRef, useState } from "react";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { apiClient } from "../../services/apiClient";
import type { Invoice } from "../../types/invoice";
import { formatCurrency } from "../../utils/formatCurrency";

type Range = "all" | "this_month" | "last_month";
const vietnamMonth = (date: Date) => new Date(date.getTime() + 7 * 3_600_000).toISOString().slice(0, 7);

export function AdminAnalyticsPage() {
  const [range, setRange] = useState<Range>("all");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [figures, setFigures] = useState({ received: 0, hotel: 0, appointment: 0, outstanding: 0, paidCount: 0, unpaidCount: 0 });
  const sequence = useRef(0);
  const currentMonth = vietnamMonth(new Date());
  const previousMonth = vietnamMonth(new Date(Date.UTC(Number(currentMonth.slice(0, 4)), Number(currentMonth.slice(5, 7)) - 2, 1)));
  const selectedMonth = range === "this_month" ? currentMonth : range === "last_month" ? previousMonth : null;
  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    const request = ++sequence.current;
    try { const result = await apiClient.get<typeof figures>("/invoices/summary" + (selectedMonth ? "?month=" + selectedMonth : "")); if (request === sequence.current) setFigures(result); }
    catch (reason) { if (request === sequence.current) setError(reason instanceof Error ? reason.message : "Không tải được báo cáo."); }
    finally { if (request === sequence.current) setLoading(false); }
  }, [selectedMonth]);
  useEffect(() => { void refresh(); }, [refresh]);

  const card = "rounded-xl border bg-white p-5";
  return <AdminLayout title="Báo cáo & Thống kê">
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-xl font-bold">Thu tiền theo hóa đơn</h2>
        <p className="text-sm text-slate-600">Đã thu tính theo thời điểm xác nhận thanh toán; chờ thu tính theo ngày phát hành hóa đơn.</p>
      </div>
      <div className="flex gap-2">
        <label className="text-sm">Khoảng thời gian
          <select value={range} onChange={event => setRange(event.target.value as Range)} className="ml-2 rounded-lg border p-2">
            <option value="all">Tất cả</option>
            <option value="this_month">Tháng này ({currentMonth})</option>
            <option value="last_month">Tháng trước ({previousMonth})</option>
          </select>
        </label>
        <button className="rounded-lg border px-3 py-2 text-sm" disabled={loading} onClick={() => void refresh()}>Tải lại</button>
      </div>
    </div>
    {loading && <p role="status">Đang tải báo cáo...</p>}
    {error && <p role="alert" className="mb-4 rounded-lg bg-rose-50 p-3 text-rose-800">{error}</p>}
    {!loading && !error && <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <section className={card}><h3>Đã thu</h3><strong className="text-2xl">{formatCurrency(figures.received)}</strong><p className="text-sm text-slate-500">{figures.paidCount} hóa đơn</p></section>
        <section className={card}><h3>Khám và spa đã thu</h3><strong className="text-2xl">{formatCurrency(figures.appointment)}</strong></section>
        <section className={card}><h3>Lưu trú đã thu</h3><strong className="text-2xl">{formatCurrency(figures.hotel)}</strong></section>
        <section className={card}><h3>Chờ thu</h3><strong className="text-2xl">{formatCurrency(figures.outstanding)}</strong><p className="text-sm text-slate-500">{figures.unpaidCount} hóa đơn</p></section>
      </div>
      {range !== "all" && <p className="mt-4 text-sm text-slate-600">Hóa đơn cũ đã thanh toán nhưng thiếu thời điểm thu tiền không được đưa vào thống kê theo tháng.</p>}
    </>}
  </AdminLayout>;
}
