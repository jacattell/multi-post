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

// ---------- Signed cookies ----------

/** A cookie holding "value", which cannot be changed without the secret. */
export async function signedCookie(env, name, value, maxAgeSeconds, secure) {
  const expires = Date.now() + maxAgeSeconds * 1000;
  const body = `${b64url(enc.encode(value))}.${expires}`;
  const signed = `${body}.${await hmac(env.SESSION_SECRET, `${name}:${body}`)}`;
  return `${name}=${signed}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

export function expiredCookie(name, secure) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** @returns the cookie's value, or null if missing, expired or tampered with. */
export async function readSignedCookie(env, request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([\\w-]+)\\.(\\d+)\\.([\\w-]+)`));
  if (!m || Number(m[2]) < Date.now()) return null;
  const good = await hmac(env.SESSION_SECRET, `${name}:${m[1]}.${m[2]}`);
  if (!(await safeEqual(m[3], good, env.SESSION_SECRET))) return null;
  try { return dec.decode(unb64url(m[1])); } catch { return null; }
}

// ---------- Login session ----------

const SESSION = 'mp_session';
const SESSION_SECONDS = 30 * 86400;

export const sessionCookie = (env, email, secure) => signedCookie(env, SESSION, email, SESSION_SECONDS, secure);
export const clearSession = (secure) => expiredCookie(SESSION, secure);

/** @returns the signed-in email, or null. */
export const sessionEmail = (env, request) => readSignedCookie(env, request, SESSION);

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
