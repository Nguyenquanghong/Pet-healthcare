import type { ReactNode } from "react";
import { Search } from "lucide-react";
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
        <header className="sticky top-0 z-10 flex flex-col gap-4 border-b border-slate-200 bg-canvas/90 px-5 py-5 backdrop-blur md:flex-row md:items-center md:justify-between lg:px-8">
          <div>
            <p className="text-sm font-semibold text-primary">{type === "owner" ? "Chủ thú cưng" : "Bệnh viện Thú y Mỹ Đình"}</p>
            <h1 className="text-2xl font-extrabold text-slate-950">{title}</h1>
          </div>
          <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-500 shadow-sm">
            <Search size={18} />
            <span className="text-sm">Search pet, owner, appointment...</span>
          </div>
        </header>
        <div className="p-5 lg:p-8">{children}</div>
      </main>
    </div>
  );
}