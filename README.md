# ephemera

Temporary web pages for agents. An agent publishes a bundle of HTML, CSS, JS and images and gets back `https://p.rcn.sh/<id>/`. The page is deleted when its TTL runs out (24 hours by default, 5 minutes to 30 days, or permanent).

One Cloudflare Worker serves three things:

| Where | What | Auth |
| --- | --- | --- |
| `p.rcn.sh/<id>/` | the pages, sandboxed (`CSP: sandbox` without `allow-same-origin`), `noindex`, `no-cache` with ETags (so unchanged files come back as 304s), `Access-Control-Allow-Origin: *` so they can fetch and import their own files | none |
| `p.rcn.sh/api`, `p.rcn.sh/mcp` | HTTP API and remote MCP server | `Authorization: Bearer $EPHEMERA_TOKEN` |
| `ephemera.rcn.sh` | dashboard: list, extend, make permanent or temporary, delete | Cloudflare Access |

`p.rcn.sh/` itself shows a random cat from [cataas](https://cataas.com).

Page metadata lives in D1 and files in R2 (`pages/<id>/<version>/<path>`). Each update adds a version; a page keeps its last 5, and can be rolled back to any of them. Every request checks the expiry, so a page stops working the moment it expires; it then answers 410 for 7 days and 404 after that. A cron sweep every 10 minutes deletes the files of expired pages.

Limits: 25 MB and 200 files per page, 100 temporary pages, 25 permanent pages, 2 GB in total (kept versions included).

## Publishing

With MCP, the tools are `publish_page`, `update_page`, `patch_page`, `upload_url`, `extend_page`, `delete_page`, `list_pages`, `list_versions` and `rollback_page`. `publish_page` and `update_page` take `files`, or a single `html` or `markdown` document. `upload_url` returns a page URL and a `curl` command that uploads a zip to it, so a folder on disk never passes through the tool call.

With the API:

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

`PUT /api/pages/:id` replaces the files (the URL and expiry stay the same), `PATCH /api/pages/:id` with `{"ttl":"1d"}` or `{"ttl":"permanent"}` extends a page, `DELETE /api/pages/:id` deletes it, and `GET /api/pages` lists live pages and usage. `GET /api/pages/:id/versions` lists the kept versions and `POST /api/pages/:id/rollback` with `{"version":2}` serves one again. `POST /api/pages/:id/files` with `{"files":[…],"remove":["old.css"]}` changes single files and keeps the rest. `POST /api/uploads` (optionally with `{"id":…}`) returns an upload URL: `PUT` a zip to it within an hour, without the token, to replace that page's files.

Pages should link to their own files with relative paths. Root-relative links in HTML attributes are rewritten to stay inside the page; ones in CSS or JS can't be, so publishing returns a warning for each one it finds.

## Development

```sh
pnpm install
pnpm test        # vitest in workerd
pnpm typecheck
pnpm migrate     # apply new files in migrations/ to the production D1 database
pnpm deploy      # migrate, then cf deploy
```

The D1 schema lives in `migrations/`; add a change with `cf d1 migrations create <message>`. Tests apply the migrations to a fresh database before each test.

The token is a Worker secret (`EPHEMERA_TOKEN`). `ACCESS_AUD` in `cloudflare.config.ts` is the audience tag of the Access application that protects `ephemera.rcn.sh`. The dashboard refuses any request that Access didn't authenticate for that application.
