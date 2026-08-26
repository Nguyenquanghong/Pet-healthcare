import type { ReactNode } from "react";
import { BrandLogo } from "../../components/shared/BrandLogo";

type AuthShellProps = {
  eyebrow?: string;
  title: string;
  description: string;
  children: ReactNode;
  tone?: "owner" | "admin";
};

export function AuthShell({ eyebrow = "Nippon Pet Care", title, description, children, tone = "owner" }: AuthShellProps) {
  const isAdmin = tone === "admin";

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-6 text-ink sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-6xl items-center">
        <div className="grid w-full overflow-hidden rounded-xl border border-slate-200 bg-white lg:grid-cols-[0.9fr_1.1fr]">
          <section className={`flex flex-col justify-between p-7 text-white sm:p-9 lg:p-12 ${isAdmin ? "bg-slate-900" : "bg-primary"}`}>
            <div>
              <div className="inline-flex bg-white p-2">
                <BrandLogo variant="lockup" className="h-12 w-28" />
              </div>
              <p className="mt-8 text-xs font-semibold uppercase tracking-wider text-white/70">{eyebrow}</p>
              <h1 className="mt-3 max-w-lg text-3xl font-semibold leading-tight sm:text-4xl">
                {title}
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-6 text-white/75 sm:text-base">
                {description}
              </p>
            </div>
            <p className="mt-10 border-t border-white/15 pt-5 text-xs leading-5 text-white/60">
              Công Nghệ Nhật Bản - Tận Tâm Chăm Sóc Thú Cưng
            </p>
          </section>

          <section className="flex items-center justify-center p-6 sm:p-10 lg:p-12">
            <div className="w-full max-w-lg">{children}</div>
          </section>
        </div>
      </div>
    </main>
  );
}
