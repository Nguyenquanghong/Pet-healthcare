export class BusinessError extends Error {
  constructor(
    public readonly status: 401 | 403 | 404 | 409 | 422 | 502 | 503,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

// Optimistic lock: the caller edited an older revision. `current` is the stored
// row, so the client can show what changed instead of losing its draft.
export class StaleRevision extends BusinessError {
  constructor(
    message: string,
    code: string,
    public readonly current: unknown,
  ) {
    super(409, message, code);
  }
}
