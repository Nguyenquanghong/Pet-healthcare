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
    <main className="min-h-screen bg-slate-100 text-ink sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl items-stretch sm:min-h-[calc(100vh-3rem)] sm:items-center">
        <div className="grid w-full overflow-hidden border-slate-200 bg-white sm:rounded-lg sm:border lg:grid-cols-[0.9fr_1.1fr]">
          <section className={`flex flex-col justify-between p-5 text-white sm:p-7 lg:p-12 ${isAdmin ? "bg-slate-900" : "bg-primary"}`}>
            <div>
              <div className="inline-flex bg-white p-2">
                <BrandLogo variant="lockup" className="h-10 w-24 lg:h-12 lg:w-28" />
              </div>
              <p className="mt-8 hidden text-xs font-semibold uppercase text-white/70 lg:block">{eyebrow}</p>
              <h1 className="mt-3 hidden max-w-lg text-4xl font-semibold leading-tight lg:block">
                {title}
              </h1>
              <p className="mt-4 hidden max-w-xl text-base leading-6 text-white/75 lg:block">
                {description}
              </p>
            </div>
            <p className="mt-10 hidden border-t border-white/15 pt-5 text-xs leading-5 text-white/60 lg:block">
              Công Nghệ Nhật Bản - Tận Tâm Chăm Sóc Thú Cưng
            </p>
          </section>

          <section className="flex items-center justify-center p-5 sm:p-10 lg:p-12">
            <div className="w-full max-w-lg">{children}</div>
          </section>
        </div>
      </div>
    </main>
  );
}
