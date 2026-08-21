import { AppLayout } from "../../components/layout/AppLayout";
import { RecordList } from "../../components/shared/RecordList";
import { MetricCard } from "../../components/ui/MetricCard";
import { Card } from "../../components/ui/Card";

export function MedicalRecordsPage() {
  return <AppLayout type="owner" title="Hồ sơ y tế chi tiết"><div className="grid gap-6 xl:grid-cols-[1.4fr_0.8fr]"><Card title="Clinical Timeline"><RecordList /></Card><div className="grid gap-4"><MetricCard label="Weight" value="24.5 kg" /><MetricCard label="Temp" value="38.2°C" /><MetricCard label="Heart Rate" value="92 bpm" /></div></div></AppLayout>;
}