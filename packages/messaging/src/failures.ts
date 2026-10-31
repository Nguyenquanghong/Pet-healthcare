// ---- P03: retry without blocking the queue -----------------------------------------
// A failure retry can heal: a dependency not answering, a timeout, a lost connection.
export class TransientError extends Error {
  override readonly name = 'TransientError';
  constructor(readonly code: string) {
    super(code);
  }
}
// A failure no retry can heal: the same message fails the same way every time.
export class PermanentError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export type FailureKind = 'transient' | 'permanent';
export type ClassifyFailure = (error: unknown) => FailureKind;
// Unknown failures are retried. Retrying a permanent one costs a few idempotent
// attempts inside the retry window and no longer blocks the queue; sending a transient
// one to the DLQ needs a manual replay. Each service names what is permanent.
export function permanentOn(
  codes: readonly string[],
  also: (error: unknown) => boolean = () => false,
): ClassifyFailure {
  return error =>
    error instanceof PermanentError || (error instanceof Error && codes.includes(error.message)) || also(error)
      ? 'permanent'
      : 'transient';
}
export const defaultClassify = permanentOn([]);
// The code written to the p2-error-code header: an UPPER_CASE code (Prisma's P2002,
// ECONNREFUSED included), never free text that could carry data.
export function failureCode(error: unknown) {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : error instanceof Error
        ? error.message
        : '';
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : 'PROCESSING_FAILED';
}
