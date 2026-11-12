# multi-post

Write a post once, then send it to Bluesky, LinkedIn, Mastodon and X.

- **@mentions that work everywhere.** Type `@`, find the person on each
  platform once, and their profiles are saved. Next time, `@` plus a few
  letters is enough.
- **Images.** Up to 4 per post, each with alt text.
- **Direct posting** to all four platforms, once you connect your accounts.
- **Hosted on Cloudflare** (free plan), behind a password.

It is built for one person: you.

## Deploy to Cloudflare

You need Node.js 22.13 or newer and a Cloudflare account.

1. Install the tools and sign in:

   ```bash
   npm install
   ```

   ```bash
   npx wrangler login
   ```

2. Create the database. Copy the `database_id` it prints into `wrangler.jsonc`.

   ```bash
   npx wrangler d1 create multi-post
   ```

3. Set your login password, and a long random secret (for example the output
   of `openssl rand -hex 32`). The secret signs your login and encrypts the
   account tokens the app stores.

   ```bash
   npx wrangler secret put APP_PASSWORD
   ```

   ```bash
   npx wrangler secret put SESSION_SECRET
   ```

4. Deploy. This also creates the database tables.

   ```bash
   npm run deploy
   ```

Wrangler prints the address, like `https://multi-post.<you>.workers.dev`.

**Your own domain:** in `wrangler.jsonc`, uncomment the `routes` line, set the
name you want (for example `post.cattell.com`), and deploy again. The domain
must already be on your Cloudflare account.

## Connect your accounts

Open the app, log in, and use **Your accounts**. A platform that is not
connected still works: you get a **Copy text and open** link to its own
composer.

### Bluesky

Click **Connect** and enter your handle and an *app password* (Bluesky →
Settings → Privacy and security → App passwords).

### Mastodon

On your server: Preferences → Development → New application. Tick
`write:statuses`, `write:media` and `read:search`. Click **Connect** and paste
the server name and the access token.

### X

X charges for API use. Check their current pricing first.

1. At [developer.x.com](https://developer.x.com), create a project and app.
2. Under **User authentication settings**: enable OAuth 2.0, type **Web App**,
   permissions **Read and write**.
3. Set the callback URL to `https://YOUR-APP-ADDRESS/api/callback/x`.
4. Save the client ID and secret, then deploy again:

   ```bash
   npx wrangler secret put X_CLIENT_ID
   ```

   ```bash
   npx wrangler secret put X_CLIENT_SECRET
   ```

5. In the app, click **Connect** next to X.

### LinkedIn

1. At [linkedin.com/developers](https://www.linkedin.com/developers/), create
   an app. LinkedIn asks you to link it to a company page.
2. On the **Products** tab, add **Share on LinkedIn** and **Sign In with
   LinkedIn using OpenID Connect**.
3. On the **Auth** tab, add the redirect URL
   `https://YOUR-APP-ADDRESS/api/callback/linkedin`.
4. Save the client ID and secret:

   ```bash
   npx wrangler secret put LINKEDIN_CLIENT_ID
   ```

   ```bash
   npx wrangler secret put LINKEDIN_CLIENT_SECRET
   ```

5. In the app, click **Connect** next to LinkedIn. LinkedIn sign-ins last
   about 60 days; the app shows how long is left.

## How mentions work

1. Type `@` and a name in the post box.
2. Pick a saved person, or choose **Find "name" on all platforms…**
3. Pick their profile on each platform (skip any they are not on) and save.
4. The draft shows `@[Jane Doe]`. The preview shows what each platform gets:

| Platform | Becomes | How the profile is found |
| --- | --- | --- |
| Bluesky | `@jane.bsky.social` (a real, linked mention) | Live search by name or handle |
| Mastodon | `@jane@server.social` | Live search, or exact lookup of `user@server` |
| X | `@janedoe` | You type the handle. It is checked when X is connected |
| LinkedIn | `Jane Doe` (plain name) | You paste the profile link |

If someone has no profile on a platform, their plain name is used there.

## Limits to know about

- **LinkedIn mentions are plain text.** LinkedIn gives no way to look people
  up, and only links a name picked inside LinkedIn itself.
- **X has no name search** on its standard API, so handles are typed by hand.
- **Images** larger than about 1 MB are shrunk in your browser to fit
  Bluesky's limit. WebP and other formats are converted to JPEG. Large
  animated GIFs lose their animation.
- **Copy-and-open links cannot carry images.** Add them by hand there.

## Develop

```bash
cp .dev.vars.example .dev.vars
```

```bash
npm run dev
```

This runs the app at http://localhost:8787 with a local database.
`npm run dev:node` does the same on plain Node, without Cloudflare's tooling.

```bash
npm test
```

- `src/worker.js` – login and the API
- `src/accounts.js` – connecting and storing your accounts
- `src/resolve.js` – profile lookup per platform
- `src/post.js` – posting, with images
- `src/db.js` – saved people and profiles
- `src/auth.js` – session cookie and encryption
- `public/` – the page; `public/render.js` turns `@[Name]` into each
  platform's text and is shared with the Worker
- `migrations/` – database tables
