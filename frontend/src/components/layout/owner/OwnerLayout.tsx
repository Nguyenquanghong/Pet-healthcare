import type { ReactNode } from "react";
import { OwnerSidebar } from "./OwnerSidebar";
import { OwnerTopbar } from "./OwnerTopbar";
import { useAppStore } from "../../../store/AppStoreProvider";

interface OwnerLayoutProps {
  title: string;
  children: ReactNode;
}

export function OwnerLayout({ title, children }: OwnerLayoutProps) {
  const { error, isLoading } = useAppStore();
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <OwnerSidebar />
      <main className="flex min-h-screen flex-col lg:ml-60">
        <OwnerTopbar title={title} />
        {isLoading && <div className="h-0.5 w-full animate-pulse bg-primary" aria-label="Loading" />}
        <div className="mx-auto flex w-full max-w-[1480px] flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8">
          {error && <div className="mb-5 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">{error}</div>}
          {children}
        </div>
      </main>
    </div>
  );
}
