import { createContext, useContext, useMemo, type ReactNode } from "react";

export type AuthRole = "owner" | "admin" | null;
type Session = { authRole: AuthRole; userRole: string | null; isAuthReady: boolean };
const SessionContext = createContext<Session | null>(null);

// Read-only session state; authentication actions stay in AppStoreProvider.
export function SessionProvider({ authRole, userRole, isAuthReady, children }: Session & { children: ReactNode }) {
  const value = useMemo(() => ({ authRole, userRole, isAuthReady }), [authRole, userRole, isAuthReady]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used within SessionProvider");
  return session;
}
