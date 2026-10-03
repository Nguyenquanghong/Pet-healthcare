import type { Server } from "node:http";

export async function drainServer(server: Server, timeoutMs = 10_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => server.closeAllConnections(), timeoutMs);
    timer.unref();
    server.close(error => {
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    });
  });
}
