// One answer for every service's error handler: a failure that retrying the same
// request can heal (database, broker or Core not answering) is a 503 with Retry-After;
// anything else is a bug and a 500.
const PRISMA_TRANSIENT = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034', 'P2037']);
// A raw query (P2010) reports PostgreSQL's SQLSTATE in meta.code: serialization failure, deadlock, lock not
// available, statement canceled, too many connections, shutdown/crash/cannot connect, and the whole class 08
// (connection exception). Syntax and constraint states (42601, 23505 ...) stay bugs.
const SQLSTATE_TRANSIENT = new Set(['40001', '40P01', '55P03', '57014', '53300', '57P01', '57P02', '57P03']);
const transientSqlState = (state: unknown) =>
  typeof state === 'string' && (SQLSTATE_TRANSIENT.has(state) || /^08[0-9A-Z]{3}$/.test(state));
// The query engine gives up on a connection without a code: "Error in PostgreSQL connection: Error { kind: Closed ... }".
const CONNECTION_LOST = /Error in PostgreSQL connection|\bClosed\b/;
const TRANSPORT_TRANSIENT = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export const isTransientFailure = (error: unknown): boolean => transient(error, 0);

function transient(error: unknown, depth: number): boolean {
  if (!error || typeof error !== 'object' || depth > 3) return false;
  const { name, code, cause, meta, message } = error as {
    name?: unknown;
    code?: unknown;
    cause?: unknown;
    meta?: { code?: unknown } | null;
    message?: unknown;
  };
  // By name, not instanceof: a second copy of the package still answers 503.
  if (name === 'PrismaClientInitializationError' || name === 'TransientError' || name === 'CircuitOpenError')
    return true;
  if (name === 'PrismaClientUnknownRequestError' && typeof message === 'string' && CONNECTION_LOST.test(message))
    return true;
  if (code === 'P2010' && transientSqlState(meta?.code)) return true;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  if (typeof code === 'string' && (PRISMA_TRANSIENT.has(code) || TRANSPORT_TRANSIENT.has(code))) return true;
  // undici reports a refused or reset connection as TypeError('fetch failed') with the cause attached.
  return cause !== undefined && transient(cause, depth + 1);
}

export const INTERNAL_ERROR_BODY = { error: 'An unexpected server error occurred.', code: 'INTERNAL_ERROR' } as const;

// One structured line: the error's class and code only, never its message, stack or URL.
export function reportUnexpected(service: string, error: unknown, requestId?: string) {
  const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
  const entry: Record<string, unknown> = { service, code: 'UNEXPECTED_APPLICATION_ERROR' };
  if (requestId) entry.requestId = requestId;
  if (typeof name === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(name)) entry.errorName = name;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) entry.errorCode = code;
  process.stderr.write(JSON.stringify(entry) + '\n');
  return INTERNAL_ERROR_BODY;
}
