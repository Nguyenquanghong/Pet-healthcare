import type { LimitRule } from '@nipopeto/runtime';
// What Core tells the shared runtime about its own HTTP surface: the rate-limit rules for sign-in and the public
// rescue form, the size limit for sign-in bodies, and the metric label of every route Core serves or proxies.

// Sign-in bodies are parsed before the limiter (the login rule reads the account), so they get a small limit.
export const coreBodyLimits = [{ path: '/api/auth', limit: '16kb' }] as const;

const login: LimitRule = ({ req, ip, bucket, limit }) => {
  if (req.method !== 'POST' || !/^\/auth\/(owner|admin)\/login$/.test(req.path)) return undefined;
  const raw = req.body?.email ?? req.body?.username;
  const account = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 254) : 'invalid';
  return {
    group: 'auth-login',
    read: false,
    buckets: [
      bucket(ip, limit('AUTH_LOGIN_IP_LIMIT', 1000)),
      bucket('account:' + req.path + ':' + account, limit('AUTH_LOGIN_ACCOUNT_LIMIT', 30)),
    ],
  };
};
const register: LimitRule = ({ req, ip, bucket, limit }) =>
  req.method === 'POST' && req.path === '/auth/owner/register'
    ? { group: 'auth-register', read: false, buckets: [bucket(ip, limit('AUTH_REGISTER_IP_LIMIT', 300))] }
    : undefined;
const activation: LimitRule = ({ req, ip, bucket, limit }) =>
  req.method === 'POST' && req.path.startsWith('/auth/owner/activation')
    ? { group: 'auth-activation', read: false, buckets: [bucket(ip, limit('AUTH_ACTIVATION_IP_LIMIT', 300))] }
    : undefined;
// AQ-01: unauthenticated rescue reports notify an owner. The token buckets cap
// a flood against one pet across IPs (5 per 15 minutes, 20 per day); the token
// is HMACed with the other keys.
const rescue: LimitRule = ({ req, ip, bucket, limit }) => {
  const match = req.method === 'POST' ? req.path.match(/^\/public\/pets\/([^/]{1,200})\/rescue-reports$/) : null;
  if (!match) return undefined;
  let token = match[1]!;
  try {
    token = decodeURIComponent(token);
  } catch {}
  return {
    group: 'public-rescue',
    read: false,
    buckets: [
      bucket(ip, limit('RESCUE_REPORT_IP_LIMIT', 20)),
      bucket('rescue-token:' + token, limit('RESCUE_REPORT_TOKEN_LIMIT', 5)),
      bucket('rescue-token-day:' + token, limit('RESCUE_REPORT_TOKEN_DAILY_LIMIT', 20), 86400000),
    ],
  };
};
const password: LimitRule = ({ req, ip, bucket, limit, identity }) =>
  req.method === 'POST' && req.path === '/auth/me/password'
    ? {
        group: 'auth-password',
        read: false,
        buckets: [bucket(identity(), limit('AUTH_PASSWORD_ACTOR_LIMIT', 10)), bucket(ip, 200)],
      }
    : undefined;
// Sign-in, activation and public pages (rescue tokens) stay on the shared limiter even for GET.
const sharedReads: LimitRule = ({ req, general }) =>
  /^\/+(auth|public)(\/|$)/i.test(req.path) ? general({ shared: true }) : undefined;
// Order matters: the first rule that answers decides, and sharedReads covers every other path under /auth and /public.
export const coreLimitRules: readonly LimitRule[] = [login, register, activation, rescue, password, sharedReads];

// The metric label of a path, or undefined for 'unknown'. Core also labels the routes it only proxies to Clinic and
// Notification, so this is the whole public API. Labels never come from req.route: a proxied route and a request
// refused before the router have none.
export function coreRouteLabel(p: string): string | undefined {
  const fixed =
    /^\/api\/(auth\/(owner\/(login|register|activation(\/inspect)?)|admin\/login|me(\/password)?)|dashboard\/(core|clinic)|appointments\/(calendar|availability)|medical-records\/images|notifications\/(unread-count|send|read-all)|invoices\/checkout|bootstrap|analytics\/summary|openapi.json|docs|pets|owners|doctors|appointments|medical-records|hotel-bookings|notifications|invoices|operations|payments)$/;
  if (fixed.test(p)) return p;
  const item = p.match(
    /^\/api\/(pets|owners|appointments|medical-records|hotel-bookings|notifications|invoices|operations)\/[^/]{1,200}(\/(status|reschedule|cancel|status-history|history|undo-status|reminder|read|pay|daily-care|activation))?$/,
  );
  if (item) return `/api/${item[1]}/:id${item[2] ?? ''}`;
  if (/^\/api\/medical-records\/images\/[^/]{1,200}$/.test(p)) return '/api/medical-records/images/:id';
  if (/^\/api\/public\/rescue\/[^/]{1,200}(\/report)?$/.test(p)) return '/api/public/rescue/:token';
  const pet = p.match(/^\/api\/public\/pets\/[^/]{1,200}(\/rescue-reports)?$/);
  if (pet) return '/api/public/pets/:token' + (pet[1] ?? '');
  return undefined;
}
