import { delay } from './delay.js';
export async function reconnect(service: string, signal: AbortSignal, run: () => Promise<void>) {
  while (!signal.aborted) {
    try {
      await run();
    } catch {
      if (!signal.aborted) process.stderr.write(JSON.stringify({ service, code: 'WORKER_RETRY' }) + '\n');
    }
    await delay(1000, signal);
  }
}
export async function startWorker(service: string, work: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
  };
  const parentStop = (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.on('message', parentStop);
  try {
    await work(controller.signal);
  } catch {
    process.stderr.write(JSON.stringify({ service, code: 'WORKER_START_FAILED' }) + '\n');
    process.exitCode = 1;
  } finally {
    if (deadline) clearTimeout(deadline);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.removeListener('message', parentStop);
    if (process.connected) process.disconnect();
  }
}
