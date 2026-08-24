import { Bell, Search } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useAppStore } from "../../../store/AppStoreProvider";

interface OwnerTopbarProps {
  title: string;
}

export function OwnerTopbar({ title }: OwnerTopbarProps) {
  const { notifications, currentOwnerId } = useAppStore();
  const unreadCount = notifications.filter(
    (n) => n.recipientOwnerId === currentOwnerId && n.status === "sent"
  ).length;

  return (
    <header className="sticky top-0 z-10 flex flex-col gap-4 border-b border-slate-200 bg-canvas/90 px-5 py-5 backdrop-blur md:flex-row md:items-center md:justify-between lg:px-8">
      <div>
        <p className="text-sm font-semibold text-primary">Chủ thú cưng</p>
        <h1 className="text-2xl font-extrabold text-slate-950">{title}</h1>
      </div>

      <div className="flex items-center gap-3 w-full md:w-auto">
        <div className="flex flex-1 items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-500 shadow-xs md:w-auto">
          <Search size={18} />
          <input
            id="owner-topbar-search"
            type="text"
            placeholder="Tìm thú cưng, dịch vụ..."
            aria-label="Tìm thú cưng hoặc dịch vụ"
            className="bg-transparent outline-none text-sm w-full md:w-48 lg:w-64"
          />
        </div>

        <NavLink
          id="owner-topbar-bell"
          to="/owner/notifications"
          aria-label="Thông báo"
          className="relative flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-colors shadow-xs"
        >
          <Bell size={20} />
          {unreadCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[11px] font-bold text-white shadow-xs">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </NavLink>
      </div>
    </header>
  );
}
