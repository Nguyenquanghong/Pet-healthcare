import { createContext, useContext, type ReactNode } from 'react';
import { useSession } from './SessionContext';
import { useApiQuery } from '../services/useApiQuery';
type Count = { unread: number; asOf: string };
type Value = ReturnType<typeof useApiQuery<Count>>;
const Context = createContext<Value | null>(null);
export function NotificationCountProvider({ children }: { children: ReactNode }) {
  const { authRole } = useSession();
  const count = useApiQuery<Count>('/notifications/unread-count', { enabled: Boolean(authRole), refreshOnTick: true, pollMs: 20000 });
  return <Context.Provider value={count}>{children}</Context.Provider>;
}
export function useNotificationCount() { const count = useContext(Context); if (!count) throw new Error('Missing NotificationCountProvider'); return count; }
