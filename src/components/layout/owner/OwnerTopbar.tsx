import { Search } from "lucide-react";

interface OwnerTopbarProps {
  title: string;
}

export function OwnerTopbar({ title }: OwnerTopbarProps) {
  return (
    <header className="sticky top-0 z-10 flex flex-col gap-4 border-b border-slate-200 bg-canvas/90 px-5 py-5 backdrop-blur md:flex-row md:items-center md:justify-between lg:px-8">
      <div>
        <p className="text-sm font-semibold text-primary">Chủ thú cưng</p>
        <h1 className="text-2xl font-extrabold text-slate-950">{title}</h1>
      </div>
      <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-slate-500 shadow-sm w-full md:w-auto">
        <Search size={18} />
        <input 
          type="text" 
          placeholder="Tìm thú cưng, dịch vụ..." 
          className="bg-transparent outline-none text-sm w-full md:w-48 lg:w-64"
        />
      </div>
    </header>
  );
}
