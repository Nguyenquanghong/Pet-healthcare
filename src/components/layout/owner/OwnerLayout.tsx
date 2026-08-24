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
      <main className="lg:ml-64 flex flex-col min-h-screen">
        <OwnerTopbar title={title} />
        <div className="p-5 lg:p-8 flex-1 flex flex-col">{children}</div>
      </main>
    </div>
  );
}
