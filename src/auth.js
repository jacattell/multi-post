// Login sessions and encryption. Uses Web Crypto, so it runs on
// Cloudflare Workers and on Node alike.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(text) {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text) {
  return crypto.subtle.digest('SHA-256', enc.encode(text));
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

/** Compare two strings without leaking where they differ. */
export async function safeEqual(a, b, secret) {
  const [x, y] = await Promise.all([hmac(secret, a), hmac(secret, b)]);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length && i < y.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// ---------- Session cookie ----------

const COOKIE = 'mp_session';
const SESSION_DAYS = 30;

export async function sessionCookie(env, secure) {
  const expires = Date.now() + SESSION_DAYS * 86400_000;
  const value = `${expires}.${await hmac(env.SESSION_SECRET, `session:${expires}`)}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}

export function clearCookie(secure) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export async function isLoggedIn(request, env) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([\\w-]+)`));
  if (!m || Number(m[1]) < Date.now()) return false;
  return safeEqual(m[2], await hmac(env.SESSION_SECRET, `session:${m[1]}`), env.SESSION_SECRET);
}

// ---------- Login throttle ----------

const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 8;

export async function tooManyAttempts(db, ip) {
  const since = Date.now() - WINDOW_MS;
  await db.prepare('DELETE FROM login_attempts WHERE at < ?').bind(since).run();
  const row = await db.prepare('SELECT count(*) AS n FROM login_attempts WHERE ip = ?').bind(ip).first();
  return row.n >= MAX_ATTEMPTS;
}

export async function recordFailure(db, ip) {
  await db.prepare('INSERT INTO login_attempts (ip, at) VALUES (?, ?)').bind(ip, Date.now()).run();
}

// ---------- Encryption for stored account tokens ----------

async function aesKey(env) {
  return crypto.subtle.importKey('raw', await sha256(`${env.SESSION_SECRET}:accounts`), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptJson(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(JSON.stringify(value)));
  return `${b64url(iv)}.${b64url(data)}`;
}

export async function decryptJson(env, text) {
  const [iv, data] = text.split('.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64url(iv) }, await aesKey(env), unb64url(data));
  return JSON.parse(dec.decode(plain));
}
