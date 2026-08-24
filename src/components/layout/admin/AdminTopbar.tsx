import { Bell, Search } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useAppStore } from "../../../store/AppStoreProvider";

interface AdminTopbarProps {
  title: string;
}

export function AdminTopbar({ title }: AdminTopbarProps) {
  const { notifications } = useAppStore();
  const unreadCount = notifications.filter(n => n.status === "sent").length;

  return (
    <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-slate-200 bg-white/90 px-5 py-4 backdrop-blur lg:px-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">
          Bệnh viện Thú y Mỹ Đình
        </p>
        <h1 className="text-2xl font-extrabold text-slate-950">{title}</h1>
      </div>

      <div className="flex items-center gap-3">
        <div className="hidden items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-slate-500 md:flex">
          <Search size={16} />
          <input
            type="text"
            placeholder="Tìm kiếm..."
            className="bg-transparent outline-none text-sm w-40 lg:w-56"
          />
        </div>

        <NavLink
          to="/admin/notifications"
          className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 transition-colors"
        >
          <Bell size={18} />
          {unreadCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold text-white">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </NavLink>
      </div>
    </header>
  );
}
