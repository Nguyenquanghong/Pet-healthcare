import { type Envelope } from '@nipopeto/contracts';
// Transport metadata only. Untrusted non-UUID identifiers are never logged.
export function logEvent(service: string, event: Envelope, status: string, started = performance.now()) {
  if (process.env.PHASE2_RUNTIME_REQUIRED !== '1') return;
  const id = (v: string) => (/^[0-9a-f-]{36}$/i.test(v) ? v : 'unknown');
  try {
    process.stdout.write(
      JSON.stringify({
        service,
        eventId: id(event.eventId),
        correlationId: id(event.correlationId),
        eventType: event.eventType,
        status,
        latencyMs: Math.round(performance.now() - started),
      }) + '\n',
    );
  } catch {}
}
