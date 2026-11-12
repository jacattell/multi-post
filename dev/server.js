// Runs the Worker on plain Node, without Cloudflare's tooling.
// Handy for a quick local try: npm run dev:node

import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { handle } from '../src/worker.js';
import { openD1 } from './d1-sqlite.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

mkdirSync(path.join(ROOT, 'data'), { recursive: true });

const env = {
  ...process.env,
  DB: openD1(path.join(ROOT, 'data', 'multi-post.db')),
  ASSETS: {
    async fetch(request) {
      const name = new URL(request.url).pathname.replace(/^\/$/, '/index.html');
      const file = path.join(ROOT, 'public', path.basename(name));
      try {
        return new Response(await readFile(file), { headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    },
  },
};

const port = Number(process.env.PORT) || 8787;

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  const response = await handle(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, '127.0.0.1', () => console.log(`multi-post is running at http://localhost:${port}`));
