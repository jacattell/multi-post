import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { openDb, listPeople, savePerson, deletePerson, ValidationError } from './lib/db.js';
import { resolve } from './lib/resolve.js';
import { publish, connected } from './lib/post.js';
import { PLATFORMS, LIMITS, render, count } from './lib/render.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/render.js': ['lib/render.js', 'text/javascript; charset=utf-8'],
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new ValidationError('Request too large');
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new ValidationError('Invalid JSON');
  }
}

export function createApp({ db, fetch = globalThis.fetch, env = process.env }) {
  const ctx = { fetch, env };

  async function api(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    if (method !== 'GET') {
      // Other websites cannot send JSON here without a CORS preflight,
      // which we never approve. This stops them posting on your behalf.
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
        return send(res, 415, { error: 'Content-Type must be application/json' });
      }
    }

    if (pathname === '/api/config' && method === 'GET') {
      return send(res, 200, { connected: connected(env), canVerifyX: Boolean(env.X_BEARER_TOKEN) });
    }

    if (pathname === '/api/people' && method === 'GET') {
      return send(res, 200, listPeople(db));
    }
    if (pathname === '/api/people' && method === 'POST') {
      const body = await readBody(req);
      return send(res, 201, savePerson(db, { name: body.name, profiles: body.profiles }));
    }
    const personMatch = pathname.match(/^\/api\/people\/(\d+)$/);
    if (personMatch && method === 'PUT') {
      const body = await readBody(req);
      return send(res, 200, savePerson(db, { id: Number(personMatch[1]), name: body.name, profiles: body.profiles }));
    }
    if (personMatch && method === 'DELETE') {
      return deletePerson(db, Number(personMatch[1]))
        ? send(res, 200, { ok: true })
        : send(res, 404, { error: 'Person not found' });
    }

    const resolveMatch = pathname.match(/^\/api\/resolve\/(\w+)$/);
    if (resolveMatch && method === 'GET') {
      if (!PLATFORMS.includes(resolveMatch[1])) return send(res, 404, { error: 'Unknown platform' });
      try {
        return send(res, 200, await resolve(resolveMatch[1], url.searchParams.get('q') || '', ctx));
      } catch (err) {
        return send(res, 502, { error: `Lookup failed: ${err.message}` });
      }
    }

    if (pathname === '/api/post' && method === 'POST') {
      const body = await readBody(req);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const platforms = PLATFORMS.filter((p) => body.platforms?.includes(p));
      if (!text) throw new ValidationError('Write something first');
      if (!platforms.length) throw new ValidationError('Choose at least one platform');
      const people = listPeople(db);
      const rendered = Object.fromEntries(platforms.map((p) => [p, render(text, p, people)]));
      for (const p of platforms) {
        const n = count(p, rendered[p].text);
        if (n > LIMITS[p]) throw new ValidationError(`Too long for ${p}: ${n} of ${LIMITS[p]} characters`);
      }
      const results = await Promise.all(platforms.map((p) => publish(p, rendered[p], ctx)));
      return send(res, 200, Object.fromEntries(platforms.map((p, i) => [p, results[i]])));
    }

    return send(res, 404, { error: 'Not found' });
  }

  return http.createServer(async (req, res) => {
    try {
      // Only answer to localhost names (blocks DNS-rebinding attacks).
      const host = (req.headers.host || '').replace(/:\d+$/, '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
        return send(res, 403, { error: 'Forbidden host' });
      }
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      const file = STATIC[url.pathname];
      if (!file || req.method !== 'GET') return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
      res.end(await readFile(path.join(ROOT, file[0])));
    } catch (err) {
      if (err instanceof ValidationError) return send(res, 400, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Something went wrong' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const db = openDb(path.join(ROOT, 'data', 'multi-post.db'));
  const port = Number(process.env.PORT) || 3000;
  createApp({ db }).listen(port, '127.0.0.1', () => {
    console.log(`multi-post is running at http://localhost:${port}`);
  });
}
