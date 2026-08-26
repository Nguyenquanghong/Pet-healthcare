import { LogOut } from "lucide-react";
import { NavLink, useNavigate } from "react-router-dom";
import { ownerNav } from "../../../constants/navigation";
import { useAppStore } from "../../../store/AppStoreProvider";
import { BrandLogo } from "../../shared/BrandLogo";

export function OwnerSidebar() {
  const navigate = useNavigate();
  const { logout, notifications, currentOwnerId } = useAppStore();
  const unreadCount = notifications.filter(
    (n) => n.recipientOwnerId === currentOwnerId && n.status === "sent"
  ).length;

  const handleLogout = () => {
    logout();
    navigate("/", { replace: true });
  };

  return (
    <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-slate-200 bg-white px-4 py-5 text-slate-700 lg:flex">
      {/* Brand */}
      <div className="mb-7 px-2">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white p-1">
            <BrandLogo className="h-full w-full" />
          </div>
          <div>
            <div className="text-sm font-bold text-slate-950">NIPOPETO</div>
            <div className="mt-0.5 text-[9px] font-medium leading-3.5 text-slate-500">
              <span className="block">Công Nghệ Nhật Bản -</span>
              <span className="block">Tận Tâm Chăm Sóc Thú Cưng</span>
            </div>
          </div>
        </div>

      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5">
        {ownerNav.map((item) => {
          const Icon = item.icon;
          const isNotif = item.to === "/owner/notifications";
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/owner/dashboard"}
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

      {/* Bottom: Logout */}
      <div className="mt-auto border-t border-slate-200 pt-3">
        <button
          type="button"
          id="owner-sidebar-logout"
          onClick={handleLogout}
          aria-label="Đăng xuất tài khoản"
          className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-slate-500 transition-colors hover:bg-rose-50 hover:text-rose-700"
        >
          <LogOut size={16} /> Đăng xuất
        </button>
      </div>
    </aside>
  );
}
