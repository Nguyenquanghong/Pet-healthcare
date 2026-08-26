import type { ReactNode } from "react";
import { HeartPulse, PawPrint, Sparkles } from "lucide-react";
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
    <main className={`relative min-h-screen overflow-hidden px-5 py-8 text-ink lg:px-8 ${isAdmin ? "bg-slate-950" : "bg-[#eef7fb]"}`}>
      <div className="absolute -left-24 top-12 h-72 w-72 rounded-full bg-aqua/40 blur-3xl" />
      <div className={`absolute -right-24 top-32 h-96 w-96 rounded-full blur-3xl ${isAdmin ? "bg-primary/40" : "bg-primary/20"}`} />
      <div className="absolute bottom-0 left-1/3 h-64 w-64 rounded-full bg-white/60 blur-3xl" />

      <div className="relative mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-6xl items-center">
        <div className="grid w-full overflow-hidden rounded-[2rem] border border-white/70 bg-white/80 shadow-[0_30px_80px_rgba(15,23,42,0.14)] backdrop-blur-xl lg:grid-cols-[1.05fr_0.95fr]">
          <section className={`relative overflow-hidden p-8 text-white sm:p-10 lg:p-12 ${isAdmin ? "bg-slate-950" : "bg-primary"}`}>
            <div className="absolute inset-0 opacity-30 [background-image:radial-gradient(circle_at_20%_20%,white_0,transparent_28%),radial-gradient(circle_at_80%_10%,#7de3df_0,transparent_24%),radial-gradient(circle_at_50%_90%,white_0,transparent_20%)]" />
            <div className="absolute -bottom-24 -right-16 h-72 w-72 rounded-full border-[42px] border-white/10" />
            <div className="relative z-10 flex min-h-full flex-col justify-between gap-12">
              <div>
                <div className="inline-flex items-center gap-3 rounded-2xl bg-white px-4 py-2 text-sm font-extrabold text-slate-950 shadow-sm ring-1 ring-white/30">
                  <BrandLogo variant="lockup" className="h-16 w-32" />
                  <span className="sr-only">{eyebrow}</span>
                </div>
                <h1 className="mt-8 max-w-xl text-4xl font-black leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
                  {title}
                </h1>
                <p className="mt-5 max-w-2xl text-base leading-7 text-white/82 sm:text-lg">
                  {description}
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl bg-white/12 p-4 ring-1 ring-white/15">
                  <HeartPulse className="mb-3" size={22} />
                  <p className="text-sm font-bold">Complete care</p>
                </div>
                <div className="rounded-2xl bg-white/12 p-4 ring-1 ring-white/15">
                  <Sparkles className="mb-3" size={22} />
                  <p className="text-sm font-bold">Modern experience</p>
                </div>
                <div className="rounded-2xl bg-white/12 p-4 ring-1 ring-white/15">
                  <PawPrint className="mb-3" size={22} />
                  <p className="text-sm font-bold">Private data</p>
                </div>
              </div>
            </div>
          </section>

          <section className="flex items-center justify-center p-6 sm:p-8 lg:p-10">
            <div className="w-full max-w-md">{children}</div>
          </section>
        </div>
      </div>
    </main>
  );
}
