import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient, authToken } from "./apiClient";
import { useSession } from "../store/SessionContext";
import { useDataRefresh, queryScopes } from "../store/DataRefreshContext";

export type QueryOptions = { enabled?: boolean; debounceMs?: number; refreshOnTick?: boolean; pollMs?: number };
type QueryState<T> = { key: string; data: T | undefined; loading: boolean; error: string; asOf?: string };

// One request lifecycle for lists and detail/aggregate queries; callers own their data.
export function useApiQuery<T>(url: string, { enabled = true, debounceMs = 0, refreshOnTick = false, pollMs }: QueryOptions = {}) {
  const { authRole, sessionKey } = useSession();
  const refresh = useDataRefresh();
  const token = authToken.get();
  const key = JSON.stringify([url, sessionKey, authRole, enabled]);
  const [state, setState] = useState<QueryState<T>>({ key, data: undefined, loading: enabled, error: "" });
  const currentKey = useRef(key); currentKey.current = key;
  const mounted = useRef(false);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const timer = useRef<number | null>(null);
  const flight = useRef<{ key: string; sequence: number; promise: Promise<T | undefined> } | null>(null);

  const load = useCallback((force: boolean): Promise<T | undefined> => {
    if (!enabled || !mounted.current || key !== currentKey.current || token !== authToken.get()) return Promise.resolve(undefined);
    if (!force && flight.current?.key === key) return flight.current.promise;
    controller.current?.abort();
    const active = new AbortController(); controller.current = active;
    const request = ++sequence.current;
    const isCurrent = () => mounted.current && request === sequence.current && key === currentKey.current && token === authToken.get();
    setState(previous => ({ key, data: previous.key === key ? previous.data : undefined, asOf: previous.key === key ? previous.asOf : undefined, loading: true, error: "" }));
    const promise = (async () => {
      try {
        const result = await apiClient.get<T>(url, { signal: AbortSignal.any([active.signal, AbortSignal.timeout(15_000)]) });
        if (!isCurrent() || active.signal.aborted) return undefined;
        setState({ key, data: result, loading: false, error: "", asOf: new Date().toISOString() });
        return result;
      } catch (reason) {
        if (isCurrent() && !active.signal.aborted) {
          setState(previous => ({ ...previous, error: reason instanceof Error ? reason.message : "Không tải được dữ liệu." }));
          throw reason;
        }
      } finally {
        if (isCurrent()) setState(previous => ({ ...previous, loading: false }));
        if (flight.current?.sequence === request) flight.current = null;
      }
    })();
    flight.current = { key, sequence: request, promise };
    return promise;
  }, [url, enabled, key, token]);

  const reload = useCallback(() => {
    if (!mounted.current || key !== currentKey.current || token !== authToken.get()) return Promise.resolve(undefined);
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    return load(true);
  }, [load, key, token]);

  useEffect(() => {
    mounted.current = true;
    setState({ key, data: undefined, loading: enabled, error: "" });
    if (enabled) timer.current = window.setTimeout(() => {
      timer.current = null;
      void load(false).catch(() => undefined);
    }, debounceMs);
    return () => {
      mounted.current = false;
      if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
      sequence.current += 1; controller.current?.abort(); flight.current = null;
    };
  }, [load, debounceMs]);

  useEffect(() => {
    if (enabled && refreshOnTick) return refresh.register(queryScopes(url), reload);
  }, [refresh, refreshOnTick, enabled, url, reload]);

  useEffect(() => {
    if (!enabled || !pollMs) return;
    let stopped = false, running = false, next: number | undefined, failures = 0;
    const schedule = () => { window.clearTimeout(next); if (!stopped) next = window.setTimeout(tick, Math.min(120000, pollMs * 2 ** failures) * (0.85 + Math.random() * 0.3)); };
    const tick = async () => {
      if (stopped || running) return;
      running = true;
      if (document.visibilityState === 'visible' && navigator.onLine) {
        try { await load(false); failures = 0; } catch { failures = Math.min(3, failures + 1); }
      }
      running = false; schedule();
    };
    const resume = () => { if (document.visibilityState === 'visible' && navigator.onLine) { window.clearTimeout(next); void tick(); } };
    schedule(); window.addEventListener('online', resume); document.addEventListener('visibilitychange', resume);
    return () => { stopped = true; window.clearTimeout(next); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume); };
  }, [enabled, pollMs, key, load]);

  const setData = useCallback((change: T | ((previous: T | undefined) => T | undefined)) => {
    if (!mounted.current || key !== currentKey.current || token !== authToken.get()) return;
    setState(previous => {
      const data = previous.key === key ? previous.data : undefined;
      const next = typeof change === "function" ? (change as (value: T | undefined) => T | undefined)(data) : change;
      return { key, data: next, loading: previous.key === key && previous.loading, error: "" };
    });
  }, [key, token]);

  const current = state.key === key ? state : { data: undefined, loading: enabled, error: "", asOf: undefined };
  return { data: current.data, loading: current.loading, error: current.error, asOf: current.asOf, reload, setData };
}
