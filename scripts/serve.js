// Serves the editor at http://localhost:8080 for development. Web Bluetooth needs a secure context; localhost is one.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  let file;
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (path.includes('\0')) throw new URIError('NUL in path');
    file = normalize(join(ROOT, path.endsWith('/') ? `${path}index.html` : path));
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (!file.startsWith(ROOT + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Knobwork: http://localhost:${PORT}/`));
