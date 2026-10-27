<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" width="96" height="96" alt="">
  </picture>
</p>

<h1 align="center">ephemera</h1>

<p align="center">Temporary web pages for agents.</p>

An agent publishes a bundle of HTML, CSS, JS and images and gets back `https://p.rcn.sh/<id>/`. The page is deleted when its TTL runs out: 24 hours by default, anywhere from 5 minutes to 30 days, or permanent.

This repo runs `p.rcn.sh`, and the hostnames below are that instance's. To run your own, see [Self-hosting](#self-hosting).

One Cloudflare Worker serves three things:

| Where | What | Auth |
| --- | --- | --- |
| `p.rcn.sh/<id>/` | the pages | none, or a pass for private pages |
| `p.rcn.sh/api`, `p.rcn.sh/mcp` | HTTP API and remote MCP server | `Authorization: Bearer $EPHEMERA_TOKEN` |
| `ephemera.rcn.sh` | the dashboard | Cloudflare Access |

`p.rcn.sh/` itself shows a random cat from [cataas](https://cataas.com).

## Pages

- **Sandboxed.** Pages are served with `CSP: sandbox` and without `allow-same-origin`, so agent-written code can't read cookies or storage for `rcn.sh`.
- **Able to load their own files.** `Access-Control-Allow-Origin: *` lets a page `fetch` and `import` its own files from its opaque origin.
- **Cheap to refresh.** Files are sent `no-cache` with ETags, so unchanged files come back as 304s.
- **Served as published.** `no-transform` stops Cloudflare editing pages (injected scripts, Rocket Loader), which would also strip the ETags. The Worker gzips text itself instead.
- **Out of search engines:** `noindex`.

Pages should link to their own files with relative paths. Root-relative links in HTML attributes are rewritten to stay inside the page. Ones in CSS or JS can't be, so publishing returns a warning for each one it finds.

### Private pages

A private page shows a gate at `p.rcn.sh/<id>/`. The gate has a link to sign in through Access (`ephemera.rcn.sh/open/<id>/`), and a password form if the page has a password. Both lead to `p.rcn.sh/<id>/~<pass>/`, and that pass lasts 12 hours.

The pass goes in the path rather than a cookie, because a sandboxed page's own requests don't send cookies. Relative links carry the pass along, so the page's files, `fetch` and imports all work.

`share_link` makes passes for other people, lasting up to 30 days. Setting a page's visibility again revokes every pass already handed out.

### Versions and expiry

Each update adds a version. A page keeps its last 5 and can be rolled back to any of them.

Every request checks the expiry, so a page stops working the moment it expires. It then answers 410 for 7 days and 404 after that. A cron sweep every 10 minutes deletes the files of expired pages.

### Mockup sets

A mockup set is a permanent page that keeps a gallery of design options and which ones were picked. Its id comes from its project and name: `p.rcn.sh/terminus-widget-density-k3x7q2/`.

- **Options are top-level folders**, each with its own `index.html` (`a/`, `compact/`, …), named after the folder. A set that is just a root `index.html` has one option, `main`.
- **Every option has a verdict:** pending, picked or rejected, with an optional one-line note. Adding a folder adds a pending option; removing one removes the option and its verdict.
- **The set's URL shows the options side by side** when it has no root `index.html`, with a badge on picked ones. Rejected ones aren't marked. A root `index.html` replaces this page.
- Everything else (private sets, versions, rollback, delete) works as for any page.

### Limits

| | |
| --- | --- |
| Per page | 25 MB, 200 files |
| Per mockup set | 2 MB, 200 files |
| Temporary pages | 100 |
| Permanent pages | 25; mockup sets don't count |
| Total storage | 2 GB, kept versions included |

## Publishing

### MCP

| Tool | Does |
| --- | --- |
| `publish_page` | publish `files`, or a single `html` or `markdown` document; takes `ttl`, `label`, `agent`, `visibility`, `password` |
| `update_page` | replace a page's files; the URL and expiry stay the same |
| `patch_page` | change or remove single files and keep the rest |
| `upload_url` | a page URL and a `curl` command that uploads a zip to it, so a folder on disk never passes through the tool call |
| `set_visibility` | make a page private (optionally with a password) or public |
| `share_link` | a link that opens a private page without signing in |
| `list_versions`, `rollback_page` | see kept versions, and serve an older one again |
| `extend_page`, `delete_page`, `list_pages` | manage pages |
| `publish_mockup` | publish a mockup set from `project`, `name` and `files`; takes `visibility`, `password` |
| `set_verdict` | pick, reject or reset an option of a mockup set, with an optional `note` |

### HTTP API

```sh
# inline files
curl -X POST https://p.rcn.sh/api/pages -H "Authorization: Bearer $EPHEMERA_TOKEN" \
  -d '{"files":[{"path":"index.html","content":"<h1>hi</h1>"}],"ttl":"2h","label":"demo"}'

# one Markdown document, rendered
curl -X POST https://p.rcn.sh/api/pages -H "Authorization: Bearer $EPHEMERA_TOKEN" -d '{"markdown":"# Report","ttl":"1d"}'

# a folder, as a zip
(cd site && zip -qr - .) | curl -X POST "https://p.rcn.sh/api/pages?ttl=7d&label=site" \
  -H "Authorization: Bearer $EPHEMERA_TOKEN" -H "Content-Type: application/zip" --data-binary @-
```

| Request | Does |
| --- | --- |
| `POST /api/pages` | publish; also takes `visibility` and `password` |
| `GET /api/pages` | list live pages and usage |
| `PUT /api/pages/:id` | replace the files; the URL and expiry stay the same |
| `PATCH /api/pages/:id` | `{"ttl":"1d"}` or `{"ttl":"permanent"}` extends, `{"label":"…"}` renames |
| `DELETE /api/pages/:id` | delete |
| `POST /api/pages/:id/files` | `{"files":[…],"remove":["old.css","b/"]}` changes single files (or whole folders) and keeps the rest |
| `GET /api/pages/:id/versions` | list kept versions |
| `POST /api/pages/:id/rollback` | `{"version":2}` serves that version again |
| `POST /api/pages/:id/visibility` | `{"visibility":"private","password":"…"}` |
| `POST /api/pages/:id/share` | `{"ttl":"7d"}` makes a share link |
| `POST /api/mockups` | `{"project":…,"name":…,"files":[…]}`, or a zip with `?project=&name=`, publishes a mockup set |
| `POST /api/pages/:id/verdict` | `{"option":"a","verdict":"picked","note":"…"}` |
| `POST /api/uploads` | an upload URL (optionally for `{"id":…}`): `PUT` a zip to it within an hour, without the token |

## Dashboard

`ephemera.rcn.sh` shows a card per page with a thumbnail, and lets you search and filter by agent. From there you can rename, extend, make permanent or temporary, make private or public, set a password, make share links, roll back versions and delete.

The Mockups tab shows mockup sets grouped by project, newest first, with a row of option thumbnails per set and buttons to pick or reject each option. It filters by verdict.

Thumbnails come from Browser Rendering (the `BROWSER` binding). One is made the first time the dashboard asks for a page's current version, then kept in R2 next to the page's files. If the browser fails, the dashboard shows a blank tile and tries again on the next load. Mockup options get one each, cropped to their content (so a phone-sized mockup isn't lost in a desktop viewport), and all the options of a set are shot in one browser launch.

## Self-hosting

You need a Cloudflare account with a zone for your hostnames, Workers Paid (for Browser Rendering and the cron sweep), and [`cf`](https://developers.cloudflare.com/cf/).

1. `pnpm install`, then `cp .env.example .env`.
2. Create the database and bucket, and put the database's ID in `.env` as `D1_DATABASE_ID`:
   ```sh
   cf d1 create --name ephemera
   cf r2 buckets create --name ephemera
   ```
3. Set `PAGES_HOST` and `ADMIN_HOST` in `.env`. Both must be on a zone in your account; deploying attaches them to the Worker.
4. In Zero Trust, add a self-hosted Access application for `ADMIN_HOST` and put its audience (AUD) tag in `.env` as `ACCESS_AUD`.
5. `pnpm deploy`, then set the token agents use:
   ```sh
   cf workers secrets update EPHEMERA_TOKEN --worker ephemera --text "$(openssl rand -hex 32)"
   ```
6. Optional: add a Configuration Rule for `PAGES_HOST` that turns off Rocket Loader, Email Obfuscation, Automatic HTTPS Rewrites, Server Side Excludes, Fonts and Web Analytics. `no-transform` covers this too; the rule keeps those features off even for a response without it.

To use it from an agent, point an MCP client at `https://<PAGES_HOST>/mcp` with `Authorization: Bearer <EPHEMERA_TOKEN>`.

## Development

```sh
pnpm install
pnpm test        # vitest in workerd
pnpm typecheck
pnpm migrate     # apply new files in migrations/ to the D1 database in .env
pnpm deploy      # migrate, then cf deploy
```

Page metadata lives in D1 and files in R2 (`pages/<id>/<version>/<path>`). The D1 schema lives in `migrations/`; add a change with `cf d1 migrations create <message>`. Tests apply the migrations to a fresh database before each test.

`cloudflare.config.ts` reads the hostnames and `ACCESS_AUD` from `.env`, and won't load without them. The token is a Worker secret (`EPHEMERA_TOKEN`). The dashboard refuses any request that Access didn't authenticate for the application with audience `ACCESS_AUD`.

## License

[MIT](LICENSE)
