import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";

type AppLayoutProps = {
  type: "owner" | "admin";
  title: string;
  children: ReactNode;
};

export function AppLayout({ type, title, children }: AppLayoutProps) {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <Sidebar type={type} />
      <main className="lg:ml-64">
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-5 py-4 lg:px-8">
          <div>
            <p className="text-sm font-semibold text-primary">{type === "owner" ? "Chủ thú cưng" : "Bệnh viện Thú y Mỹ Đình"}</p>
            <h1 className="text-2xl font-extrabold text-slate-950">{title}</h1>
          </div>
        </header>
        <div className="p-5 lg:p-8">{children}</div>
      </main>
    </div>
  );
}
