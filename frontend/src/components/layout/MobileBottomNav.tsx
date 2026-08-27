import { useEffect, useState, type ComponentType } from "react";
import { MoreHorizontal, X } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";

type MobileNavItem = {
  to: string;
  label: string;
  mobileLabel?: string;
  icon: ComponentType<{ size?: number; className?: string }>;
};

export function MobileBottomNav({ items }: { items: MobileNavItem[] }) {
  const location = useLocation();
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const primaryItems = items.slice(0, 4);
  const overflowItems = items.slice(4);
  const overflowIsActive = overflowItems.some((item) => location.pathname.startsWith(item.to));

  useEffect(() => setIsMoreOpen(false), [location.pathname]);

  return (
    <>
      {isMoreOpen && (
        <div className="fixed inset-0 z-40 flex items-end bg-slate-950/40 lg:hidden" role="dialog" aria-modal="true" aria-label="More navigation">
          <button className="absolute inset-0" type="button" aria-label="Close navigation" onClick={() => setIsMoreOpen(false)} />
          <div className="relative w-full rounded-t-lg border-t border-slate-200 bg-white px-4 pb-[calc(5rem+env(safe-area-inset-bottom))] pt-4 shadow-lg">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-950">More</p>
              <button type="button" onClick={() => setIsMoreOpen(false)} className="flex h-11 w-11 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100" aria-label="Close navigation">
                <X size={20} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {overflowItems.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) => `flex min-h-12 items-center gap-3 rounded-md border px-3 py-2.5 text-sm font-medium ${isActive ? "border-primary/30 bg-primary/5 text-primary" : "border-slate-200 text-slate-700"}`}
                  >
                    <Icon size={18} />
                    {item.label}
                  </NavLink>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_3px_rgb(15_23_42/0.06)] lg:hidden" aria-label="Mobile navigation">
        {primaryItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to.endsWith("/dashboard")}
              className={({ isActive }) => `flex min-h-16 flex-col items-center justify-center gap-1 px-1 text-[10px] font-semibold ${isActive ? "text-primary" : "text-slate-500"}`}
            >
              <Icon size={20} />
              <span className="max-w-full truncate">{item.mobileLabel ?? item.label}</span>
            </NavLink>
          );
        })}
        <button
          type="button"
          onClick={() => setIsMoreOpen(true)}
          className={`flex min-h-16 flex-col items-center justify-center gap-1 px-1 text-[10px] font-semibold ${overflowIsActive ? "text-primary" : "text-slate-500"}`}
          aria-expanded={isMoreOpen}
          aria-label="More navigation"
        >
          <MoreHorizontal size={20} />
          More
        </button>
      </nav>
    </>
  );
}
