import type { Server } from 'node:http';
import { integer } from './config.js';
// Stops accepting connections and waits for the requests in flight, up to SHUTDOWN_TIMEOUT_MS.
export async function closeServer(server: Server) {
  const deadline = integer('SHUTDOWN_TIMEOUT_MS', 10000, 100, 30000);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => server.closeAllConnections(), deadline);
    timer.unref();
    // A connection busy now goes idle once its request ends, so closing idle ones a single time is not enough.
    const sweep = setInterval(() => server.closeIdleConnections(), 100);
    sweep.unref();
    server.close(e => {
      clearTimeout(timer);
      clearInterval(sweep);
      e ? reject(e) : resolve();
    });
    server.closeIdleConnections();
  });
}
