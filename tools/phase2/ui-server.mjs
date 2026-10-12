import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';

// Serve only built assets on a dedicated port. There is no backend/DB proxy.
const root = resolve('frontend/dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (path.startsWith('/api/')) { res.writeHead(503); res.end('No API on the isolated UI server'); return; }
    let file = resolve(root, '.' + path);
    if (relative(root, file).startsWith('..')) { res.writeHead(404); res.end(); return; }
    try { if (!statSync(file).isFile()) file = resolve(root, 'index.html'); }
    catch { file = resolve(root, 'index.html'); }
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(file));
  } catch { res.writeHead(400); res.end(); }
});
server.listen(5187, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
