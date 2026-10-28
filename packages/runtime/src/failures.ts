import { CircuitOpenError } from './circuitBreaker.js';

// One answer for every service's error handler: a failure that retrying the same
// request can heal (database, broker or Core not answering) is a 503 with Retry-After;
// anything else is a bug and a 500.
const PRISMA_TRANSIENT = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']);
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
  if (error instanceof CircuitOpenError) return true;
  const { name, code, cause } = error as { name?: unknown; code?: unknown; cause?: unknown };
  if (name === 'PrismaClientInitializationError' || name === 'TransientError') return true;
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
