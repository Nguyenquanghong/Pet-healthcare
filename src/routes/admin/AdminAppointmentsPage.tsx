import { AppLayout } from "../../components/layout/AppLayout";
import { DataTable } from "../../components/shared/DataTable";
import { Card } from "../../components/ui/Card";

export function AdminAppointmentsPage() {
  return <AppLayout type="admin" title="Quản lý lịch khám"><Card><DataTable type="appointments" /></Card></AppLayout>;
}