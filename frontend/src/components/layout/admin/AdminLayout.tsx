import type { ReactNode } from "react";
import { AdminSidebar } from "./AdminSidebar";
import { AdminTopbar } from "./AdminTopbar";
import { useAppStore } from "../../../store/AppStoreProvider";

interface AdminLayoutProps {
  title: string;
  children: ReactNode;
}

export function AdminLayout({ title, children }: AdminLayoutProps) {
  const { error, syncError, isLoading } = useAppStore();
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <AdminSidebar />
      <main className="flex min-h-screen flex-col lg:ml-60">
        <AdminTopbar title={title} />
        {isLoading && <div className="h-0.5 w-full animate-pulse bg-primary" aria-label="Loading" />}
        <div className="mx-auto w-full max-w-[1600px] flex-1 px-4 pb-24 pt-5 sm:px-6 sm:pt-6 lg:px-8 lg:pb-6">
          {error && <div className="mb-5 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">{error}</div>}
          {syncError && <p role="status" className="mb-4 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800">{syncError}</p>}
          {children}
        </div>
      </main>
    </div>
  );
}
