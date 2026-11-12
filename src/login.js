// Sign in with Google or GitHub. Only the email addresses listed in
// ALLOWED_EMAILS get in.

import { randomToken, signedCookie, readSignedCookie, expiredCookie } from './auth.js';

const TIMEOUT_MS = 10000;
const STATE_COOKIE = 'mp_login';
const STATE_SECONDS = 600;

const PROVIDERS = {
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email',
    client: (env) => ({ id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET }),
    async emails(ctx, accessToken) {
      const me = await getJson(ctx, 'https://openidconnect.googleapis.com/v1/userinfo', accessToken);
      return me.email && me.email_verified ? [me.email] : [];
    },
  },
  github: {
    label: 'GitHub',
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    scope: 'user:email',
    client: (env) => ({ id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET }),
    async emails(ctx, accessToken) {
      const list = await getJson(ctx, 'https://api.github.com/user/emails', accessToken);
      return (Array.isArray(list) ? list : []).filter((e) => e.verified).map((e) => e.email);
    },
  },
};

async function getJson(ctx, url, accessToken) {
  const res = await ctx.fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'multi-post' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return res.json();
}

export function allowedEmails(env) {
  return String(env.ALLOWED_EMAILS || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
}

/** Which sign-in buttons to show. */
export function loginProviders(env) {
  return Object.keys(PROVIDERS).filter((p) => {
    const c = PROVIDERS[p].client(env);
    return c.id && c.secret;
  });
}

export const isProvider = (name) => Object.hasOwn(PROVIDERS, name);
const callbackUrl = (origin, provider) => `${origin}/api/login/${provider}/callback`;

/** @returns { location, cookie } to send the browser to the provider. */
export async function startLogin(ctx, provider, origin, secure) {
  const cfg = PROVIDERS[provider];
  const state = randomToken(24);
  const url = new URL(cfg.authorize);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.client(ctx.env).id);
  url.searchParams.set('redirect_uri', callbackUrl(origin, provider));
  url.searchParams.set('scope', cfg.scope);
  url.searchParams.set('state', state);
  return {
    location: url.href,
    // The state lives in a signed cookie, so nothing is stored before login.
    cookie: await signedCookie(ctx.env, STATE_COOKIE, `${provider}:${state}`, STATE_SECONDS, secure),
  };
}

export const clearLoginState = (secure) => expiredCookie(STATE_COOKIE, secure);

/** @returns the allowed email that signed in. Throws a readable Error otherwise. */
export async function finishLogin(ctx, provider, request, params, origin) {
  const cfg = PROVIDERS[provider];
  if (params.get('error')) throw new Error(params.get('error_description') || params.get('error'));
  const expected = await readSignedCookie(ctx.env, request, STATE_COOKIE);
  if (!expected || expected !== `${provider}:${params.get('state')}`) throw new Error('That sign-in link expired. Try again.');

  const client = cfg.client(ctx.env);
  const res = await ctx.fetch(cfg.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.get('code') || '',
      redirect_uri: callbackUrl(origin, provider),
      client_id: client.id,
      client_secret: client.secret,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const tokens = await res.json().catch(() => ({}));
  if (!res.ok || !tokens.access_token) throw new Error(tokens.error_description || `${cfg.label} sign-in failed`);

  const allowed = allowedEmails(ctx.env);
  const emails = (await cfg.emails(ctx, tokens.access_token)).map((e) => e.toLowerCase());
  const match = emails.find((e) => allowed.includes(e));
  if (!match) throw new Error(`${emails[0] || `That ${cfg.label} account`} is not allowed to use this app.`);
  return match;
}
