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
      <main className="flex min-h-screen flex-col lg:ml-60">
        <AdminTopbar title={title} />
        <div className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</div>
      </main>
    </div>
  );
}
