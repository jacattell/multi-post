// Publish a rendered post. Platforms with credentials are posted through
// their API; the rest return a link that opens the platform's own composer.

import { mastodonInstance } from './resolve.js';

const TIMEOUT_MS = 15000;

async function postJson(fetchFn, url, body, headers = {}) {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `${new URL(url).hostname} answered ${res.status}`);
  return data;
}

export function connected(env) {
  return {
    bluesky: Boolean(env.BLUESKY_HANDLE && env.BLUESKY_APP_PASSWORD),
    mastodon: Boolean(env.MASTODON_INSTANCE && env.MASTODON_TOKEN),
    x: false,
    linkedin: false,
  };
}

export function composeUrl(platform, text, env) {
  const t = encodeURIComponent(text);
  if (platform === 'bluesky') return `https://bsky.app/intent/compose?text=${t}`;
  if (platform === 'mastodon') return `${mastodonInstance(env)}/share?text=${t}`;
  if (platform === 'x') return `https://x.com/intent/post?text=${t}`;
  return `https://www.linkedin.com/feed/?shareActive=true&text=${t}`;
}

const utf8Length = (s) => Buffer.byteLength(s, 'utf8');

/** Bluesky needs mentions and links marked up with UTF-8 byte offsets. */
export async function blueskyFacets({ text, mentions }, resolveDid) {
  const facets = [];
  const span = (start, end) => ({
    byteStart: utf8Length(text.slice(0, start)),
    byteEnd: utf8Length(text.slice(0, end)),
  });
  for (const m of mentions) {
    if (!m.profile) continue;
    const did = m.profile.platformId?.startsWith('did:')
      ? m.profile.platformId
      : await resolveDid(m.profile.handle).catch(() => null);
    if (!did) continue;
    facets.push({
      index: span(m.start, m.end),
      features: [{ $type: 'app.bsky.richtext.facet#mention', did }],
    });
  }
  for (const m of text.matchAll(/https?:\/\/[^\s]+/g)) {
    const uri = m[0].replace(/[.,;:!?)\]]+$/, '');
    facets.push({
      index: span(m.index, m.index + uri.length),
      features: [{ $type: 'app.bsky.richtext.facet#link', uri }],
    });
  }
  return facets;
}

async function postBluesky(rendered, { fetch, env }) {
  const pds = (env.BLUESKY_PDS || 'https://bsky.social').replace(/\/+$/, '');
  const session = await postJson(fetch, `${pds}/xrpc/com.atproto.server.createSession`, {
    identifier: env.BLUESKY_HANDLE,
    password: env.BLUESKY_APP_PASSWORD,
  });
  const resolveDid = async (handle) => {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    return res.ok ? (await res.json()).did : null;
  };
  const facets = await blueskyFacets(rendered, resolveDid);
  const record = {
    $type: 'app.bsky.feed.post',
    text: rendered.text,
    createdAt: new Date().toISOString(),
    ...(facets.length ? { facets } : {}),
  };
  const out = await postJson(
    fetch,
    `${pds}/xrpc/com.atproto.repo.createRecord`,
    { repo: session.did, collection: 'app.bsky.feed.post', record },
    { Authorization: `Bearer ${session.accessJwt}` },
  );
  return `https://bsky.app/profile/${session.handle}/post/${out.uri.split('/').pop()}`;
}

async function postMastodon(rendered, { fetch, env }) {
  const out = await postJson(
    fetch,
    `${mastodonInstance(env)}/api/v1/statuses`,
    { status: rendered.text },
    { Authorization: `Bearer ${env.MASTODON_TOKEN}` },
  );
  return out.url;
}

const POSTERS = { bluesky: postBluesky, mastodon: postMastodon };

/** @returns { status: 'posted' | 'manual' | 'error', text, url?, error? } */
export async function publish(platform, rendered, ctx) {
  const { text } = rendered;
  if (!connected(ctx.env)[platform]) {
    return { status: 'manual', text, url: composeUrl(platform, text, ctx.env) };
  }
  try {
    return { status: 'posted', text, url: await POSTERS[platform](rendered, ctx) };
  } catch (err) {
    return { status: 'error', text, error: err.message, url: composeUrl(platform, text, ctx.env) };
  }
}
