import { Loader2 } from "lucide-react";

interface LoadingSpinnerProps {
  size?: number;
  label?: string;
  className?: string;
}

export function LoadingSpinner({ size = 24, label, className = "" }: LoadingSpinnerProps) {
  return (
    <div className={`inline-flex items-center gap-2 text-slate-500 font-medium ${className}`}>
      <Loader2 size={size} className="animate-spin text-primary" />
      {label && <span className="text-xs">{label}</span>}
    </div>
  );
}

export function LoadingOverlay({ message = "Đang xử lý dữ liệu..." }: { message?: string }) {
  return (
    <div className="loading-overlay fixed inset-0 z-50 flex flex-col items-center justify-center bg-slate-900/40">
      <div className="flex animate-scaleUp flex-col items-center gap-3 rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
        <Loader2 size={36} className="animate-spin text-primary" />
        <p className="text-sm font-bold text-slate-800">{message}</p>
      </div>
    </div>
  );
}
