import { AppLayout } from "../../components/layout/AppLayout";
import { DataTable } from "../../components/shared/DataTable";
import { Card } from "../../components/ui/Card";

export function AdminPetsPage() {
  return <AppLayout type="admin" title="Quản lý thú cưng"><Card><DataTable type="pets" /></Card></AppLayout>;
}