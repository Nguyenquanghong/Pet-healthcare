// A request the caller broke while its body was being read (invalid JSON, too large, unsupported charset or
// encoding, aborted upload, too many parameters) arrives as a body-parser/http-errors error with a 4xx status
// and expose=true. It is neither a bug (500) nor an outage (503): answer that status. The text is fixed per
// service, never the parser's message, which can quote the request.
export type RequestFaultText = { invalid: string; large: string; other: string };

export function requestFault(error: unknown, text: RequestFaultText) {
  const { status, expose, type } = (error ?? {}) as { status?: unknown; expose?: unknown; type?: unknown };
  if (expose !== true || typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status >= 500)
    return undefined;
  const message = type === 'entity.parse.failed' ? text.invalid : type === 'entity.too.large' ? text.large : text.other;
  return { status, body: { error: message } };
}
