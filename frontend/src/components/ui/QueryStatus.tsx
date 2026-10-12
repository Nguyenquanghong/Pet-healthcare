export function QueryStatus({ label, query }: { label: string; query: { loading: boolean; error: string; asOf?: string; data?: unknown; reload: () => Promise<unknown> } }) {
  if (query.error) return <p role="alert" className="my-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Chưa cập nhật được {label}. {query.data !== undefined && query.asOf && <>Đang hiển thị dữ liệu lúc {new Date(query.asOf).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}. </>}<button className="underline" onClick={() => void query.reload().catch(() => undefined)}>Thử lại {label}</button></p>;
  if (query.loading && query.data === undefined) return <p role="status" className="my-3 text-sm text-slate-500">Đang tải {label}...</p>;
  return null;
}
