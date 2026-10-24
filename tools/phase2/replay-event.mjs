import { replayEvent, replayAll } from '@nipopeto/messaging';
// One event at the head of the DLQ by its eventId, or (P03) --all [--max N]: the DLQ in
// order, at most N events (default 100), stopping at an invalid or repeated event.
const [queue, selector, ...rest] = process.argv.slice(2);
const all = selector === '--all', max = !rest.length ? 100 : rest.length === 2 && rest[0] === '--max' ? Number(rest[1]) : NaN;
if (!process.env.BROKER_URL || !queue || !selector || (!all && rest.length) || (all && !Number.isSafeInteger(max)))
  throw new Error('Usage: BROKER_URL=<explicit> node tools/phase2/replay-event.mjs <queue> <eventId> | <queue> --all [--max N]');
try { console.log(JSON.stringify(all ? await replayAll(process.env.BROKER_URL, queue, max) : await replayEvent(process.env.BROKER_URL, queue, selector))); }
catch { process.stderr.write('REPLAY_FAILED; the DLQ message in flight is retained\n'); process.exitCode = 1; }
