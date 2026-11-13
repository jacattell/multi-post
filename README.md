# multi-post

Write a post once, then send it to Bluesky, LinkedIn, Mastodon and X.

Live at https://multi-post.cattell.com. Every push to `main` deploys it.

- **@mentions that work everywhere.** Type `@`, find the person on each
  platform once, and their profiles are saved. Next time, `@` plus a few
  letters is enough.
- **Images.** Up to 4 per post, each with alt text.
- **Direct posting** to all four platforms, once you connect your accounts.
- **Hosted on Cloudflare** (free plan). Sign in with Google or GitHub.

It is built for one person, or a few who share the same social accounts.
Only the email addresses you list can sign in.

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

3. Set who may sign in, and a long random secret (for example the output of
   `openssl rand -hex 32`). The secret signs your login and encrypts the
   account tokens the app stores.

   ```bash
   npx wrangler secret put ALLOWED_EMAILS
   ```

   ```bash
   npx wrangler secret put SESSION_SECRET
   ```

   `ALLOWED_EMAILS` is one or more email addresses, separated by commas. Use
   the address on your Google or GitHub account.

4. Deploy. This also creates the database tables.

   ```bash
   npm run deploy
   ```

   Wrangler prints the address, like `https://multi-post.<you>.workers.dev`.

5. Set up sign-in (next section), then deploy once more.

**Your own domain:** set the `routes` line in `wrangler.jsonc` to the name you
want and deploy again. The domain must already be on your Cloudflare account.

## Automatic image descriptions (optional)

When you attach an image, the app can suggest alt text for it using Claude and put it in the description box, marked "Suggested automatically" so you know to check it. It never replaces anything you have typed. The image and the post's text are sent to Anthropic to write the description.

1. Create an API key in the [Claude Console](https://platform.claude.com/), and set a monthly spend limit for it.
2. Save it:

   ```bash
   npx wrangler secret put ANTHROPIC_API_KEY
   ```

3. Deploy again.

It uses Claude Opus 5.5, which costs roughly 1p per image or less. To use another model, set `ALT_TEXT_MODEL` (for example `claude-haiku-5-5`, which is much cheaper) as a variable in `wrangler.jsonc` or the Cloudflare dashboard. Without a key, the description box works as before.

## Set up sign-in

Set up Google, GitHub, or both. The sign-in page shows a button for each one
you set up. `YOUR-APP-ADDRESS` is the address from step 4, or your own domain.

### Google

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
   create a project, then **Create credentials → OAuth client ID**, type
   **Web application**. (It may ask you to fill in a consent screen first.)
2. Add the authorised redirect URI
   `https://YOUR-APP-ADDRESS/api/login/google/callback`.
3. Save the client ID and secret:

   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   ```

   ```bash
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

### GitHub

1. In GitHub: Settings → Developer settings → OAuth Apps → **New OAuth App**.
2. Set the authorization callback URL to
   `https://YOUR-APP-ADDRESS/api/login/github/callback`.
3. Generate a client secret, then save both values:

   ```bash
   npx wrangler secret put GITHUB_CLIENT_ID
   ```

   ```bash
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```

Your GitHub account must have a *verified* email that is in `ALLOWED_EMAILS`.
It does not need to be public.

### Who gets in

Only verified email addresses in `ALLOWED_EMAILS`. Everyone who signs in
shares the same saved people and connected accounts. Removing an address
locks that person out straight away. A sign-in lasts 30 days.

## Connect your accounts

Open the app, sign in, and use **Your accounts**. A platform that is not
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

This runs the app at http://localhost:8787 with a local database. To sign in
locally, add `http://localhost:8787/api/login/google/callback` (or the GitHub
one) as a second redirect URL on your sign-in app.
`npm run dev:node` does the same on plain Node, without Cloudflare's tooling.

```bash
npm test
```

- `src/worker.js` – the API
- `src/login.js` – Google and GitHub sign-in
- `src/accounts.js` – connecting and storing your accounts
- `src/resolve.js` – profile lookup per platform
- `src/post.js` – posting, with images
- `src/db.js` – saved people and profiles
- `src/auth.js` – signed cookies and encryption
- `public/` – the page; `public/render.js` turns `@[Name]` into each
  platform's text and is shared with the Worker
- `migrations/` – database tables
