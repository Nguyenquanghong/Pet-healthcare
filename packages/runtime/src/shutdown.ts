// IPC is only available to an OS parent that created this child with an IPC
// channel. It allows the Windows test harness to request a genuine drain;
// Node's child.kill(SIGTERM) on Windows terminates without running handlers.
export function installShutdown(service: string, work: () => Promise<void>) {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      process.stderr.write(JSON.stringify({ service, code: 'SHUTDOWN_DEADLINE' }) + '\n');
      process.exit(1);
    }, 12000);
    deadline.unref();
    try {
      await work();
      clearTimeout(deadline);
      process.stdout.write(JSON.stringify({ service, status: 'drained' }) + '\n');
      if (process.connected) process.disconnect();
    } catch {
      process.stderr.write(JSON.stringify({ service, code: 'SHUTDOWN_FAILED' }) + '\n');
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    }
  };
  process.once('SIGTERM', () => {
    void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
  process.on('message', message => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') void stop();
  });
}
