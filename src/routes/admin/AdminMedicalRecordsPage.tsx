import { AppLayout } from "../../components/layout/AppLayout";
import { RecordList } from "../../components/shared/RecordList";
import { Card } from "../../components/ui/Card";

export function AdminMedicalRecordsPage() {
  return <AppLayout type="admin" title="Quản lý hồ sơ y tế"><Card><RecordList /></Card></AppLayout>;
}