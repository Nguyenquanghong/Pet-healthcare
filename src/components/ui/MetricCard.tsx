import { Card } from "./Card";

export function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-black text-primary">{value}</p>
    </Card>
  );
}