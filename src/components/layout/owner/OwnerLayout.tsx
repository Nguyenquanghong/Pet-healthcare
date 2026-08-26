import type { ReactNode } from "react";
import { OwnerSidebar } from "./OwnerSidebar";
import { OwnerTopbar } from "./OwnerTopbar";

interface OwnerLayoutProps {
  title: string;
  children: ReactNode;
}

export function OwnerLayout({ title, children }: OwnerLayoutProps) {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <OwnerSidebar />
      <main className="flex min-h-screen flex-col lg:ml-60">
        <OwnerTopbar title={title} />
        <div className="mx-auto flex w-full max-w-[1480px] flex-1 flex-col px-4 py-6 sm:px-6 lg:px-8">{children}</div>
      </main>
    </div>
  );
}
