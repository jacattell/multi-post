import test from 'node:test';
import assert from 'node:assert/strict';

import { render, count, mentionedNames } from '../public/render.js';
import { savePerson, listPeople, deletePerson, ValidationError } from '../src/db.js';
import { resolve, parseXHandle, parseLinkedInUrl } from '../src/resolve.js';
import { blueskyFacets, escapeLinkedIn, linkedinVersion } from '../src/post.js';
import { encryptJson, decryptJson } from '../src/auth.js';
import { handle } from '../src/worker.js';
import { openD1 } from '../dev/d1-sqlite.js';

const jane = {
  name: 'Jane Doe',
  profiles: {
    bluesky: { handle: 'jane.bsky.social', platformId: 'did:plc:jane' },
    mastodon: { handle: 'jane@hachyderm.io' },
    x: { handle: 'janedoe' },
    linkedin: { handle: 'jane-doe-123', displayName: 'Jane Q. Doe' },
  },
};
const sam = { name: 'Sam', profiles: { x: { handle: 'sam' } } };

// ---------- Mentions ----------

test('render uses the right handle on each platform', () => {
  const text = 'Thanks @[Jane Doe]!';
  assert.equal(render(text, 'bluesky', [jane]).text, 'Thanks @jane.bsky.social!');
  assert.equal(render(text, 'mastodon', [jane]).text, 'Thanks @jane@hachyderm.io!');
  assert.equal(render(text, 'x', [jane]).text, 'Thanks @janedoe!');
  assert.equal(render(text, 'linkedin', [jane]).text, 'Thanks Jane Q. Doe!');
});

test('render falls back to the name when a profile is missing or the person is unknown', () => {
  const r = render('Hi @[sam] and @[Nobody]', 'bluesky', [sam]);
  assert.equal(r.text, 'Hi Sam and Nobody');
  assert.equal(r.mentions[0].person, sam);
  assert.equal(r.mentions[0].profile, null);
  assert.equal(r.mentions[1].person, null);
});

test('render reports mention offsets in the output text', () => {
  const r = render('@[Sam] and @[Jane Doe]', 'x', [jane, sam]);
  assert.deepEqual(r.mentions.map((m) => r.text.slice(m.start, m.end)), ['@sam', '@janedoe']);
  assert.deepEqual(mentionedNames('@[A] @[B] @[A]'), ['A', 'B']);
});

test('count follows each platform’s rules', () => {
  const url = 'https://example.com/' + 'a'.repeat(100);
  assert.equal(count('x', `see ${url}`), 4 + 23);
  assert.equal(count('mastodon', 'hi @jane@hachyderm.io'), 'hi @jane'.length);
  assert.equal(count('bluesky', '👨‍👩‍👧'), 1);
});

// ---------- Saved people ----------

test('people are stored with their profiles and can be updated and deleted', async () => {
  const db = openD1();
  const saved = await savePerson(db, jane);
  assert.equal(saved.profiles.bluesky.platformId, 'did:plc:jane');

  const updated = await savePerson(db, { id: saved.id, name: 'Jane D', profiles: { x: { handle: '@jd' } } });
  assert.deepEqual(Object.keys(updated.profiles), ['x']);
  assert.equal(updated.profiles.x.handle, 'jd');

  await assert.rejects(savePerson(db, { name: 'jane d', profiles: {} }), ValidationError);
  await assert.rejects(savePerson(db, { name: 'Bad]', profiles: {} }), ValidationError);
  await assert.rejects(savePerson(db, { name: 'Ok', profiles: { x: { handle: 'a b' } } }), ValidationError);
  await assert.rejects(savePerson(db, { id: 999, name: 'Ghost', profiles: {} }), ValidationError);
  assert.equal((await listPeople(db)).length, 1, 'failed saves leave nothing behind');

  assert.equal(await deletePerson(db, saved.id), true);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM profiles').first()).n, 0);
});

test('non-https avatar and profile links are dropped', async () => {
  const p = await savePerson(openD1(), { name: 'A', profiles: { x: { handle: 'a', url: 'javascript:alert(1)', avatar: 'http://x/y.png' } } });
  assert.equal(p.profiles.x.url, null);
  assert.equal(p.profiles.x.avatar, null);
});

// ---------- Finding profiles ----------

test('X handles and LinkedIn links are parsed', () => {
  assert.equal(parseXHandle('@jack'), 'jack');
  assert.equal(parseXHandle('https://twitter.com/jack'), 'jack');
  assert.equal(parseXHandle('x.com/jack?s=20'), 'jack');
  assert.equal(parseXHandle('Jane Doe'), null);
  assert.deepEqual(parseLinkedInUrl('https://uk.linkedin.com/in/jane-doe-123/?x=1'), {
    kind: 'in', slug: 'jane-doe-123', url: 'https://www.linkedin.com/in/jane-doe-123',
  });
  assert.equal(parseLinkedInUrl('https://www.linkedin.com/company/acme').kind, 'company');
  assert.equal(parseLinkedInUrl('jane doe'), null);
});

/** A pretend internet: routes are matched by URL prefix. Records every call. */
function fakeNet(routes) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    url = String(url);
    calls.push({ url, options });
    for (const [prefix, reply] of Object.entries(routes)) {
      if (!url.startsWith(prefix)) continue;
      const out = typeof reply === 'function' ? await reply(url, options) : reply;
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out ?? {}), { status: out === null ? 404 : 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fetch, calls, called: (prefix) => calls.filter((c) => c.url.startsWith(prefix)) };
}

test('resolve maps Bluesky and Mastodon results to candidates', async () => {
  const net = fakeNet({
    'https://public.api.bsky.app/': { actors: [{ did: 'did:plc:j', handle: 'jane.bsky.social', displayName: 'Jane' }] },
    'https://hachyderm.io/api/v1/accounts/lookup': { id: '9', acct: 'jane', username: 'jane', display_name: 'Jane', url: 'https://hachyderm.io/@jane' },
    'https://mastodon.social/api/v2/search': { accounts: [
      { id: '1', acct: 'local', username: 'local', display_name: '', url: 'https://mastodon.social/@local' },
      { id: '2', acct: 'far@other.example', username: 'far', display_name: 'Far', url: 'https://other.example/@far' },
    ] },
  });
  const ctx = { fetch: net.fetch, env: {}, accounts: {} };

  assert.deepEqual((await resolve('bluesky', '@jane', ctx))[0], {
    handle: 'jane.bsky.social', displayName: 'Jane', avatar: null,
    url: 'https://bsky.app/profile/jane.bsky.social', platformId: 'did:plc:j',
  });
  assert.equal((await resolve('mastodon', '@jane@hachyderm.io', ctx))[0].handle, 'jane@hachyderm.io');
  assert.deepEqual((await resolve('mastodon', 'someone', ctx)).map((c) => c.handle), ['local@mastodon.social', 'far@other.example']);
  assert.equal((await resolve('x', 'jack', ctx))[0].unverified, true);
  assert.deepEqual(await resolve('x', 'Jane Doe', ctx), []);
  assert.equal((await resolve('linkedin', 'linkedin.com/in/jane', ctx))[0].handle, 'jane');
});

// ---------- Posting helpers ----------

test('Bluesky facets use UTF-8 byte offsets', async () => {
  const rendered = render('Café ☕ with @[Jane Doe] https://example.com.', 'bluesky', [jane]);
  const facets = await blueskyFacets(rendered, async () => null);
  const bytes = Buffer.from(rendered.text);
  const slice = (f) => bytes.subarray(f.index.byteStart, f.index.byteEnd).toString();
  assert.equal(slice(facets[0]), '@jane.bsky.social');
  assert.equal(facets[0].features[0].did, 'did:plc:jane');
  assert.equal(slice(facets[1]), 'https://example.com');
});

test('LinkedIn text is escaped and the API version follows the calendar', () => {
  assert.equal(escapeLinkedIn('a (b) [c] #tag @x'), 'a \\(b\\) \\[c\\] #tag \\@x');
  assert.equal(linkedinVersion({}, new Date('2026-11-12T00:00:00Z')), '202609');
  assert.equal(linkedinVersion({}, new Date('2027-01-05T00:00:00Z')), '202611');
  assert.equal(linkedinVersion({ LINKEDIN_VERSION: '202601' }), '202601');
});

test('stored account data is encrypted and tied to the secret', async () => {
  const env = { SESSION_SECRET: 's1' };
  const sealed = await encryptJson(env, { token: 'hunter2' });
  assert.ok(!sealed.includes('hunter2'));
  assert.deepEqual(await decryptJson(env, sealed), { token: 'hunter2' });
  await assert.rejects(decryptJson({ SESSION_SECRET: 's2' }, sealed));
});

// ---------- The whole app, through its HTTP API ----------

const ORIGIN = 'https://post.example';

/** Pretend Google and GitHub. "who" decides which account signs in. */
const ssoRoutes = (who) => ({
  'https://oauth2.googleapis.com/token': { access_token: 'google-token' },
  'https://openidconnect.googleapis.com/v1/userinfo': () => ({ email: who.google, email_verified: who.googleVerified ?? true }),
  'https://github.com/login/oauth/access_token': { access_token: 'github-token' },
  'https://api.github.com/user/emails': () => who.github,
});

function client(routes = {}, extraEnv = {}) {
  const who = { google: 'Me@Example.com', github: [{ email: 'me@example.com', verified: true, primary: true }] };
  const net = fakeNet({ ...ssoRoutes(who), ...routes });
  const env = {
    DB: openD1(), SESSION_SECRET: 'test-secret', ALLOWED_EMAILS: 'me@example.com, partner@example.com',
    GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', GITHUB_CLIENT_ID: 'hid', GITHUB_CLIENT_SECRET: 'hsecret',
    ...extraEnv,
  };
  const jar = new Map();
  const call = async (method, path, body, { origin = ORIGIN, redirect = false } = {}) => {
    const headers = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (method !== 'GET') headers.Origin = origin;
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const res = await handle(new Request(ORIGIN + path, { method, headers, body }), env, net.fetch);
    for (const c of res.headers.getSetCookie()) {
      const [name, value] = c.split(';')[0].split('=');
      value ? jar.set(name, value) : jar.delete(name);
    }
    if (redirect) return res;
    return { status: res.status, body: await res.json() };
  };
  /** Goes to the provider and back. Returns where the app sends the browser. */
  const login = async (provider = 'google') => {
    const go = await call('GET', `/api/login/${provider}`, null, { redirect: true });
    const authorize = new URL(go.headers.get('Location'));
    assert.equal(authorize.searchParams.get('redirect_uri'), `${ORIGIN}/api/login/${provider}/callback`);
    const back = await call('GET', `/api/login/${provider}/callback?code=c&state=${authorize.searchParams.get('state')}`, null, { redirect: true });
    return back.headers.get('Location');
  };
  return { env, net, who, jar, call, login };
}

test('nothing works until you sign in with an allowed Google or GitHub account', async () => {
  for (const provider of ['google', 'github']) {
    const app = client();
    assert.equal((await app.call('GET', '/api/people')).status, 401);
    assert.deepEqual((await app.call('GET', '/api/me')).body, { loggedIn: false, email: null, providers: ['google', 'github'] });

    assert.equal(await app.login(provider), '/');
    assert.equal((await app.call('GET', '/api/me')).body.email, 'me@example.com');
    assert.equal((await app.call('GET', '/api/people')).status, 200);
    assert.equal((await app.call('POST', '/api/people', jane, { origin: 'https://evil.example' })).status, 403);

    assert.equal((await app.call('POST', '/api/logout', {})).status, 200);
    assert.equal((await app.call('GET', '/api/people')).status, 401);
  }
});

test('accounts that are not on the list are turned away', async () => {
  const app = client();
  app.who.google = 'stranger@example.com';
  assert.match(await app.login('google'), /login_error=stranger%40example.com%20is%20not%20allowed/);

  app.who.google = 'me@example.com';
  app.who.googleVerified = false;
  assert.match(await app.login('google'), /login_error/, 'unverified Google email');

  app.who.github = [{ email: 'me@example.com', verified: false }, { email: 'other@example.com', verified: true }];
  assert.match(await app.login('github'), /login_error/, 'unverified GitHub email does not count');
  assert.equal((await app.call('GET', '/api/people')).status, 401);

  app.who.github = [{ email: 'other@example.com', verified: true }, { email: 'Partner@Example.com', verified: true }];
  assert.equal(await app.login('github'), '/', 'any verified address on the list is enough');
});

test('sign-in cannot be forged, replayed across browsers, or outlive the allow list', async () => {
  const app = client();
  // A callback without the matching state cookie (a link crafted by someone else).
  const forged = await app.call('GET', '/api/login/google/callback?code=c&state=made-up', null, { redirect: true });
  assert.match(forged.headers.get('Location'), /login_error/);

  const get = (cookie) => handle(new Request(ORIGIN + '/api/people', { headers: { Cookie: cookie } }), app.env, app.net.fetch);
  assert.equal((await get('mp_session=bWVAZXhhbXBsZS5jb20.9999999999999.forged')).status, 401);

  await app.login();
  const cookie = `mp_session=${app.jar.get('mp_session')}`;
  assert.equal((await get(cookie)).status, 200);
  app.env.ALLOWED_EMAILS = 'partner@example.com';
  assert.equal((await get(cookie)).status, 401, 'removed from the list means locked out');

  // Only configured providers are offered.
  const googleOnly = client({}, { GITHUB_CLIENT_ID: '' });
  assert.deepEqual((await googleOnly.call('GET', '/api/me')).body.providers, ['google']);
  assert.equal((await googleOnly.call('GET', '/api/login/github')).status, 404);
});

test('the app refuses to run without its settings', async () => {
  const res = await handle(new Request(ORIGIN + '/api/me'), { DB: openD1(), SESSION_SECRET: 's', GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' });
  assert.equal(res.status, 503, 'no ALLOWED_EMAILS');
});

function postForm({ text, platforms, images = [] }) {
  const form = new FormData();
  form.set('text', text);
  form.set('platforms', JSON.stringify(platforms));
  form.set('imageMeta', JSON.stringify(images.map((i) => ({ alt: i.alt, width: 4, height: 3 }))));
  for (const i of images) form.append('images', new Blob([i.bytes], { type: i.type || 'image/png' }), 'image');
  return form;
}

test('unconnected platforms return a composer link with the right handle', async () => {
  const app = client();
  await app.login();
  await app.call('POST', '/api/people', jane);
  const { body } = await app.call('POST', '/api/post', postForm({ text: 'Hi @[Jane Doe]', platforms: ['x', 'mastodon'] }));
  assert.equal(body.x.status, 'manual');
  assert.equal(body.x.url, 'https://x.com/intent/post?text=Hi%20%40janedoe');
  assert.equal(body.mastodon.text, 'Hi @jane@hachyderm.io');

  const long = await app.call('POST', '/api/post', postForm({ text: 'a'.repeat(281), platforms: ['x'] }));
  assert.equal(long.status, 400);
  const badImage = await app.call('POST', '/api/post', postForm({ text: 'x', platforms: ['x'], images: [{ bytes: 'x', type: 'image/svg+xml' }] }));
  assert.equal(badImage.status, 400);
});

test('connect all four accounts, then post text, mentions and an image to each', async () => {
  const sent = {};
  const routes = {
    // Bluesky
    'https://bsky.social/xrpc/com.atproto.server.createSession': { did: 'did:plc:me', handle: 'me.bsky.social', accessJwt: 'bsky-jwt' },
    'https://bsky.social/xrpc/com.atproto.repo.uploadBlob': { blob: { $type: 'blob', ref: { $link: 'cid1' }, mimeType: 'image/png', size: 3 } },
    'https://bsky.social/xrpc/com.atproto.repo.createRecord': (u, o) => { sent.bluesky = JSON.parse(o.body); return { uri: 'at://did:plc:me/app.bsky.feed.post/abc' }; },
    // Mastodon
    'https://example.social/api/v1/accounts/verify_credentials': { username: 'me' },
    'https://example.social/api/v2/media': (u, o) => { sent.mastodonAlt = o.body.get('description'); return new Response('{"id":"m1"}', { status: 202 }); },
    'https://example.social/api/v1/media/m1': { id: 'm1' },
    'https://example.social/api/v1/statuses': (u, o) => { sent.mastodon = JSON.parse(o.body); return { url: 'https://example.social/@me/1' }; },
    // X
    'https://api.x.com/2/oauth2/token': (u, o) => {
      sent.xToken = Object.fromEntries(o.body);
      return { access_token: 'x-access', refresh_token: 'x-refresh', expires_in: 7200 };
    },
    'https://api.x.com/2/users/me': { data: { id: '1', username: 'me_on_x' } },
    'https://api.x.com/2/media/upload': (u, o) => { sent.xCategory = o.body.get('media_category'); return { data: { id: 'xm1' } }; },
    'https://api.x.com/2/media/metadata': {},
    'https://api.x.com/2/tweets': (u, o) => { sent.x = JSON.parse(o.body); return { data: { id: '99' } }; },
    // LinkedIn
    'https://www.linkedin.com/oauth/v2/accessToken': { access_token: 'li-access', expires_in: 5184000 },
    'https://api.linkedin.com/v2/userinfo': { sub: 'abc123', name: 'Me Myself' },
    'https://api.linkedin.com/rest/images?action=initializeUpload': { value: { uploadUrl: 'https://www.linkedin.com/dms-uploads/1', image: 'urn:li:image:1' } },
    'https://www.linkedin.com/dms-uploads/1': (u, o) => { sent.linkedinUpload = o.method; return {}; },
    'https://api.linkedin.com/rest/posts': (u, o) => {
      sent.linkedin = JSON.parse(o.body);
      sent.linkedinHeaders = o.headers;
      return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:7' } });
    },
  };
  const app = client(routes, { X_CLIENT_ID: 'xid', X_CLIENT_SECRET: 'xsecret', LINKEDIN_CLIENT_ID: 'lid', LINKEDIN_CLIENT_SECRET: 'lsecret' });
  await app.login();

  // Connect with pasted credentials.
  assert.equal((await app.call('POST', '/api/accounts/bluesky', { handle: '@me.bsky.social', appPassword: 'abcd-efgh' })).status, 200);
  assert.equal((await app.call('POST', '/api/accounts/mastodon', { instance: 'https://Example.social/', token: 'masto-token' })).status, 200);

  // Connect with a redirect to the platform and back.
  for (const platform of ['x', 'linkedin']) {
    const go = await app.call('GET', `/api/connect/${platform}`, null, { redirect: true });
    const authorize = new URL(go.headers.get('Location'));
    assert.equal(authorize.searchParams.get('redirect_uri'), `${ORIGIN}/api/callback/${platform}`);
    const state = authorize.searchParams.get('state');
    const back = await app.call('GET', `/api/callback/${platform}?code=the-code&state=${state}`, null, { redirect: true });
    assert.equal(back.headers.get('Location'), `/?connected=${platform}`);
    // The same link cannot be used twice.
    const again = await app.call('GET', `/api/callback/${platform}?code=the-code&state=${state}`, null, { redirect: true });
    assert.match(again.headers.get('Location'), /connect_error/);
  }
  assert.ok(sent.xToken.code_verifier, 'X uses PKCE');

  const { body: config } = await app.call('GET', '/api/config');
  assert.deepEqual(Object.fromEntries(Object.entries(config.accounts).map(([p, a]) => [p, a.label])), {
    bluesky: '@me.bsky.social', linkedin: 'Me Myself', mastodon: '@me@example.social', x: '@me_on_x',
  });
  assert.ok(!JSON.stringify(config).includes('token'), 'no secrets reach the page');
  const stored = await app.env.DB.prepare('SELECT data FROM accounts').all();
  assert.ok(stored.results.every((r) => !/masto-token|abcd-efgh|x-access|li-access/.test(r.data)), 'tokens are encrypted at rest');

  // Post.
  await app.call('POST', '/api/people', jane);
  const { status, body } = await app.call('POST', '/api/post', postForm({
    text: 'Thanks @[Jane Doe] (great talk)',
    platforms: ['bluesky', 'linkedin', 'mastodon', 'x'],
    images: [{ bytes: 'png', alt: 'A slide' }],
  }));
  assert.equal(status, 200);
  assert.deepEqual(Object.fromEntries(Object.entries(body).map(([p, r]) => [p, r.error || r.url])), {
    bluesky: 'https://bsky.app/profile/me.bsky.social/post/abc',
    linkedin: 'https://www.linkedin.com/feed/update/urn:li:share:7/',
    mastodon: 'https://example.social/@me/1',
    x: 'https://x.com/me_on_x/status/99',
  });

  const record = sent.bluesky.record;
  assert.equal(record.text, 'Thanks @jane.bsky.social (great talk)');
  assert.equal(record.facets[0].features[0].did, 'did:plc:jane');
  assert.equal(record.embed.images[0].alt, 'A slide');
  assert.deepEqual(record.embed.images[0].aspectRatio, { width: 4, height: 3 });

  assert.deepEqual(sent.mastodon, { status: 'Thanks @jane@hachyderm.io (great talk)', media_ids: ['m1'] });
  assert.equal(sent.mastodonAlt, 'A slide');
  assert.equal(app.net.called('https://example.social/api/v1/media/m1').length, 1, 'waited for the image to finish processing');

  assert.deepEqual(sent.x, { text: 'Thanks @janedoe (great talk)', media: { media_ids: ['xm1'] } });
  assert.equal(sent.xCategory, 'tweet_image');

  assert.equal(sent.linkedin.author, 'urn:li:person:abc123');
  assert.equal(sent.linkedin.commentary, 'Thanks Jane Q. Doe \\(great talk\\)');
  assert.deepEqual(sent.linkedin.content, { media: { id: 'urn:li:image:1', altText: 'A slide' } });
  assert.equal(sent.linkedinUpload, 'PUT');
  assert.match(sent.linkedinHeaders['LinkedIn-Version'], /^\d{6}$/);

  // Disconnecting goes back to the composer link.
  await app.call('DELETE', '/api/accounts/x', {});
  const after = await app.call('POST', '/api/post', postForm({ text: 'hello', platforms: ['x'] }));
  assert.equal(after.body.x.status, 'manual');
});

test('an expired X token is refreshed before posting, and one failure does not stop the others', async () => {
  let refreshed = 0;
  const app = client({
    'https://api.x.com/2/oauth2/token': (u, o) => {
      if (o.body.get('grant_type') === 'refresh_token') refreshed++;
      return { access_token: `x-access-${refreshed}`, refresh_token: 'x-refresh-2', expires_in: refreshed ? 7200 : 0 };
    },
    'https://api.x.com/2/users/me': { data: { id: '1', username: 'me_on_x' } },
    'https://api.x.com/2/tweets': (u, o) => new Response(JSON.stringify({ data: { id: '5' }, auth: o.headers.Authorization })),
    'https://example.social/api/v1/accounts/verify_credentials': { username: 'me' },
    'https://example.social/api/v1/statuses': () => new Response('{"error":"Validation failed"}', { status: 422 }),
  }, { X_CLIENT_ID: 'xid' });
  await app.login();
  await app.call('POST', '/api/accounts/mastodon', { instance: 'example.social', token: 't' });
  const go = await app.call('GET', '/api/connect/x', null, { redirect: true });
  const state = new URL(go.headers.get('Location')).searchParams.get('state');
  await app.call('GET', `/api/callback/x?code=c&state=${state}`, null, { redirect: true });

  const { body } = await app.call('POST', '/api/post', postForm({ text: 'hello', platforms: ['x', 'mastodon'] }));
  assert.equal(refreshed, 1);
  assert.equal(app.net.called('https://api.x.com/2/tweets')[0].options.headers.Authorization, 'Bearer x-access-1');
  assert.equal(body.x.status, 'posted');
  assert.equal(body.mastodon.status, 'error');
  assert.match(body.mastodon.error, /Validation failed/);

  await app.call('POST', '/api/post', postForm({ text: 'again', platforms: ['x'] }));
  assert.equal(refreshed, 1, 'the new token was saved');
});

test('attaching an image can suggest alt text, using Claude', async () => {
  const sent = [];
  const reply = (stop = 'end_turn', text = '"A dalek dancing under coloured lights at a festival."') => (url, options) => {
    sent.push({ url, headers: new Headers(options.headers), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: stop, stop_sequence: null,
      content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const image = () => {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: 'image/jpeg' }), 'a.jpg');
    form.append('text', 'Look who I met at #emf2026');
    return form;
  };

  // Not set up: the page is told, and the address says so
  const plain = client();
  await plain.login();
  assert.equal((await plain.call('GET', '/api/config')).body.altText, false);
  assert.equal((await plain.call('POST', '/api/alt-text', image())).status, 503);

  const app = client({ 'https://api.anthropic.com/v1/messages': reply() }, { ANTHROPIC_API_KEY: 'sk-ant-test' });
  assert.equal((await app.call('POST', '/api/alt-text', image())).status, 401, 'needs a login');
  await app.login();
  assert.equal((await app.call('GET', '/api/config')).body.altText, true);
  const res = await app.call('POST', '/api/alt-text', image());
  assert.equal(res.status, 200);
  assert.equal(res.body.alt, 'A dalek dancing under coloured lights at a festival.', 'quotes are tidied away');

  const req = sent[0];
  assert.equal(req.headers.get('authorization'), 'Bearer sk-ant-test');
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.fallbacks, 'default');
  const [img, text] = req.body.messages[0].content;
  assert.equal(img.type, 'image');
  assert.equal(img.source.media_type, 'image/jpeg');
  assert.equal(img.source.data, btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3)));
  assert.match(text.text, /#emf2026/, 'the post text is sent as context');

  // Only images, and not cross-site
  const notImage = new FormData();
  notImage.append('image', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
  assert.equal((await app.call('POST', '/api/alt-text', notImage)).status, 400);
  assert.equal((await app.call('POST', '/api/alt-text', image(), { origin: 'https://evil.example' })).status, 403);

  // If Claude declines, the page gets a clear message
  const declined = client({ 'https://api.anthropic.com/v1/messages': reply('refusal', '') }, { ANTHROPIC_API_KEY: 'sk-ant-test' });
  await declined.login();
  const no = await declined.call('POST', '/api/alt-text', image());
  assert.equal(no.status, 422);
  assert.equal(no.body.error, 'Could not describe this image');
});
