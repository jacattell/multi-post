// Limits on what a signed-in browser can send: request size, image content and request rate.

export const MAX_JSON_BYTES = 64 * 1024;
// A post: up to 4 images of 1 MB each, plus text and form overhead.
export const MAX_POST_BYTES = 4 * 1_000_000 + 256 * 1024;
// An alt text request: 1 image of 1 MB, plus the post text.
export const MAX_ALT_BYTES = 1_000_000 + 64 * 1024;

export class TooLarge extends Error {
  constructor() { super('That is too large to send'); }
}
export class TooMany extends Error {
  constructor() { super('Too many requests. Please wait a minute and try again.'); }
}

/**
 * Reads the request body, stopping as soon as it passes `max` bytes, and returns a copy
 * of the request to parse. An honest Content-Length that is too large is refused before
 * reading anything; a missing or wrong one is caught while reading.
 */
export async function readLimited(request, max) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) throw new TooLarge();
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { body.set(c, at); at += c.byteLength; }
  return new Request(request.url, { method: request.method, headers: request.headers, body });
}

/** True if the file's first bytes match its claimed type, so a file can't pretend to be an image. */
export function looksLike(bytes, type) {
  const b = new Uint8Array(bytes.slice(0, 8));
  if (type === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === 'image/png') return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x);
  if (type === 'image/gif') return String.fromCharCode(...b.slice(0, 6)) === 'GIF87a' || String.fromCharCode(...b.slice(0, 6)) === 'GIF89a';
  return false;
}

/**
 * Uses a Workers rate limiting binding (set in wrangler.jsonc), keyed by the signed-in email.
 * Without the binding (local tests and development), nothing is limited.
 */
export async function checkRate(binding, key) {
  if (!binding || typeof binding.limit !== 'function') return;
  const { success } = await binding.limit({ key });
  if (!success) throw new TooMany();
}
