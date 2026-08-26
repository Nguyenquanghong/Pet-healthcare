import { statusTone } from "../../utils/statusLabels";

export function StatusBadge({ children, status }: { children: string; status?: string }) {
  const tone = status ? statusTone(status) : children.includes("Chờ") || children.includes("Cần") ? "bg-amber-100 text-amber-700 border-amber-200" : "bg-emerald-100 text-emerald-700 border-emerald-200";
  return <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-semibold ${tone}`}>{children}</span>;
}
