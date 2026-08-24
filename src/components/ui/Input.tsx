import type { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  labelClassName?: string;
}

export function Input({ label, error, className = "", labelClassName = "", id, ...props }: InputProps) {
  const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, "-") : undefined);

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {label && (
        <label htmlFor={inputId} className={`text-sm font-bold text-slate-700 ${labelClassName}`}>
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={`w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-900 transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ${
          error ? "border-red-500 focus:border-red-500 focus:ring-red-500" : ""
        } disabled:bg-slate-50 disabled:text-slate-500`}
        {...props}
      />
      {error && <span className="text-sm text-red-500">{error}</span>}
    </div>
  );
}
