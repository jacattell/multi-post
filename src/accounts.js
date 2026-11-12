// Your own connected accounts: how they are stored, and how each one
// is connected (pasted credentials for Bluesky and Mastodon, an OAuth
// redirect for X and LinkedIn).

import { ValidationError } from './db.js';
import { encryptJson, decryptJson, randomToken, sha256, b64url } from './auth.js';

const TIMEOUT_MS = 15000;

export async function getAccounts(ctx) {
  const rows = await ctx.db.prepare('SELECT platform, data FROM accounts').all();
  const out = {};
  for (const r of rows.results) {
    // A row that no longer decrypts (changed SESSION_SECRET) counts as not connected.
    try { out[r.platform] = await decryptJson(ctx.env, r.data); } catch { /* skip */ }
  }
  return out;
}

export async function setAccount(ctx, platform, data) {
  await ctx.db.prepare(
    'INSERT INTO accounts (platform, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ' +
    'ON CONFLICT (platform) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
  ).bind(platform, await encryptJson(ctx.env, data)).run();
}

export async function deleteAccount(ctx, platform) {
  await ctx.db.prepare('DELETE FROM accounts WHERE platform = ?').bind(platform).run();
}

/** What the page is allowed to know about each account. No secrets. */
export function publicAccounts(accounts, env) {
  const canConnect = {
    bluesky: true,
    mastodon: true,
    x: Boolean(env.X_CLIENT_ID),
    linkedin: Boolean(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET),
  };
  const out = {};
  for (const platform of Object.keys(canConnect)) {
    const a = accounts[platform];
    out[platform] = {
      connected: Boolean(a),
      label: a?.label || null,
      expiresAt: platform === 'linkedin' ? a?.expiresAt || null : null,
      canConnect: canConnect[platform],
    };
  }
  return out;
}

async function readJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data.error_description || data.message || data.detail || data.error || `status ${res.status}`;
    throw new Error(typeof reason === 'string' ? reason : JSON.stringify(reason));
  }
  return data;
}

// ---------- Bluesky: handle + app password ----------

export async function connectBluesky(ctx, { handle, appPassword }) {
  const identifier = String(handle || '').trim().replace(/^@/, '');
  const password = String(appPassword || '').trim();
  if (!identifier || !password) throw new ValidationError('Enter your handle and an app password');
  const pds = 'https://bsky.social';
  let session;
  try {
    session = await readJson(await ctx.fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }));
  } catch (err) {
    throw new ValidationError(`Bluesky did not accept that: ${err.message}`);
  }
  await setAccount(ctx, 'bluesky', { pds, identifier, password, did: session.did, label: `@${session.handle}` });
}

// ---------- Mastodon: server + access token ----------

export function cleanInstance(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) throw new ValidationError('Enter your Mastodon server, like mastodon.social');
  return `https://${host}`;
}

export async function connectMastodon(ctx, { instance, token }) {
  const base = cleanInstance(instance);
  const accessToken = String(token || '').trim();
  if (!accessToken) throw new ValidationError('Enter an access token');
  let me;
  try {
    me = await readJson(await ctx.fetch(`${base}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }));
  } catch (err) {
    throw new ValidationError(`${new URL(base).host} did not accept that token: ${err.message}`);
  }
  await setAccount(ctx, 'mastodon', { instance: base, token: accessToken, label: `@${me.username}@${new URL(base).host}` });
}

// ---------- X and LinkedIn: OAuth redirects ----------

const OAUTH = {
  x: {
    authorize: 'https://x.com/i/oauth2/authorize',
    token: 'https://api.x.com/2/oauth2/token',
    scope: 'tweet.read tweet.write users.read media.write offline.access',
    client: (env) => ({ id: env.X_CLIENT_ID, secret: env.X_CLIENT_SECRET }),
  },
  linkedin: {
    authorize: 'https://www.linkedin.com/oauth/v2/authorization',
    token: 'https://www.linkedin.com/oauth/v2/accessToken',
    scope: 'openid profile w_member_social',
    client: (env) => ({ id: env.LINKEDIN_CLIENT_ID, secret: env.LINKEDIN_CLIENT_SECRET }),
  },
};

const STATE_TTL_MS = 10 * 60_000;
const callbackUrl = (origin, platform) => `${origin}/api/callback/${platform}`;

/** @returns the URL to send the browser to. */
export async function startOAuth(ctx, platform, origin) {
  const cfg = OAUTH[platform];
  const client = cfg.client(ctx.env);
  if (!client.id) throw new ValidationError(`${platform} is not set up yet. See the README.`);
  const state = randomToken(24);
  const verifier = randomToken(48);
  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM oauth_states WHERE created_at < ?').bind(Date.now() - STATE_TTL_MS),
    ctx.db.prepare('INSERT INTO oauth_states (state, platform, verifier, created_at) VALUES (?, ?, ?, ?)')
      .bind(state, platform, verifier, Date.now()),
  ]);
  const url = new URL(cfg.authorize);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.id);
  url.searchParams.set('redirect_uri', callbackUrl(origin, platform));
  url.searchParams.set('scope', cfg.scope);
  url.searchParams.set('state', state);
  if (platform === 'x') {
    url.searchParams.set('code_challenge', b64url(await sha256(verifier)));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.href;
}

async function tokenRequest(ctx, platform, params) {
  const cfg = OAUTH[platform];
  const client = cfg.client(ctx.env);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams({ ...params, client_id: client.id });
  if (platform === 'x' && client.secret) {
    headers.Authorization = `Basic ${btoa(`${client.id}:${client.secret}`)}`;
  } else if (client.secret) {
    body.set('client_secret', client.secret);
  }
  return readJson(await ctx.fetch(cfg.token, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) }));
}

export async function finishOAuth(ctx, platform, params, origin) {
  if (params.get('error')) throw new ValidationError(params.get('error_description') || params.get('error'));
  const row = await ctx.db.prepare('SELECT * FROM oauth_states WHERE state = ? AND platform = ?')
    .bind(params.get('state') || '', platform).first();
  await ctx.db.prepare('DELETE FROM oauth_states WHERE state = ?').bind(params.get('state') || '').run();
  if (!row || row.created_at < Date.now() - STATE_TTL_MS) throw new ValidationError('That sign-in link expired. Try again.');

  const tokens = await tokenRequest(ctx, platform, {
    grant_type: 'authorization_code',
    code: params.get('code') || '',
    redirect_uri: callbackUrl(origin, platform),
    ...(platform === 'x' ? { code_verifier: row.verifier } : {}),
  });
  const auth = { Authorization: `Bearer ${tokens.access_token}` };
  const expiresAt = Date.now() + (tokens.expires_in || 0) * 1000;

  if (platform === 'x') {
    const me = await readJson(await ctx.fetch('https://api.x.com/2/users/me', { headers: auth, signal: AbortSignal.timeout(TIMEOUT_MS) }));
    await setAccount(ctx, 'x', {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresAt,
      username: me.data.username,
      label: `@${me.data.username}`,
    });
  } else {
    const me = await readJson(await ctx.fetch('https://api.linkedin.com/v2/userinfo', { headers: auth, signal: AbortSignal.timeout(TIMEOUT_MS) }));
    await setAccount(ctx, 'linkedin', {
      accessToken: tokens.access_token,
      expiresAt,
      author: `urn:li:person:${me.sub}`,
      label: me.name || 'Connected',
    });
  }
}

/** A working X access token. X tokens last two hours, so refresh when near expiry. */
export async function xAccessToken(ctx, account) {
  if (account.expiresAt - Date.now() > 60_000) return account.accessToken;
  if (!account.refreshToken) throw new Error('X sign-in expired. Reconnect X.');
  let tokens;
  try {
    tokens = await tokenRequest(ctx, 'x', { grant_type: 'refresh_token', refresh_token: account.refreshToken });
  } catch (err) {
    throw new Error(`X sign-in expired (${err.message}). Reconnect X.`);
  }
  Object.assign(account, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || account.refreshToken,
    expiresAt: Date.now() + (tokens.expires_in || 0) * 1000,
  });
  await setAccount(ctx, 'x', account);
  return account.accessToken;
}
