import { usePagedList } from "../../services/usePagedList";
import { Pagination } from "../../components/ui/Pagination";
import { useState } from "react";
import { AdminLayout } from "../../components/layout/admin/AdminLayout";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { useAppStore } from "../../store/AppStoreProvider";
import type { Owner } from "../../types/owner";
import { OwnerActivationDialog } from "./OwnerActivationDialog";

export function AdminOwnersPage() {
  const { userRole } = useAppStore();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Owner | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canIssue = userRole === "admin" || userRole === "staff";
  const list = usePagedList<Owner>("/owners", { q: query });
  const filtered = list.items;
  return <AdminLayout title="Khách hàng">
    <Pagination {...list} />
    <p className="mb-4 text-sm text-slate-600">Hồ sơ tại quầy giữ nguyên thú cưng, lịch đặt và hóa đơn khi kích hoạt đăng nhập. Xác minh khách trước khi cấp liên kết.</p>
    <div className="mb-5 flex flex-wrap items-end gap-3">
      <Input label="Tìm khách hàng" placeholder="Tên, số điện thoại, email hoặc mã chủ nuôi" value={query} onChange={event => setQuery(event.target.value)} className="w-full max-w-md" />
      <Button type="button" variant="outline" disabled={busy} onClick={async () => {
        setBusy(true); setError(""); try { await list.reload(); } catch { setError("Chưa tải lại được danh sách khách hàng."); } finally { setBusy(false); }
      }}>{busy ? "Đang tải..." : "Tải lại danh sách"}</Button>
    </div>
    {error && <p role="alert" className="mb-4 text-sm text-rose-700">{error}</p>}
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full min-w-[700px] text-left text-sm">
        <thead className="bg-slate-50 text-slate-600"><tr>
          <th className="p-4">Khách hàng</th><th className="p-4">Liên hệ</th><th className="p-4">Thú cưng</th><th className="p-4">Đăng nhập</th><th className="p-4">Thao tác</th>
        </tr></thead>
        <tbody className="divide-y divide-slate-100">{filtered.map(owner => <tr key={owner.id}>
          <td className="p-4"><p className="font-semibold">{owner.fullName}</p><p className="mt-1 break-all text-xs text-slate-500">{owner.id}</p></td>
          <td className="p-4"><p>{owner.phone || "Chưa có số điện thoại"}</p><p className="break-all text-slate-500">{owner.email || "Chưa có email"}</p></td>
          <td className="p-4">{owner.petCount ?? 0}</td>
          <td className="p-4">{owner.loginEnabled === true ? "Đã kích hoạt" : owner.loginEnabled === false ? "Chưa kích hoạt" : "Chưa rõ"}</td>
          <td className="p-4">{canIssue && owner.loginEnabled === false && <Button type="button" size="sm" onClick={() => setSelected(owner)}>Kích hoạt tài khoản</Button>}</td>
        </tr>)}{!filtered.length && <tr><td colSpan={5} className="p-8 text-center text-slate-500">Không có khách phù hợp.</td></tr>}</tbody>
      </table>
    </div>
    {selected && <OwnerActivationDialog owner={selected} onClose={() => setSelected(null)} />}
  </AdminLayout>;
}
