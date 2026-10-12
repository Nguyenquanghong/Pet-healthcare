import { replayEvent } from '@nipopeto/messaging';
const queue = process.argv[2], eventId = process.argv[3];
if (!process.env.BROKER_URL || !queue || !eventId) throw new Error('Usage: BROKER_URL=<explicit> node tools/phase2/replay-event.mjs <queue> <eventId>');
try { console.log(JSON.stringify(await replayEvent(process.env.BROKER_URL, queue, eventId))); }
catch { process.stderr.write('REPLAY_FAILED; original DLQ delivery retained\n'); process.exitCode = 1; }
