import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className = "" }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-12 text-center ${className}`}>
      {icon && <div className="mb-4 text-slate-400">{icon}</div>}
      <h3 className="mb-2 text-lg font-bold text-slate-900">{title}</h3>
      {description && <p className="mb-6 max-w-sm text-sm text-slate-500">{description}</p>}
      {action}
    </div>
  );
}
