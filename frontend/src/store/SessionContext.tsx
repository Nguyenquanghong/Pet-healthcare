import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiClient, authToken, request } from '../services/apiClient';
import { ApiError } from '../utils/apiError';
import type { Owner } from '../types/owner';

export type AuthRole = 'owner' | 'admin' | null;
// AQ-05: `permissions` comes from Core's shared matrix (session responses only).
export type SessionUser = Omit<Owner, 'petIds'> & { role: string; permissions?: string[] };
type Registration = { fullName?: string; phone?: string; email: string; password: string; confirmPassword: string; address?: string };
type Session = {
  user: SessionUser | null; authRole: AuthRole; userRole: string | null; isAuthReady: boolean;
  status: 'checking' | 'authenticated' | 'anonymous' | 'unavailable'; error: string; sessionKey: number; registrationComplete: boolean;
  retrySession: () => Promise<void>; logout: () => void; isCurrent: (key: number) => boolean;
  loginOwner: (email: string, password: string) => Promise<string | null>;
  loginAdmin: (username: string, password: string) => Promise<string | null>;
  registerOwner: (input: Registration) => Promise<void>;
  updateUser: (user: SessionUser, token: string | null) => void;
  // UI hint only: hides actions the server would refuse. A server without the list
  // (older single backend) shows everything and still enforces every request.
  can: (permission: string) => boolean;
};
const SessionContext = createContext<Session | null>(null);

// Session owns identity only. No bootstrap, business entities or background timer.
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<Session['status']>('checking');
  const [error, setError] = useState('');
  const [registrationComplete, setRegistrationComplete] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const epoch = useRef(0), controller = useRef<AbortController | null>(null);
  const isCurrent = useCallback((key: number) => key === epoch.current, []);
  const advance = useCallback(() => { controller.current?.abort(); const n = ++epoch.current; setSessionKey(n); return n; }, []);
  const logout = useCallback(() => { advance(); authToken.clear(); setUser(null); setStatus('anonymous'); setError(''); setRegistrationComplete(false); }, [advance]);
  const retrySession = useCallback(async () => {
    const n = advance(), token = authToken.get(), active = new AbortController(); controller.current = active;
    setError(''); setRegistrationComplete(false); setUser(null); setStatus('checking');
    if (!token) { setStatus('anonymous'); return; }
    try {
      const result = await apiClient.get<{ user: SessionUser }>('/auth/me', { signal: AbortSignal.any([active.signal, AbortSignal.timeout(15000)]) });
      if (n !== epoch.current || token !== authToken.get() || active.signal.aborted) return;
      setUser(result.user); setStatus('authenticated');
    } catch (reason) {
      if (n !== epoch.current || token !== authToken.get() || active.signal.aborted) return;
      if (reason instanceof ApiError && [401, 404].includes(reason.httpStatus)) { authToken.clear(); setStatus('anonymous'); }
      else { setStatus('unavailable'); setError('Chưa xác minh được phiên đăng nhập. Kết nối lại rồi thử xác minh; phiên của bạn vẫn được giữ.'); }
    }
  }, [advance]);
  useEffect(() => { void retrySession(); return () => { ++epoch.current; controller.current?.abort(); }; }, [retrySession]);
  const authenticate = useCallback(async (endpoint: string, body: object) => {
    const n = advance(), active = new AbortController(); controller.current = active;
    authToken.clear();
    setError(''); setRegistrationComplete(false); setUser(null); setStatus('checking');
    try {
      const result = await request<{ token: string; user: SessionUser }>(endpoint, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.any([active.signal, AbortSignal.timeout(15000)]) });
      if (n !== epoch.current || active.signal.aborted) throw new Error('Phiên đăng nhập đã thay đổi.');
      authToken.set(result.token); setUser(result.user); setStatus('authenticated');
      setRegistrationComplete(endpoint === '/auth/owner/register');
    } catch (reason) {
      if (n === epoch.current) { setError(reason instanceof Error ? reason.message : 'Không đăng nhập được.'); setStatus('anonymous'); }
      throw reason;
    }
  }, [advance]);
  const login = useCallback(async (endpoint: string, body: object) => {
    try { await authenticate(endpoint, body); return null; }
    catch (reason) { return reason instanceof Error ? reason.message : 'Không đăng nhập được.'; }
  }, [authenticate]);
  const updateUser = useCallback((next: SessionUser, token: string | null) => { if (token && token === authToken.get()) setUser(next); }, []);
  const value = useMemo<Session>(() => ({ user, status, error, sessionKey, registrationComplete, authRole: user ? user.role === 'owner' ? 'owner' : 'admin' : null,
    userRole: user?.role ?? null, isAuthReady: status !== 'checking', retrySession, logout, updateUser, isCurrent,
    loginOwner: (email, password) => login('/auth/owner/login', { email, password }),
    loginAdmin: (username, password) => login('/auth/admin/login', { username, password }),
    registerOwner: input => authenticate('/auth/owner/register', input),
    can: permission => !!user && (user.permissions === undefined || user.permissions.includes(permission)),
  }), [user, status, error, sessionKey, registrationComplete, retrySession, logout, updateUser, isCurrent, login, authenticate]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used within SessionProvider');
  return session;
}
