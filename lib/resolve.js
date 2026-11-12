// Look up a person's profile on each platform.
// Every resolver returns an array of candidates:
//   { handle, displayName, avatar, url, platformId, unverified? }

const TIMEOUT_MS = 8000;

async function getJson(fetchFn, url, headers = {}) {
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return res.json();
}

const stripAt = (q) => q.trim().replace(/^@/, '');

// Bluesky: public search, no login needed.
async function bluesky(q, { fetch }) {
  const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.actor.searchActorsTypeahead');
  url.searchParams.set('q', stripAt(q));
  url.searchParams.set('limit', '6');
  const data = await getJson(fetch, url.href);
  return (data.actors || []).map((a) => ({
    handle: a.handle,
    displayName: a.displayName || a.handle,
    avatar: a.avatar || null,
    url: `https://bsky.app/profile/${a.handle}`,
    platformId: a.did,
  }));
}

export function mastodonInstance(env) {
  return (env.MASTODON_INSTANCE || 'https://mastodon.social').replace(/\/+$/, '');
}

function mastodonAccount(a, host) {
  return {
    handle: a.acct.includes('@') ? a.acct : `${a.acct}@${host}`,
    displayName: a.display_name || a.username,
    avatar: a.avatar_static || a.avatar || null,
    url: a.url,
    platformId: a.id,
  };
}

// Mastodon: "user@server" is looked up on that server; anything else is
// searched on your home server (better results with MASTODON_TOKEN).
async function mastodon(q, { fetch, env }) {
  const query = stripAt(q);
  const full = query.match(/^([\w.-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i);
  if (full) {
    try {
      const a = await getJson(fetch, `https://${full[2]}/api/v1/accounts/lookup?acct=${encodeURIComponent(full[1])}`);
      return [mastodonAccount(a, full[2].toLowerCase())];
    } catch { /* fall through to search */ }
  }
  const instance = mastodonInstance(env);
  const url = new URL(instance + '/api/v2/search');
  url.searchParams.set('q', query);
  url.searchParams.set('type', 'accounts');
  url.searchParams.set('limit', '6');
  const headers = {};
  if (env.MASTODON_TOKEN) {
    url.searchParams.set('resolve', 'true');
    headers.Authorization = `Bearer ${env.MASTODON_TOKEN}`;
  }
  const data = await getJson(fetch, url.href, headers);
  return (data.accounts || []).map((a) => mastodonAccount(a, new URL(instance).host));
}

export function parseXHandle(q) {
  const m = q.trim().match(/^(?:(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/)?@?([A-Za-z0-9_]{1,15})\/?(?:\?.*)?$/);
  return m ? m[1] : null;
}

// X has no free search. We take the handle as typed, and verify it only if
// a bearer token is configured.
async function x(q, { fetch, env }) {
  const handle = parseXHandle(q);
  if (!handle) return [];
  const url = `https://x.com/${handle}`;
  if (!env.X_BEARER_TOKEN) {
    return [{ handle, displayName: null, avatar: null, url, platformId: null, unverified: true }];
  }
  const data = await getJson(
    fetch,
    `https://api.x.com/2/users/by/username/${handle}?user.fields=name,profile_image_url`,
    { Authorization: `Bearer ${env.X_BEARER_TOKEN}` },
  );
  if (!data.data) return [];
  const u = data.data;
  return [{
    handle: u.username,
    displayName: u.name,
    avatar: u.profile_image_url || null,
    url: `https://x.com/${u.username}`,
    platformId: u.id,
  }];
}

export function parseLinkedInUrl(q) {
  const m = q.trim().match(/^(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com\/(in|company|school)\/([^\/?#\s]+)/i);
  if (!m) return null;
  let slug = m[2];
  try { slug = decodeURIComponent(slug); } catch { /* keep as is */ }
  if (/\s/.test(slug)) return null;
  const kind = m[1].toLowerCase();
  return { kind, slug, url: `https://www.linkedin.com/${kind}/${encodeURIComponent(slug)}` };
}

// LinkedIn has no public lookup API, so the user pastes the profile URL.
async function linkedin(q) {
  const parsed = parseLinkedInUrl(q);
  if (!parsed) return [];
  return [{ handle: parsed.slug, displayName: null, avatar: null, url: parsed.url, platformId: null, unverified: true }];
}

const RESOLVERS = { bluesky, mastodon, x, linkedin };

export async function resolve(platform, q, ctx) {
  if (!RESOLVERS[platform]) throw new Error('Unknown platform');
  if (!q || !q.trim()) return [];
  return RESOLVERS[platform](q.slice(0, 300), ctx);
}
