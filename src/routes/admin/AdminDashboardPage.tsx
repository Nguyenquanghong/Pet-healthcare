import { AppLayout } from "../../components/layout/AppLayout";
import { AppointmentList } from "../../components/shared/AppointmentList";
import { DataTable } from "../../components/shared/DataTable";
import { Card } from "../../components/ui/Card";
import { MetricCard } from "../../components/ui/MetricCard";

export function AdminDashboardPage() {
  return <AppLayout type="admin" title="Admin Dashboard"><div className="grid gap-5 md:grid-cols-4"><MetricCard label="Today's Appointments" value="12" /><MetricCard label="Pending" value="4" /><MetricCard label="Hotel Guests" value="6" /><MetricCard label="Unread" value="8" /></div><div className="mt-6 grid gap-6 xl:grid-cols-2"><Card title="Today's Appointments"><AppointmentList /></Card><Card title="Pending Hotel Bookings"><DataTable type="bookings" /></Card></div></AppLayout>;
}