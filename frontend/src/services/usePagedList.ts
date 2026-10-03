import { useCallback, useEffect, useState } from "react";
import { useSession } from "../store/SessionContext";
import { emptyRelated, type ListPage } from "../types/list";
import { useApiQuery } from "./useApiQuery";

export type { PaginationInfo, RelatedData, ListPage } from "../types/list";
export { emptyRelated } from "../types/list";

export function usePagedList<T>(endpoint: string, filters: Record<string, string | undefined> = {}, enabled = true) {
  const { authRole } = useSession();
  const params = new URLSearchParams(Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1]) && (entry[1] !== "all" || entry[0] === "q" || entry[0] === "id")).sort(([a], [b]) => a.localeCompare(b)));
  const key = endpoint + "?" + params.toString();
  const [position, setPosition] = useState({ key, page: 1, pageSize: 20 });
  const page = position.key === key ? position.page : 1;
  const pageSize = position.pageSize;
  params.set("page", String(page)); params.set("pageSize", String(pageSize));
  const query = useApiQuery<ListPage<T>>(endpoint + "?" + params.toString(), {
    enabled: enabled && Boolean(authRole), debounceMs: filters.q ? 250 : 0, refreshOnTick: true,
  });
  const data: ListPage<T> = query.data ?? { items: [], pagination: { page, pageSize, total: 0, totalPages: 0 }, counts: {}, related: emptyRelated };
  useEffect(() => {
    if (query.data && page > Math.max(1, query.data.pagination.totalPages)) {
      setPosition({ key, page: Math.max(1, query.data.pagination.totalPages), pageSize });
    }
  }, [query.data, page, pageSize, key]);
  const reload = useCallback(() => query.reload().then(() => undefined), [query.reload]);
  const setItems = (change: T[] | ((previous: T[]) => T[])) => query.setData(previous => {
    const current = previous ?? data;
    return { ...current, items: (typeof change === "function" ? change(current.items) : change).slice(0, pageSize) };
  });
  return { ...data, loading: query.loading, error: query.error, reload, setItems, page, pageSize,
    setPage: (next: number) => setPosition({ key, page: next, pageSize }),
    setPageSize: (size: number) => setPosition({ key, page: 1, pageSize: size }) };
}
