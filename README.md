<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" width="96" height="96" alt="">
  </picture>
</p>

<h1 align="center">ephemera</h1>

<p align="center">Instant web pages for agents.</p>

When an agent builds something you need to see, like a chart, a mockup or a report, it usually ends up as a file on disk or a wall of code in the chat. ephemera gives it a URL instead. The agent sends the HTML, CSS, JS and images, and gets back a link like `https://PAGES_HOST/k3x7q2abcd12/` that you can open on any device or send to someone else.

Pages are kept until you delete them. An agent can give a page a ttl (anywhere from 5 minutes to 30 days) when you ask for it to expire or when it's obviously scratch work, and it's deleted when that runs out. You can make a page expire, or stop it expiring, at any time.

`PAGES_HOST` and `ADMIN_HOST` below are the two hostnames you choose when you deploy it; see [Self-hosting](#self-hosting).

One Cloudflare Worker serves three things:

| Where | What | Auth |
| --- | --- | --- |
| `PAGES_HOST/<id>/` | the pages | none, or a pass for private pages |
| `PAGES_HOST/api`, `PAGES_HOST/mcp` | HTTP API and remote MCP server | `Authorization: Bearer $EPHEMERA_TOKEN` |
| `ADMIN_HOST` | the dashboard | Cloudflare Access |

`PAGES_HOST/` itself shows a random cat from [cataas](https://cataas.com).

## Pages

- **Sandboxed.** Pages are served with `CSP: sandbox` and without `allow-same-origin`, so agent-written code can't read cookies or storage for the domain it's served from.
- **Able to load their own files.** `Access-Control-Allow-Origin: *` lets a page `fetch` and `import` its own files from its opaque origin.
- **Cheap to refresh.** Files are sent `no-cache` with ETags, so unchanged files come back as 304s.
- **Fast to load.** A version's files never change, so the Worker keeps them in Cloudflare's edge cache and reads R2 for a file once per data centre. It remembers a path a version has no file at the same way, so a missing file costs R2 once too. Publishing fills the cache with the files it sends, in the data centre it came through; cached copies last a day. Each Worker instance also keeps a page's database row for 2 seconds, so a page's HTML and the files it loads share one database query. Each response carries a `Server-Timing` header (`db`, `file` with a cache hit or miss, `options`).
- **Served as published.** `no-transform` stops Cloudflare editing pages (injected scripts, Rocket Loader), which would also strip the ETags. The Worker gzips text itself instead.
- **Out of search engines:** `noindex`.

Pages should link to their own files with relative paths. Root-relative links in HTML attributes are rewritten to stay inside the page. Ones in CSS or JS can't be, so publishing returns a warning for each one it finds.

### Private pages

A private page shows a gate at `PAGES_HOST/<id>/`. The gate has a link to sign in through Access (`ADMIN_HOST/open/<id>/`), and a password form if the page has a password. Both lead to `PAGES_HOST/<id>/~<pass>/`, and that pass lasts 12 hours.

The pass goes in the path rather than a cookie, because a sandboxed page's own requests don't send cookies. Relative links carry the pass along, so the page's files, `fetch` and imports all work.

Password guesses are limited in the Worker, before the password is hashed: 5 a minute from one client address, and 30 a minute at one page from all addresses together. Past either limit the gate answers 429 with `Retry-After: 60`, even for the right password, until the minute is up. The limits come from Cloudflare's rate-limiting binding, so they hold on any deployment without dashboard rules; they count per Cloudflare location and are approximate. Someone guessing can hold the password form shut only while they keep guessing, and signing in through Access and share links still open the page.

A pass in the URL isn't sent to other sites in `Referer`. Pages go out with `Referrer-Policy: no-referrer`, and the sandbox gives the document an opaque origin, for which browsers send no referrer whatever policy its markup or script asks for. A page's script can still read its own URL and send it somewhere, so a private page that runs untrusted script can leak its pass that way.

`share_link` makes passes for other people, lasting up to 30 days. Setting a page's visibility again, or rolling it back, revokes every pass already handed out; a private page keeps its password through that unless you give a new one or clear it.

### Versions and expiry

Each update adds a version. A page keeps its last 5 and can be rolled back to any of them.

Pages given a ttl expire. Every request checks the expiry, so a page stops working the moment it expires. It then answers 410 for 7 days and 404 after that. A cron sweep every 10 minutes deletes the files of expired pages. It also checks 10 random live pages for files of versions the database no longer knows (left by an update that died part way, or a failed cleanup) and deletes them once they're an hour old.

Other changes (deleting a page, making it private, changing its password, updating it) apply at once in the Worker instance that made them. Other instances can serve the old state for up to 2 seconds, since each keeps a page's row that long. That delay is the cost of not querying the database on every request.

### Mockup sets

A mockup set is a permanent page that keeps a gallery of design options and which ones were picked. Its id comes from its project and name: `PAGES_HOST/myapp-onboarding-k3x7q2abcd/`.

- **Options are top-level folders**, each with its own `index.html` (`a/`, `compact/`, …), named after the folder. A set that is just a root `index.html` has one option, `main`. Each option in a set's `options` carries its `path` relative to the set's URL (`a/`, or empty for that root `main`).
- **Every option has a verdict:** pending, picked or rejected, with an optional one-line note. Adding a folder adds a pending option; removing one removes the option and its verdict.
- **The set's URL shows the options side by side** when it has no root `index.html`. Each option renders at a real desktop, tablet or phone viewport and is scaled down to fit its card; clicking one opens it full size, with tabs and arrow keys to flip between options. Picked options get a badge and their note; rejected ones aren't marked. A root `index.html` replaces this page.
- Everything else (private sets, versions, rollback, delete) works as for any page.

### Limits

| | |
| --- | --- |
| Per page | 50 MB, 200 files |
| Per mockup set | 2 MB, 200 files |
| Pages | no limit |
| Total storage | no limit; the dashboard shows what's stored, kept versions included |

## Publishing

### MCP

| Tool | Does |
| --- | --- |
| `publish_page` | publish `files`, or a single `html` or `markdown` document; takes `ttl`, `label`, `agent`, `slug`, `visibility`, `password` |
| `update_page` | replace a page's files; the URL and expiry stay the same |
| `patch_page` | change or remove single files and keep the rest |
| `upload_url` | a page URL and a `curl` command that uploads a zip to it once, so a folder on disk never passes through the tool call; the command leaves dotfiles (`.env`, `.git`) out. A new page waits as a placeholder that expires with the upload URL; its first new files, however they arrive, give it its `ttl` (permanent if none), unless its expiry was changed first |
| `set_visibility` | make a page private or public, and revoke its share links; `password` sets one, `""` clears it, and leaving it out keeps the current one |
| `share_link` | a link that opens a private page without signing in |
| `list_pages` | find pages, newest-updated first: compact rows filtered by `query` (label or id), `agent`, `kind`, `project`; 20 at a time (`limit` up to 100), with `cursor` for the next ones |
| `get_page` | one page's details and its files' paths and sizes; a mockup set's options with verdicts and notes |
| `read_file` | one file's content, from the current or a kept `version`: text as text, binary as base64, up to 256 KB |
| `list_versions`, `rollback_page` | see kept versions, and serve an older one again |
| `diff_versions` | the paths added, removed and changed between two kept versions (default: the current one and the one before) |
| `rename_page` | change a page's or mockup set's label |
| `extend_page`, `delete_page` | manage pages |
| `publish_mockup` | publish a mockup set from `project`, `name` and `files`; takes `agent`, `visibility`, `password` |
| `set_verdict` | pick, reject or reset an option of a mockup set, with an optional `note` |

Every tool states its read-only, destructive, idempotent and open-world hints, and the server sends instructions on how the tools fit together. Results are compact JSON, and times are ISO 8601 strings in UTC (`"expiresAt": "2026-11-15T09:30:00.000Z"`, or null for a permanent page).

### HTTP API

```sh
# inline files
curl -X POST https://$PAGES_HOST/api/pages -H "Authorization: Bearer $EPHEMERA_TOKEN" \
  -d '{"files":[{"path":"index.html","content":"<h1>hi</h1>"}],"ttl":"2h","label":"demo"}'

# one Markdown document, rendered
curl -X POST https://$PAGES_HOST/api/pages -H "Authorization: Bearer $EPHEMERA_TOKEN" -d '{"markdown":"# Report","ttl":"1d"}'

# a folder, as a zip
(cd site && zip -qr - .) | curl -X POST "https://$PAGES_HOST/api/pages?ttl=7d&label=site" \
  -H "Authorization: Bearer $EPHEMERA_TOKEN" -H "Content-Type: application/zip" --data-binary @-

# pull a page back to disk
curl -fsS "https://$PAGES_HOST/api/pages/$ID/zip" -H "Authorization: Bearer $EPHEMERA_TOKEN" -o page.zip
```

| Request | Does |
| --- | --- |
| `POST /api/pages` | publish; also takes `slug` (the id becomes `<slug>-<random>`), `visibility` and `password` |
| `GET /api/pages` | `?query=&agent=&kind=&project=&limit=&cursor=`: live pages, newest-updated first, as `list_pages` returns them, and usage |
| `GET /api/pages/:id` | one page, with its files, as `get_page` returns it |
| `PUT /api/pages/:id` | replace the files; the URL and expiry stay the same |
| `PATCH /api/pages/:id` | `{"ttl":"1d"}` sets or extends the expiry, `{"ttl":"permanent"}` stops it, `{"label":"…"}` renames |
| `DELETE /api/pages/:id` | delete |
| `POST /api/pages/:id/files` | `{"files":[…],"remove":["old.css","b/"]}` changes single files (or whole folders) and keeps the rest |
| `GET /api/pages/:id/versions` | list kept versions |
| `GET /api/pages/:id/files` | `?path=index.html&version=2`: one file's content, as `read_file` returns it |
| `GET /api/pages/:id/diff` | `?from=1&to=2`: files added, removed and changed, as `diff_versions` returns them |
| `GET /api/pages/:id/zip` | `?version=2`: the version's files as a zip (the current one by default) |
| `POST /api/pages/:id/rollback` | `{"version":2}` serves that version again |
| `POST /api/pages/:id/visibility` | `{"visibility":"private","password":"…"}`; leave `password` out to keep the current one, or send `null` or `""` to clear it |
| `POST /api/pages/:id/share` | `{"ttl":"7d"}` makes a share link |
| `POST /api/mockups` | `{"project":…,"name":…,"files":[…],"agent":…}`, or a zip with `?project=&name=&agent=`, publishes a mockup set |
| `POST /api/pages/:id/verdict` | `{"option":"a","verdict":"picked","note":"…"}` |
| `POST /api/uploads` | an upload URL (optionally for `{"id":…}`): `PUT` a zip to it once within an hour, without the token; it stops working as soon as the page gets any new version. Without an `id`, the placeholder page expires with the URL, and its first new files apply `ttl` |

## Dashboard

`ADMIN_HOST` shows a card per page with a thumbnail, and lets you search and filter by agent. From there you can rename, extend, make permanent or temporary, make private or public, set a password, make share links, roll back versions and delete.

The Mockups tab shows mockup sets grouped by project, newest first, with a row of option thumbnails per set and buttons to pick or reject each option. It filters by verdict.

Thumbnails come from Browser Rendering (the `BROWSER` binding). One is made the first time the dashboard asks for a page's current version, then kept in R2 next to the page's files. Thumbnails asked for together (a dashboard load's worth, up to 10) are shot in one browser launch, since Browser Rendering allows only a few launches a second. A page that never stops loading is shot after 10 seconds as it is. If a page can't be shot, the dashboard shows a blank tile and tries again after 10 minutes. If no browser could be had, it tries again on the next load. Mockup options get one each, cropped to their content (so a phone-sized mockup isn't lost in a desktop viewport). Only options without a thumbnail of the current version are shot, and an option's thumbnail goes when the option does.

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

To use it from an agent, point an MCP client at `https://PAGES_HOST/mcp` with `Authorization: Bearer <EPHEMERA_TOKEN>`.

## Development

```sh
pnpm install
pnpm test        # vitest in workerd
pnpm typecheck
pnpm migrate     # apply new files in migrations/ to the D1 database in .env
pnpm deploy      # migrate, then cf deploy
```

Page metadata lives in D1 and files in R2 (`pages/<id>/<version>/<path>`). The D1 schema lives in `migrations/`; add a change with `cf d1 migrations create <message>`. Tests apply the migrations to a fresh database before each test.

`cloudflare.config.ts` reads the hostnames and `ACCESS_AUD` from `.env`, and won't load without them. `pnpm typecheck` is the exception: it sets `EPHEMERA_TYPES_ONLY=1` so `cf workers types` gets placeholders, and works on a clean checkout. CI (`.github/workflows/ci.yml`) runs `pnpm typecheck` and `pnpm test` on pull requests and pushes to `main`.

Passes and upload tokens are in URL paths, so Workers Logs' invocation logs, which record each request's full URL, are off. The Worker logs one JSON line per request itself (method, host, path with passes and upload tokens replaced, status, milliseconds), and the messages that can carry a URL (uncaught errors, thumbnail failures) go through `redact` in `src/logging.ts`. The token is a Worker secret (`EPHEMERA_TOKEN`). The dashboard refuses any request that Access didn't authenticate for the application with audience `ACCESS_AUD`.

## License

[MIT](LICENSE)
