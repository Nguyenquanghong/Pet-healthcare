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
    <div className={`flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center ${className}`}>
      {icon && <div className="mb-3 text-slate-400">{icon}</div>}
      <h3 className="mb-1 text-base font-semibold text-slate-900">{title}</h3>
      {description && <p className="mb-5 max-w-sm text-sm leading-6 text-slate-500">{description}</p>}
      {action}
    </div>
  );
}
