// The Cloudflare Worker: login and the JSON API.
// Files in public/ are served by Cloudflare directly.

import { listPeople, savePerson, deletePerson, ValidationError } from './db.js';
import { resolve } from './resolve.js';
import { publish } from './post.js';
import { PLATFORMS, LABELS, LIMITS, render, count } from '../public/render.js';
import { sessionCookie, clearSession, sessionEmail } from './auth.js';
import { allowedEmails, loginProviders, isProvider, startLogin, finishLogin, clearLoginState } from './login.js';
import {
  getAccounts, publicAccounts, deleteAccount,
  connectBluesky, connectMastodon, startOAuth, finishOAuth,
} from './accounts.js';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 1_000_000; // Bluesky's limit; the page shrinks images to fit.
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif'];

const send = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new ValidationError('Invalid JSON');
  }
}

async function readPost(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    throw new ValidationError('Invalid form');
  }
  const parse = (name, fallback) => {
    try { return JSON.parse(form.get(name) || fallback); } catch { return JSON.parse(fallback); }
  };
  const files = form.getAll('images').filter((f) => typeof f !== 'string');
  if (files.length > MAX_IMAGES) throw new ValidationError(`At most ${MAX_IMAGES} images`);
  const meta = parse('imageMeta', '[]');
  const images = [];
  for (const [i, file] of files.entries()) {
    if (!IMAGE_TYPES.includes(file.type)) throw new ValidationError('Images must be JPEG, PNG or GIF');
    if (file.size > MAX_IMAGE_BYTES) throw new ValidationError('An image is too large');
    images.push({
      bytes: await file.arrayBuffer(),
      type: file.type,
      alt: String(meta[i]?.alt || '').trim().slice(0, 1500),
      width: Number(meta[i]?.width) || 0,
      height: Number(meta[i]?.height) || 0,
    });
  }
  return {
    text: String(form.get('text') || '').trim(),
    platforms: PLATFORMS.filter((p) => parse('platforms', '[]').includes?.(p)),
    images,
  };
}

async function api(request, url, ctx) {
  const { env, db } = ctx;
  const { pathname } = url;
  const method = request.method;
  const secure = url.protocol === 'https:';

  const providers = loginProviders(env);
  const allowed = allowedEmails(env);
  if (!env.SESSION_SECRET || !allowed.length || !providers.length) {
    return send(503, { error: 'Not set up: add SESSION_SECRET, ALLOWED_EMAILS, and Google or GitHub sign-in secrets. See the README.' });
  }

  // Only our own page may make changes (blocks cross-site requests).
  if (method !== 'GET' && request.headers.get('Origin') !== url.origin) {
    return send(403, { error: 'Cross-site request refused' });
  }

  // ----- Sign in with Google or GitHub -----
  const loginMatch = pathname.match(/^\/api\/login\/(\w+)(\/callback)?$/);
  if (loginMatch && method === 'GET') {
    const [, provider, isCallback] = loginMatch;
    if (!isProvider(provider) || !providers.includes(provider)) return send(404, { error: 'Unknown sign-in method' });
    if (!isCallback) {
      const { location, cookie } = await startLogin(ctx, provider, url.origin, secure);
      return redirect(location, [cookie]);
    }
    try {
      const email = await finishLogin(ctx, provider, request, url.searchParams, url.origin);
      return redirect('/', [await sessionCookie(env, email, secure), clearLoginState(secure)]);
    } catch (err) {
      return redirect(`/?login_error=${encodeURIComponent(err.message)}`, [clearLoginState(secure)]);
    }
  }
  if (pathname === '/api/logout' && method === 'POST') {
    return send(200, { ok: true }, { 'Set-Cookie': clearSession(secure) });
  }

  // Checked on every request, so removing an email from ALLOWED_EMAILS locks it out.
  const signedIn = await sessionEmail(env, request);
  const email = signedIn && allowed.includes(signedIn) ? signedIn : null;
  if (pathname === '/api/me' && method === 'GET') return send(200, { loggedIn: Boolean(email), email, providers });
  if (!email) return send(401, { error: 'Please log in' });

  // ----- Everything below needs a login -----
  ctx.accounts = await getAccounts(ctx);

  if (pathname === '/api/config' && method === 'GET') {
    return send(200, { accounts: publicAccounts(ctx.accounts, env) });
  }

  // ----- Your connected accounts -----
  const accountMatch = pathname.match(/^\/api\/accounts\/(\w+)$/);
  if (accountMatch && PLATFORMS.includes(accountMatch[1])) {
    const platform = accountMatch[1];
    if (method === 'DELETE') {
      await deleteAccount(ctx, platform);
      return send(200, { ok: true });
    }
    if (method === 'POST' && platform === 'bluesky') {
      await connectBluesky(ctx, await readJson(request));
      return send(200, { ok: true });
    }
    if (method === 'POST' && platform === 'mastodon') {
      await connectMastodon(ctx, await readJson(request));
      return send(200, { ok: true });
    }
  }
  const oauthMatch = pathname.match(/^\/api\/(connect|callback)\/(x|linkedin)$/);
  if (oauthMatch && method === 'GET') {
    const [, step, platform] = oauthMatch;
    try {
      if (step === 'connect') return redirect(await startOAuth(ctx, platform, url.origin));
      await finishOAuth(ctx, platform, url.searchParams, url.origin);
      return redirect(`/?connected=${platform}`);
    } catch (err) {
      return redirect(`/?connect_error=${encodeURIComponent(`${LABELS[platform]}: ${err.message}`)}`);
    }
  }

  // ----- Saved people -----
  if (pathname === '/api/people' && method === 'GET') return send(200, await listPeople(db));
  if (pathname === '/api/people' && method === 'POST') {
    const body = await readJson(request);
    return send(201, await savePerson(db, { name: body.name, profiles: body.profiles }));
  }
  const personMatch = pathname.match(/^\/api\/people\/(\d+)$/);
  if (personMatch && method === 'PUT') {
    const body = await readJson(request);
    return send(200, await savePerson(db, { id: Number(personMatch[1]), name: body.name, profiles: body.profiles }));
  }
  if (personMatch && method === 'DELETE') {
    return (await deletePerson(db, Number(personMatch[1])))
      ? send(200, { ok: true })
      : send(404, { error: 'Person not found' });
  }

  // ----- Find a profile -----
  const resolveMatch = pathname.match(/^\/api\/resolve\/(\w+)$/);
  if (resolveMatch && method === 'GET') {
    if (!PLATFORMS.includes(resolveMatch[1])) return send(404, { error: 'Unknown platform' });
    try {
      return send(200, await resolve(resolveMatch[1], url.searchParams.get('q') || '', ctx));
    } catch (err) {
      return send(502, { error: `Lookup failed: ${err.message}` });
    }
  }

  // ----- Post -----
  if (pathname === '/api/post' && method === 'POST') {
    const { text, platforms, images } = await readPost(request);
    if (!text && !images.length) throw new ValidationError('Write something first');
    if (!platforms.length) throw new ValidationError('Choose at least one platform');
    const people = await listPeople(db);
    const rendered = Object.fromEntries(platforms.map((p) => [p, render(text, p, people)]));
    for (const p of platforms) {
      const n = count(p, rendered[p].text);
      if (n > LIMITS[p]) throw new ValidationError(`Too long for ${LABELS[p]}: ${n} of ${LIMITS[p]} characters`);
    }
    const results = await Promise.all(platforms.map((p) => publish(p, rendered[p], images, ctx)));
    return send(200, Object.fromEntries(platforms.map((p, i) => [p, results[i]])));
  }

  return send(404, { error: 'Not found' });
}

/** fetchFn can be swapped in tests. */
export async function handle(request, env, fetchFn = fetch) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) {
    return env.ASSETS ? env.ASSETS.fetch(request) : send(404, { error: 'Not found' });
  }
  // Wrapped so the platform's fetch is never called with a wrong "this".
  const ctx = { env, db: env.DB, fetch: (...args) => fetchFn(...args), accounts: {} };
  try {
    return await api(request, url, ctx);
  } catch (err) {
    if (err instanceof ValidationError) return send(400, { error: err.message });
    console.error(err);
    return send(500, { error: 'Something went wrong' });
  }
}

export default { fetch: (request, env) => handle(request, env) };
