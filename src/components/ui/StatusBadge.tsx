export function StatusBadge({ children }: { children: string }) {
  const tone = children.includes("Chờ") || children.includes("Cần") ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700";
  return <span className={`rounded-full px-3 py-1 text-xs font-semibold ${tone}`}>{children}</span>;
}