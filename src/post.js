// Publish a rendered post, with images, to one platform.
// Connected platforms are posted through their API. The rest return a
// link that opens the platform's own composer with the text filled in.
//
// rendered: { text, mentions } from render()
// images:   [{ bytes: ArrayBuffer, type, alt, width, height }]

import { xAccessToken } from './accounts.js';

const TIMEOUT_MS = 20000;
const enc = new TextEncoder();

async function call(ctx, url, init = {}) {
  const res = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const reason = data.message || data.detail || data.error_description || data.error || data.title;
    const host = new URL(url).hostname;
    throw new Error(reason ? `${host}: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}` : `${host} answered ${res.status}`);
  }
  return res;
}

const json = (body, headers = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

export function composeUrl(platform, text, accounts = {}) {
  const t = encodeURIComponent(text);
  if (platform === 'bluesky') return `https://bsky.app/intent/compose?text=${t}`;
  if (platform === 'mastodon') return `${accounts.mastodon?.instance || 'https://mastodon.social'}/share?text=${t}`;
  if (platform === 'x') return `https://x.com/intent/post?text=${t}`;
  return `https://www.linkedin.com/feed/?shareActive=true&text=${t}`;
}

// ---------- Bluesky ----------

const utf8Length = (s) => enc.encode(s).length;

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

async function postBluesky(rendered, images, ctx) {
  const { pds, identifier, password } = ctx.accounts.bluesky;
  const session = await (await call(ctx, `${pds}/xrpc/com.atproto.server.createSession`, json({ identifier, password }))).json();
  const auth = { Authorization: `Bearer ${session.accessJwt}` };

  const resolveDid = async (handle) => {
    const res = await ctx.fetch(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    return res.ok ? (await res.json()).did : null;
  };
  const facets = await blueskyFacets(rendered, resolveDid);

  const uploaded = [];
  for (const img of images) {
    const res = await call(ctx, `${pds}/xrpc/com.atproto.repo.uploadBlob`, {
      method: 'POST',
      headers: { 'Content-Type': img.type, ...auth },
      body: img.bytes,
    });
    uploaded.push({
      alt: img.alt,
      image: (await res.json()).blob,
      ...(img.width && img.height ? { aspectRatio: { width: img.width, height: img.height } } : {}),
    });
  }

  const record = {
    $type: 'app.bsky.feed.post',
    text: rendered.text,
    createdAt: new Date().toISOString(),
    ...(facets.length ? { facets } : {}),
    ...(uploaded.length ? { embed: { $type: 'app.bsky.embed.images', images: uploaded } } : {}),
  };
  const out = await (await call(
    ctx,
    `${pds}/xrpc/com.atproto.repo.createRecord`,
    json({ repo: session.did, collection: 'app.bsky.feed.post', record }, auth),
  )).json();
  return `https://bsky.app/profile/${session.handle}/post/${out.uri.split('/').pop()}`;
}

// ---------- Mastodon ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postMastodon(rendered, images, ctx) {
  const { instance, token } = ctx.accounts.mastodon;
  const auth = { Authorization: `Bearer ${token}` };
  const mediaIds = [];
  for (const img of images) {
    const form = new FormData();
    form.set('file', new Blob([img.bytes], { type: img.type }), 'image');
    if (img.alt) form.set('description', img.alt);
    const res = await call(ctx, `${instance}/api/v2/media`, { method: 'POST', headers: auth, body: form });
    const { id } = await res.json();
    // 202 means the server is still processing the image. Wait until it is ready.
    for (let i = 0, status = res.status; status !== 200 && i < 10; i++) {
      await sleep(1000);
      status = (await call(ctx, `${instance}/api/v1/media/${id}`, { headers: auth })).status;
    }
    mediaIds.push(id);
  }
  const out = await (await call(
    ctx,
    `${instance}/api/v1/statuses`,
    json({ status: rendered.text, ...(mediaIds.length ? { media_ids: mediaIds } : {}) }, auth),
  )).json();
  return out.url;
}

// ---------- X ----------

async function postX(rendered, images, ctx) {
  const account = ctx.accounts.x;
  const auth = { Authorization: `Bearer ${await xAccessToken(ctx, account)}` };
  const mediaIds = [];
  for (const img of images) {
    const form = new FormData();
    form.set('media', new Blob([img.bytes], { type: img.type }), 'image');
    form.set('media_category', 'tweet_image');
    const { data } = await (await call(ctx, 'https://api.x.com/2/media/upload', { method: 'POST', headers: auth, body: form })).json();
    if (img.alt) {
      // Alt text is nice to have. Do not fail the post over it.
      await call(ctx, 'https://api.x.com/2/media/metadata', json({ id: data.id, metadata: { alt_text: { text: img.alt.slice(0, 1000) } } }, auth))
        .catch(() => {});
    }
    mediaIds.push(data.id);
  }
  const out = await (await call(
    ctx,
    'https://api.x.com/2/tweets',
    json({ text: rendered.text, ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}) }, auth),
  )).json();
  return `https://x.com/${account.username}/status/${out.data.id}`;
}

// ---------- LinkedIn ----------

/** LinkedIn retires API versions after about a year, so follow the calendar. */
export function linkedinVersion(env, now = new Date()) {
  if (env.LINKEDIN_VERSION) return env.LINKEDIN_VERSION;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** LinkedIn post text gives special meaning to these characters. */
export const escapeLinkedIn = (text) => text.replace(/[\\|{}@\[\]()<>*_~]/g, '\\$&');

async function postLinkedIn(rendered, images, ctx) {
  const account = ctx.accounts.linkedin;
  if (account.expiresAt && account.expiresAt < Date.now()) throw new Error('LinkedIn sign-in expired. Reconnect LinkedIn.');
  const headers = {
    Authorization: `Bearer ${account.accessToken}`,
    'LinkedIn-Version': linkedinVersion(ctx.env),
    'X-Restli-Protocol-Version': '2.0.0',
  };
  const uploaded = [];
  for (const img of images) {
    const init = await (await call(
      ctx,
      'https://api.linkedin.com/rest/images?action=initializeUpload',
      json({ initializeUploadRequest: { owner: account.author } }, headers),
    )).json();
    await call(ctx, init.value.uploadUrl, {
      method: 'PUT',
      headers: { Authorization: headers.Authorization, 'Content-Type': img.type },
      body: img.bytes,
    });
    uploaded.push({ id: init.value.image, ...(img.alt ? { altText: img.alt } : {}) });
  }
  const content = uploaded.length === 1
    ? { media: uploaded[0] }
    : uploaded.length > 1 ? { multiImage: { images: uploaded } } : null;
  const res = await call(ctx, 'https://api.linkedin.com/rest/posts', json({
    author: account.author,
    commentary: escapeLinkedIn(rendered.text),
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    ...(content ? { content } : {}),
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  }, headers));
  const urn = res.headers.get('x-restli-id');
  return urn ? `https://www.linkedin.com/feed/update/${urn}/` : 'https://www.linkedin.com/feed/';
}

const POSTERS = { bluesky: postBluesky, mastodon: postMastodon, x: postX, linkedin: postLinkedIn };

/** @returns { status: 'posted' | 'manual' | 'error', text, url, error? } */
export async function publish(platform, rendered, images, ctx) {
  const { text } = rendered;
  const url = composeUrl(platform, text, ctx.accounts);
  if (!ctx.accounts[platform]) return { status: 'manual', text, url };
  try {
    return { status: 'posted', text, url: await POSTERS[platform](rendered, images, ctx) };
  } catch (err) {
    return { status: 'error', text, url, error: err.message };
  }
}
