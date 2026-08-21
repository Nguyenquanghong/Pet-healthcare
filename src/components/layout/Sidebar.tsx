import { NavLink } from "react-router-dom";
import { adminNav, ownerNav } from "../../constants/navigation";

export function Sidebar({ type }: { type: "owner" | "admin" }) {
  const nav = type === "owner" ? ownerNav : adminNav;
  return (
    <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col bg-primary p-5 text-white lg:flex">
      <div className="mb-8">
        <div className="text-xl font-extrabold tracking-wide">NIPPON PET CARE</div>
        <div className="text-xs text-cyan-100">Công Nghệ Nhật Bản</div>
        <div className="mt-3 rounded-full bg-white/10 px-3 py-1 text-xs">{type === "owner" ? "Owner Portal" : "Hospital Admin"}</div>
      </div>
      <nav className="space-y-2">
        {nav.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink key={item.to} to={item.to} end={item.to === "/"} className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold transition ${isActive ? "bg-aqua text-primary" : "text-white/80 hover:bg-white/10 hover:text-white"}`}>
              <Icon size={18} />
              {item.label}
            </NavLink>
          );
        })}
      </nav>
      <NavLink to={type === "owner" ? "/admin/dashboard" : "/"} className="mt-auto rounded-xl bg-white/10 px-4 py-3 text-center text-sm font-semibold hover:bg-white/20">
        {type === "owner" ? "Sang Admin" : "Sang Owner"}
      </NavLink>
    </aside>
  );
}