import type { ReactNode } from "react";

type CardProps = {
  title?: string;
  children: ReactNode;
  className?: string;
};

export function Card({ title, children, className = "" }: CardProps) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-soft ${className}`}>
      {title && <h2 className="mb-4 text-lg font-bold text-slate-900">{title}</h2>}
      {children}
    </section>
  );
}