import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
export type DataScope = 'pets' | 'owners' | 'hotel' | 'invoices' | 'clinic' | 'notifications' | 'profile';
export function queryScopes(url: string): DataScope[] {
  if (/^\/(appointments|medical-records|dashboard\/clinic)([/?]|$)/.test(url)) return ['clinic'];
  if (url.startsWith('/notifications')) return ['notifications'];
  if (url.startsWith('/pets')) return ['pets'];
  if (url.startsWith('/owners')) return ['owners'];
  if (url.startsWith('/hotel-')) return ['hotel'];
  if (url.startsWith('/invoices') || url.startsWith('/payments')) return ['invoices'];
  if (url.startsWith('/dashboard/core')) return ['pets', 'owners', 'hotel'];
  return ['profile'];
}
type Refresh = { register: (scopes: DataScope[], reload: () => Promise<unknown>) => () => void; invalidate: (scopes?: DataScope[]) => Promise<void> };
const Context = createContext<Refresh | null>(null);
// Only mounted queries participate. No global polling or background entity cache.
export function DataRefreshProvider({ children }: { children: ReactNode }) {
  const queries = useRef(new Map<() => Promise<unknown>, DataScope[]>());
  const register = useCallback((scopes: DataScope[], reload: () => Promise<unknown>) => { queries.current.set(reload, scopes); return () => { queries.current.delete(reload); }; }, []);
  const invalidate = useCallback(async (scopes?: DataScope[]) => {
    const jobs = [...queries.current].filter(([, own]) => !scopes || own.some(scope => scopes.includes(scope))).map(([reload]) => reload());
    const results = await Promise.allSettled(jobs), failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }, []);
  const value = useMemo(() => ({ register, invalidate }), [register, invalidate]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useDataRefresh() { const value = useContext(Context); if (!value) throw new Error('Missing DataRefreshProvider'); return value; }
