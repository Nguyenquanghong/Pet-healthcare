import type { ReactNode } from "react";
import { AdminSidebar } from "./AdminSidebar";
import { AdminTopbar } from "./AdminTopbar";

interface AdminLayoutProps {
  title: string;
  children: ReactNode;
}

export function AdminLayout({ title, children }: AdminLayoutProps) {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <AdminSidebar />
      <main className="lg:ml-64 flex flex-col min-h-screen">
        <AdminTopbar title={title} />
        <div className="p-5 lg:p-8 flex-1">{children}</div>
      </main>
    </div>
  );
}
