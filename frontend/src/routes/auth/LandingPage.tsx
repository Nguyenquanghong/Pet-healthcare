import { Link } from "react-router-dom";
import { ArrowRight, LockKeyhole, ShieldCheck, UserPlus } from "lucide-react";
import { AuthShell } from "./AuthShell";

const portals = [
  {
    to: "/login",
    icon: LockKeyhole,
    title: "Owner sign in",
    description: "Access pet profiles, appointments, stays, and personal notifications.",
  },
  {
    to: "/register",
    icon: UserPlus,
    title: "Owner registration",
    description: "Create a new account in a few minutes and start using Nippon Pet Care services.",
  },
  {
    to: "/admin/login",
    icon: ShieldCheck,
    title: "Admin sign in",
    description: "Private access for doctors and hospital administration staff.",
  },
];

export function LandingPage() {
  return (
    <AuthShell
      title="Pet Care Starts With a Private Portal"
      description="Owners and administration staff have clear, separate flows. Sign in to book appointments, review medical records, follow pet hotel stays, and receive personal notifications."
    >
      <div className="mb-6">
        <p className="text-sm font-semibold text-primary">Choose your portal</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">How would you like to continue?</h2>
        <p className="mt-2 text-sm text-slate-500">Select the account area that matches your role.</p>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        {portals.map((portal) => {
          const Icon = portal.icon;
          return (
            <Link key={portal.to} to={portal.to} className="group flex items-center gap-4 border-b border-slate-200 p-4 last:border-b-0 hover:bg-slate-50">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-slate-100 text-primary">
                  <Icon size={20} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-slate-950">{portal.title}</h3>
                  <p className="mt-0.5 text-sm leading-5 text-slate-500">{portal.description}</p>
                </div>
                <ArrowRight className="text-slate-400 group-hover:text-primary" size={18} />
            </Link>
          );
        })}
      </div>

    </AuthShell>
  );
}
