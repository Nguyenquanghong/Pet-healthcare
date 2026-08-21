import { AppLayout } from "../../components/layout/AppLayout";
import { DataTable } from "../../components/shared/DataTable";
import { Card } from "../../components/ui/Card";

export function AdminHotelBookingsPage() {
  return <AppLayout type="admin" title="Quản lý Hotel Booking"><Card><DataTable type="bookings" /></Card></AppLayout>;
}