export class BusinessError extends Error {
  constructor(public readonly status: 401 | 403 | 404 | 409 | 422 | 502, message: string) {
    super(message);
  }
}
