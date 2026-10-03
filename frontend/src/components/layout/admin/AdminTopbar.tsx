import { Bell } from "lucide-react";
import { NavLink } from "react-router-dom";
import { adminNav } from "../../../constants/navigation";
import { useAppStore } from "../../../store/AppStoreProvider";
import { MobileBottomNav } from "../MobileBottomNav";

interface AdminTopbarProps {
  title: string;
}

export function AdminTopbar({ title }: AdminTopbarProps) {
  const { summary } = useAppStore();
  const unreadCount = summary.unread;

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white">
      <div className="flex min-h-14 items-center justify-between gap-3 px-4 sm:min-h-16 sm:px-6 lg:px-8">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-slate-950 sm:text-xl">{title}</h1>
          <p className="hidden text-xs text-slate-500 sm:block">Bệnh viện Thú y Mỹ Đình</p>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden text-right sm:block">
            <p className="text-sm font-medium text-slate-800">Bs. Mai Nguyễn</p>
            <p className="text-xs text-slate-500">Quản trị viên</p>
          </div>
          <NavLink
            id="admin-topbar-bell"
            to="/admin/notifications"
            aria-label="Thông báo quản trị"
            className="relative flex h-11 w-11 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-50 sm:h-9 sm:w-9"
          >
            <Bell size={18} />
            {unreadCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-semibold text-white">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </NavLink>
        </div>
      </div>

      <MobileBottomNav items={adminNav} />
    </header>
  );
}
