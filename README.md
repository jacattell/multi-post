# multi-post

Write a post once, then send it to Bluesky, LinkedIn, Mastodon and X.

The main feature is **@mentions that work everywhere**. Type `@` while writing,
find the person on each platform once, and their profiles are saved. Next time,
`@` + a few letters is enough.

## Run it

Needs Node.js 22.13 or newer. There is nothing to install.

```bash
npm start
```

Then open http://localhost:3000.

## How mentions work

1. Type `@` and a name in the post box.
2. Pick a saved person, or choose **Find "name" on all platforms…**
3. In the dialog, pick their profile on each platform (skip any they are not on) and save.
4. The draft shows `@[Jane Doe]`. The preview shows what each platform will get:

| Platform | Becomes | How the profile is found |
| --- | --- | --- |
| Bluesky | `@jane.bsky.social` (a real, linked mention) | Live search by name or handle |
| Mastodon | `@jane@server.social` | Live search, or exact lookup of `user@server` |
| X | `@janedoe` | You type the handle. Checked only if `X_BEARER_TOKEN` is set |
| LinkedIn | `Jane Doe` (plain name) | You paste the profile link |

If someone has no profile on a platform, their plain name is used there.

Saved people live in `data/multi-post.db` (SQLite) on your machine. Edit or
delete them in the **People** list.

## Posting

Copy `.env.example` to `.env` to connect accounts. All settings are optional.

- **Bluesky** and **Mastodon** post directly once you add credentials.
- **X** and **LinkedIn** (and any platform without credentials) give you a
  **Copy text and open** link. It opens that platform's own composer with your
  text filled in.

## Limits to know about

- **LinkedIn**: there is no public API to look people up, and a name only
  becomes a linked mention when picked inside LinkedIn's own composer. Retype
  `@` before the name there.
- **X**: searching users needs a paid API plan, so handles are entered by hand.
- The app is for one person on their own machine. It only listens on `localhost`.

## Develop

```bash
npm test
```

- `server.js` – HTTP server and API
- `lib/render.js` – turns `@[Name]` into each platform's text (shared with the browser)
- `lib/resolve.js` – profile lookup per platform
- `lib/post.js` – posting
- `lib/db.js` – saved people and profiles
- `public/` – the page
