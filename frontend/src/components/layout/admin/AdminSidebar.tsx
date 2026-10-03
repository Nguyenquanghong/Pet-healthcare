import { LogOut } from "lucide-react";
import { NavLink, useNavigate } from "react-router-dom";
import { adminNav } from "../../../constants/navigation";
import { useAppStore } from "../../../store/AppStoreProvider";
import { BrandLogo } from "../../shared/BrandLogo";

export function AdminSidebar() {
  const navigate = useNavigate();
  const { logout, summary } = useAppStore();
  const unreadCount = summary.unread;

  const handleLogout = () => {
    logout();
    navigate("/", { replace: true });
  };

  return (
    <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-slate-200 bg-white px-4 py-5 text-slate-700 lg:flex">
      <div className="mb-7 px-2">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white p-1">
            <BrandLogo className="h-full w-full" />
          </div>
          <div>
            <div className="text-sm font-bold text-slate-950">NIPOPETO</div>
            <div className="text-xs text-slate-500">Hospital Admin</div>
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto">
        {adminNav.map((item) => {
          const Icon = item.icon;
          const isNotif = item.to === "/admin/notifications";
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center justify-between gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-slate-100 text-primary"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-950"
                }`
              }
            >
              <span className="flex items-center gap-3">
                <Icon size={18} />
                {item.label}
              </span>
              {isNotif && unreadCount > 0 && (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-xs font-bold text-white">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Bottom: Staff profile + Logout */}
      <div className="mt-3 border-t border-slate-200 pt-3">
        <div className="flex items-center gap-3 px-3 py-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-semibold text-primary">
            BS
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-900">Bs. Mai Nguyễn</p>
            <p className="text-xs text-slate-500">Bác sĩ thú y</p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="mt-1 flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-slate-500 transition-colors hover:bg-rose-50 hover:text-rose-700"
        >
          <LogOut size={16} /> Đăng xuất
        </button>
      </div>
    </aside>
  );
}
