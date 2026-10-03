import type { PaginationInfo } from "../../types/list";

export function Pagination({ pagination, page, pageSize, setPage, setPageSize, loading, error, reload }: {
  pagination: PaginationInfo; page: number; pageSize: number; setPage: (page: number) => void; setPageSize: (size: number) => void;
  loading: boolean; error: string; reload: () => Promise<void>;
}) {
  const totalPages = Math.max(1, pagination.totalPages);
  return <nav aria-label="Phân trang" className="my-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm">
    <div aria-live="polite">{loading ? "Đang tải danh sách..." : error ? <span role="alert" className="text-rose-700">{error} <button type="button" className="underline" onClick={() => void reload().catch(() => undefined)}>Thử lại</button></span> :
      <span>{pagination.total ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, pagination.total)} / {pagination.total} kết quả</span>}</div>
    <div className="flex items-center gap-3">
      <label>Số dòng <select aria-label="Số dòng mỗi trang" className="rounded border p-1" value={pageSize} onChange={event => setPageSize(Number(event.target.value))}>{[10, 20, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
      <button type="button" aria-label="Trang trước" className="rounded border px-3 py-1 disabled:opacity-40" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>Trước</button>
      <span>Trang {page}/{totalPages}</span>
      <button type="button" aria-label="Trang sau" className="rounded border px-3 py-1 disabled:opacity-40" disabled={loading || page >= totalPages || Boolean(error)} onClick={() => setPage(page + 1)}>Sau</button>
    </div>
  </nav>;
}
