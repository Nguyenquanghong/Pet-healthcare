import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
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
const channelName = 'nipopeto-data-refresh-v1';
const dataScopes: DataScope[] = ['pets', 'owners', 'hotel', 'invoices', 'clinic', 'notifications', 'profile'];

// Only mounted queries participate. Messages carry scopes, never account data.
export function DataRefreshProvider({ children }: { children: ReactNode }) {
  const queries = useRef(new Map<() => Promise<unknown>, DataScope[]>());
  const channel = useRef<BroadcastChannel | null>(null);
  const register = useCallback((scopes: DataScope[], reload: () => Promise<unknown>) => { queries.current.set(reload, scopes); return () => { queries.current.delete(reload); }; }, []);
  const reloadLocal = useCallback(async (scopes?: DataScope[]) => {
    const jobs = [...queries.current].filter(([, own]) => !scopes || own.some(scope => scopes.includes(scope))).map(([reload]) => reload());
    const results = await Promise.allSettled(jobs), failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }, []);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const active = new BroadcastChannel(channelName);
    channel.current = active;
    active.onmessage = event => {
      if (!event.data || typeof event.data !== 'object' || !Object.prototype.hasOwnProperty.call(event.data, 'scopes')) return;
      const scopes = event.data?.scopes;
      if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.every(scope => dataScopes.includes(scope)))) return;
      void reloadLocal(scopes).catch(() => undefined);
    };
    return () => { channel.current = null; active.close(); };
  }, [reloadLocal]);
  const invalidate = useCallback((scopes?: DataScope[]) => {
    channel.current?.postMessage({ scopes });
    return reloadLocal(scopes);
  }, [reloadLocal]);
  const value = useMemo(() => ({ register, invalidate }), [register, invalidate]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useDataRefresh() { const value = useContext(Context); if (!value) throw new Error('Missing DataRefreshProvider'); return value; }
