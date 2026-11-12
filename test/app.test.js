import test from 'node:test';
import assert from 'node:assert/strict';

import { render, count, mentionedNames } from '../lib/render.js';
import { openDb, savePerson, listPeople, deletePerson, ValidationError } from '../lib/db.js';
import { resolve, parseXHandle, parseLinkedInUrl } from '../lib/resolve.js';
import { blueskyFacets, publish } from '../lib/post.js';
import { createApp } from '../server.js';

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
});

test('mentionedNames lists each name once', () => {
  assert.deepEqual(mentionedNames('@[A] @[B] @[A]'), ['A', 'B']);
});

test('count follows each platform’s rules', () => {
  const url = 'https://example.com/' + 'a'.repeat(100);
  assert.equal(count('x', `see ${url}`), 4 + 23);
  assert.equal(count('mastodon', 'hi @jane@hachyderm.io'), 'hi @jane'.length);
  assert.equal(count('bluesky', '👨‍👩‍👧'), 1);
});

test('people are stored with their profiles and can be updated and deleted', () => {
  const db = openDb();
  const saved = savePerson(db, jane);
  assert.equal(saved.profiles.bluesky.platformId, 'did:plc:jane');
  assert.equal(listPeople(db).length, 1);

  const updated = savePerson(db, { id: saved.id, name: 'Jane D', profiles: { x: { handle: '@jd' } } });
  assert.deepEqual(Object.keys(updated.profiles), ['x']);
  assert.equal(updated.profiles.x.handle, 'jd');

  assert.throws(() => savePerson(db, { name: 'jane d', profiles: {} }), ValidationError);
  assert.throws(() => savePerson(db, { name: 'Bad]', profiles: {} }), ValidationError);
  assert.throws(() => savePerson(db, { name: 'Ok', profiles: { x: { handle: 'a b' } } }), ValidationError);
  assert.equal(listPeople(db).length, 1, 'failed saves leave nothing behind');

  assert.equal(deletePerson(db, saved.id), true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM profiles').get().n, 0);
});

test('non-https avatar and profile links are dropped', () => {
  const db = openDb();
  const p = savePerson(db, { name: 'A', profiles: { x: { handle: 'a', url: 'javascript:alert(1)', avatar: 'http://x/y.png' } } });
  assert.equal(p.profiles.x.url, null);
  assert.equal(p.profiles.x.avatar, null);
});

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

const fakeFetch = (routes) => async (url, options) => {
  for (const [prefix, reply] of Object.entries(routes)) {
    if (String(url).startsWith(prefix)) {
      const body = typeof reply === 'function' ? reply(String(url), options) : reply;
      return { ok: body !== null, status: body === null ? 404 : 200, json: async () => body };
    }
  }
  throw new Error(`unexpected fetch: ${url}`);
};

test('resolve maps Bluesky and Mastodon results to candidates', async () => {
  const fetch = fakeFetch({
    'https://public.api.bsky.app/': { actors: [{ did: 'did:plc:j', handle: 'jane.bsky.social', displayName: 'Jane' }] },
    'https://hachyderm.io/api/v1/accounts/lookup': { id: '9', acct: 'jane', username: 'jane', display_name: 'Jane', url: 'https://hachyderm.io/@jane' },
    'https://mastodon.social/api/v2/search': { accounts: [
      { id: '1', acct: 'local', username: 'local', display_name: '', url: 'https://mastodon.social/@local' },
      { id: '2', acct: 'far@other.example', username: 'far', display_name: 'Far', url: 'https://other.example/@far' },
    ] },
  });
  const ctx = { fetch, env: {} };

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

test('Bluesky facets use UTF-8 byte offsets', async () => {
  const rendered = render('Café ☕ with @[Jane Doe] https://example.com.', 'bluesky', [jane]);
  const facets = await blueskyFacets(rendered, async () => null);
  const bytes = Buffer.from(rendered.text);
  const slice = (f) => bytes.subarray(f.index.byteStart, f.index.byteEnd).toString();
  assert.equal(slice(facets[0]), '@jane.bsky.social');
  assert.equal(facets[0].features[0].did, 'did:plc:jane');
  assert.equal(slice(facets[1]), 'https://example.com');
});

test('publish posts through the API when connected, otherwise returns a composer link', async () => {
  const sent = [];
  const fetch = fakeFetch({
    'https://bsky.social/xrpc/com.atproto.server.createSession': { did: 'did:plc:me', handle: 'me.bsky.social', accessJwt: 't' },
    'https://bsky.social/xrpc/com.atproto.repo.createRecord': (url, o) => { sent.push(JSON.parse(o.body)); return { uri: 'at://did:plc:me/app.bsky.feed.post/abc' }; },
  });
  const rendered = render('Hi @[Jane Doe]', 'bluesky', [jane]);
  const posted = await publish('bluesky', rendered, { fetch, env: { BLUESKY_HANDLE: 'me', BLUESKY_APP_PASSWORD: 'p' } });
  assert.deepEqual(posted, { status: 'posted', text: 'Hi @jane.bsky.social', url: 'https://bsky.app/profile/me.bsky.social/post/abc' });
  assert.equal(sent[0].record.facets[0].features[0].did, 'did:plc:jane');

  const manual = await publish('x', render('Hi @[Jane Doe]', 'x', [jane]), { fetch, env: {} });
  assert.equal(manual.status, 'manual');
  assert.equal(manual.url, 'https://x.com/intent/post?text=Hi%20%40janedoe');
});

test('HTTP API: save a person, post, and reject unsafe requests', async (t) => {
  const server = createApp({ db: openDb(), fetch: fakeFetch({}), env: {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = (body, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  let res = await fetch(`${base}/api/people`, json(jane));
  assert.equal(res.status, 201);
  const { id } = await res.json();

  res = await fetch(`${base}/api/people`, json(jane));
  assert.equal(res.status, 400, 'duplicate name');

  res = await fetch(`${base}/api/post`, json({ text: 'Hi @[Jane Doe]', platforms: ['x', 'mastodon'] }));
  const out = await res.json();
  assert.equal(out.x.text, 'Hi @janedoe');
  assert.equal(out.mastodon.text, 'Hi @jane@hachyderm.io');

  res = await fetch(`${base}/api/post`, json({ text: 'a'.repeat(281), platforms: ['x'] }));
  assert.equal(res.status, 400, 'too long');

  res = await fetch(`${base}/api/post`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 415, 'cross-site form posts are refused');

  res = await fetch(`${base}/api/people/${id}`, json({}, 'DELETE'));
  assert.equal(res.status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/people`)).json(), []);

  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/../server.js`)).status, 404);
});
