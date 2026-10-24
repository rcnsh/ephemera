import { checkCsrf, csrfToken } from "./auth.ts";
import { bytesText, LIMITS, PageError, pageUrl } from "./domain.ts";
import { Operations } from "./operations.ts";
import type { Page, Pages, Usage, Version } from "./pages.ts";
import { passFor, passUrl, safeRest } from "./privacy.ts";
import { screenshot } from "./thumbnails.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EXTENSIONS: Record<string, number> = { "1h": HOUR, "1d": DAY, "7d": 7 * DAY };
const SHARES = ["1d", "7d", "30d"];

/** How long the pass the screenshot browser opens a private page with lasts. */
const THUMBNAIL_PASS = 5 * 60_000;

function escape(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function duration(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const CSS = `
body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem auto; max-width: 80rem; padding: 0 1rem; color: #222; background: #fafafa; }
h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
.usage { color: #666; margin: 0 0 1rem; }
.filters { display: flex; gap: .5rem; margin: 0 0 1rem; }
.filters input { flex: 1; }
input, select, button { font: inherit; color: inherit; }
input, select { background: #fff; border: 1px solid #bbb; border-radius: 3px; padding: .1rem .4rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr)); gap: 1rem; }
.card { border: 1px solid #ddd; border-radius: 6px; background: #fff; overflow: hidden; display: flex; flex-direction: column; }
.thumb { display: block; aspect-ratio: 16 / 10; background: #eee; }
.thumb img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
.body { padding: .6rem .75rem .75rem; display: flex; flex-direction: column; gap: .4rem; }
.label { display: flex; gap: .3rem; }
.label input { flex: 1; font-weight: 600; border-color: transparent; padding-left: 0; background: transparent; }
.label input:hover, .label input:focus { border-color: #bbb; padding-left: .4rem; }
.meta { color: #666; margin: 0; }
.badge { display: inline-block; border: 1px solid #bbb; border-radius: 3px; padding: 0 .3rem; font-size: .85em; }
.badge.private { border-color: #a60; color: #a60; }
.actions { display: flex; flex-wrap: wrap; gap: .3rem; }
form { display: inline; margin: 0; }
button { cursor: pointer; background: none; border: 1px solid #bbb; border-radius: 3px; padding: 0 .4rem; }
button:hover { background: #eee; }
details > summary { cursor: pointer; color: #666; }
details ul { margin: .3rem 0 0; padding-left: 1.2rem; }
.danger, details.delete > summary { border-color: #b00; color: #b00; }
.muted { color: #888; }
.hidden { display: none; }
a { color: #0645ad; }
@media (prefers-color-scheme: dark) {
	body { color: #ddd; background: #161616; }
	.card { background: #1e1e1e; border-color: #333; }
	.thumb { background: #2a2a2a; }
	input, select { background: #1e1e1e; border-color: #555; }
	button { border-color: #555; }
	button:hover { background: #2a2a2a; }
	a { color: #8ab4f8; }
}
`;

const SCRIPT = `
for (const button of document.querySelectorAll("[data-copy]")) {
	button.addEventListener("click", async () => {
		await navigator.clipboard.writeText(button.dataset.copy);
		button.textContent = "copied";
		setTimeout(() => (button.textContent = "copy"), 1200);
	});
}
const search = document.getElementById("search");
const agent = document.getElementById("agent");
function filter() {
	const words = search.value.toLowerCase().split(/\\s+/).filter(Boolean);
	for (const card of document.querySelectorAll(".card")) {
		const text = card.dataset.search;
		const shown = words.every((word) => text.includes(word)) && (!agent.value || card.dataset.agent === agent.value);
		card.classList.toggle("hidden", !shown);
	}
}
search?.addEventListener("input", filter);
agent?.addEventListener("change", filter);
`;

/** A POST button for a page action, carrying the CSRF token. */
function action(page: Page, csrf: string, path: string, label: string, cls = ""): string {
	return `<form method="post" action="/pages/${page.id}/${path}"><input type="hidden" name="csrf" value="${csrf}"><button${cls ? ` class="${cls}"` : ""}>${label}</button></form>`;
}

function versionList(page: Page, versions: Version[], csrf: string, now: number): string {
	if (versions.length < 2) return "";
	const items = versions
		.map(
			(v) =>
				`<li>v${v.version} · ${duration(now - v.createdAt)} ago · ${bytesText(v.size)} · ${v.fileCount} file${v.fileCount === 1 ? "" : "s"} ${
					v.current ? '<span class="badge">serving</span>' : action(page, csrf, `rollback?version=${v.version}`, "roll back")
				}</li>`,
		)
		.join("");
	return `<details><summary>${versions.length} versions</summary><ul>${items}</ul></details>`;
}

function passwordForm(page: Page, csrf: string): string {
	if (page.visibility !== "private") return "";
	const remove = page.passwordHash ? ` ${action(page, csrf, "password", "remove password")}` : "";
	return `<details><summary>${page.passwordHash ? "change password" : "set a password"}</summary>
<form method="post" action="/pages/${page.id}/password"><input type="hidden" name="csrf" value="${csrf}"><input type="password" name="password" minlength="8" required autocomplete="new-password" placeholder="8+ characters"> <button>set</button></form>${remove}
</details>`;
}

function card(page: Page, versions: Version[], host: string, csrf: string, now: number): string {
	const url = pageUrl(host, page.id);
	const open = page.visibility === "private" ? `/open/${page.id}/` : url;
	const extend = Object.keys(EXTENSIONS)
		.map((by) => action(page, csrf, `extend?by=${by}`, `+${by}`))
		.join("");
	const lifetime = page.permanent ? action(page, csrf, "temporary", "make temporary") : `${extend}${action(page, csrf, "permanent", "make permanent")}`;
	const visibility = page.visibility === "private" ? action(page, csrf, "public", "make public") : action(page, csrf, "private", "make private");
	const share =
		page.visibility === "private"
			? `<details><summary>share link</summary>${SHARES.map((ttl) => action(page, csrf, `share?ttl=${ttl}`, ttl)).join(" ")}</details>`
			: "";
	const badges = [
		page.visibility === "private" ? `<span class="badge private">private${page.passwordHash ? " · password" : ""}</span>` : "",
		page.permanent ? '<span class="badge">permanent</span>' : "",
	].join(" ");
	const search = [page.label, page.id, page.agent].filter(Boolean).join(" ").toLowerCase();
	return `<article class="card" data-search="${escape(search)}" data-agent="${escape(page.agent ?? "")}">
<a class="thumb" href="${open}" target="_blank" rel="noopener noreferrer"><img src="/thumbnails/${page.id}.png?v=${page.version}" loading="lazy" alt=""></a>
<div class="body">
<form class="label" method="post" action="/pages/${page.id}/label"><input type="hidden" name="csrf" value="${csrf}"><input name="label" value="${escape(page.label ?? "")}" placeholder="untitled" maxlength="200" aria-label="Label"><button>save</button></form>
<p class="meta">${page.agent ? escape(page.agent) : '<span class="muted">no agent</span>'} · <a href="${open}" target="_blank" rel="noopener noreferrer">${page.id}</a> <button type="button" data-copy="${url}">copy</button></p>
<p class="meta">${duration(now - page.createdAt)} old · ${page.permanent ? "never expires" : `expires in ${duration(page.expiresAt! - now)}`} · ${bytesText(page.size)} · ${page.fileCount} file${page.fileCount === 1 ? "" : "s"} · v${page.version} ${badges}</p>
<div class="actions">${lifetime}${visibility}</div>
${share}
${passwordForm(page, csrf)}
${versionList(page, versions, csrf, now)}
<details class="delete"><summary>delete</summary> ${action(page, csrf, "delete", "really delete", "danger")}</details>
</div>
</article>`;
}

function render(pages: Page[], versions: Map<string, Version[]>, usage: Usage, host: string, csrf: string, nonce: string, now: number): string {
	const agents = [...new Set(pages.map((page) => page.agent).filter((agent): agent is string => !!agent))].sort();
	const cards = pages.map((page) => card(page, versions.get(page.id) ?? [], host, csrf, now)).join("\n");
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ephemera</title>
<style nonce="${nonce}">${CSS}</style>
<h1>ephemera</h1>
<p class="usage">${usage.temporaryPages} / ${LIMITS.temporaryPages} temporary · ${usage.permanentPages} / ${LIMITS.permanentPages} permanent · ${bytesText(usage.bytes)} / ${bytesText(LIMITS.totalBytes)}</p>
${
	pages.length
		? `<div class="filters"><input type="search" id="search" placeholder="Search labels, ids, agents" aria-label="Search">
<select id="agent" aria-label="Agent"><option value="">all agents</option>${agents.map((agent) => `<option>${escape(agent)}</option>`).join("")}</select></div>
<div class="grid">
${cards}
</div>`
		: '<p class="muted">No live pages.</p>'
}
<script nonce="${nonce}">${SCRIPT}</script>
</html>
`;
}

function shareRender(link: { url: string; expiresAt: number | null }, nonce: string, now: number): string {
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Share link</title>
<style nonce="${nonce}">${CSS} .share { display: flex; gap: .5rem; } .share input { flex: 1; }</style>
<h1>Share link</h1>
<p class="usage">Opens the page without signing in${link.expiresAt ? ` for ${duration(link.expiresAt - now)}` : ""}. Making the page public or private again revokes it.</p>
<p class="share"><input readonly value="${escape(link.url)}" aria-label="Link"> <button type="button" data-copy="${escape(link.url)}">copy</button></p>
<p><a href="/">back</a></p>
<script nonce="${nonce}">${SCRIPT}</script>
</html>
`;
}

function respond(body: string, status: number, nonce = ""): Response {
	return new Response(body, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": `default-src 'none'; img-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
		},
	});
}

const PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#888" fill-opacity=".15"/></svg>`;

/** GET /thumbnails/<id>.png: the cached screenshot for the version being served, made on first request. */
async function thumbnail(env: Env, ctx: ExecutionContext, pages: Pages, id: string): Promise<Response> {
	const found = await pages.lookup(id);
	if (found.state !== "live") return new Response("Not found", { status: 404 });
	const page = found.page;
	const cached = await pages.thumbnail(page);
	const headers = { "content-type": "image/png", "cache-control": "private, max-age=86400" };
	if (cached) return new Response(cached.body, { headers });

	const url = page.visibility === "private" ? passUrl(env.PAGES_HOST, id, await passFor(env.EPHEMERA_TOKEN, page, Date.now(), THUMBNAIL_PASS)) : pageUrl(env.PAGES_HOST, id);
	const png = await screenshot(env.BROWSER, url);
	// Not cached, so the next dashboard load tries again.
	if (!png) return new Response(PLACEHOLDER, { headers: { "content-type": "image/svg+xml", "cache-control": "no-store" } });
	ctx.waitUntil(pages.saveThumbnail(page, png));
	return new Response(png, { headers });
}

const ACTIONS = /^\/pages\/([a-z2-7]{12})\/(extend|permanent|temporary|delete|label|private|public|password|share|rollback)$/;

/** The admin dashboard on ADMIN_HOST. Only reachable through the Cloudflare Access app with audience ACCESS_AUD. */
export async function handleDashboard(request: Request, env: Env, ctx: ExecutionContext, pages: Pages): Promise<Response> {
	if (!ctx.access || ctx.access.aud !== env.ACCESS_AUD) return respond("Forbidden", 403);
	const identity = await ctx.access.getIdentity().catch(() => undefined);
	const user = String((identity as { email?: string } | undefined)?.email ?? "owner");
	const url = new URL(request.url);

	if (request.method === "GET" && url.pathname === "/") {
		const nonce = crypto.randomUUID().replaceAll("-", "");
		const [list, versions, usage] = await Promise.all([pages.list(), pages.allVersions(), pages.usage()]);
		const csrf = await csrfToken(env.EPHEMERA_TOKEN, user);
		return respond(render(list, versions, usage, env.PAGES_HOST, csrf, nonce, Date.now()), 200, nonce);
	}

	const thumb = /^\/thumbnails\/([a-z2-7]{12})\.png$/.exec(url.pathname);
	if (request.method === "GET" && thumb) return thumbnail(env, ctx, pages, thumb[1]!);

	// Signing in to a private page: Access has checked who this is, so hand out a pass.
	const opening = /^\/open\/([a-z2-7]{12})(?:\/(.*))?$/.exec(url.pathname);
	if (request.method === "GET" && opening) {
		const [, id, rest = ""] = opening as unknown as [string, string, string | undefined];
		const found = await pages.lookup(id);
		if (found.state !== "live") return respond(found.state === "gone" ? "This page has expired." : "Not found", found.state === "gone" ? 410 : 404);
		const page = found.page;
		const location =
			page.visibility === "private" ? passUrl(env.PAGES_HOST, id, await passFor(env.EPHEMERA_TOKEN, page, Date.now()), rest) : `${pageUrl(env.PAGES_HOST, id)}${safeRest(rest)}`;
		return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
	}

	const match = ACTIONS.exec(url.pathname);
	if (request.method !== "POST" || !match) return respond("Not found", 404);

	const form = await request.formData().catch(() => new FormData());
	const origin = request.headers.get("origin");
	if (origin !== `https://${env.ADMIN_HOST}` || !(await checkCsrf(env.EPHEMERA_TOKEN, user, String(form.get("csrf") ?? "")))) {
		return respond("Forbidden: reload the dashboard and try again", 403);
	}

	const [, id, name] = match as unknown as [string, string, string];
	const ops = new Operations(pages, env.PAGES_HOST, env.EPHEMERA_TOKEN);
	try {
		switch (name) {
			case "extend": {
				const by = EXTENSIONS[url.searchParams.get("by") ?? ""];
				if (!by) return respond("Unknown extension", 400);
				await pages.extend(id, by);
				break;
			}
			case "permanent":
				await pages.extend(id, "permanent");
				break;
			case "temporary":
				await pages.makeTemporary(id);
				break;
			case "label":
				await pages.setLabel(id, String(form.get("label") ?? ""));
				break;
			case "private":
			case "public":
				await ops.setVisibility(id, name, null);
				break;
			case "password":
				// Without a password, this removes it; the page stays private.
				await ops.setVisibility(id, "private", String(form.get("password") ?? "") || null);
				break;
			case "share": {
				const ttl = url.searchParams.get("ttl") ?? "";
				if (!SHARES.includes(ttl)) return respond("Unknown share length", 400);
				const nonce = crypto.randomUUID().replaceAll("-", "");
				return respond(shareRender(await ops.shareLink(id, ttl), nonce, Date.now()), 200, nonce);
			}
			case "rollback":
				await ops.rollback(id, Number(url.searchParams.get("version")));
				break;
			case "delete":
				await pages.delete(id);
				break;
		}
	} catch (error) {
		if (error instanceof PageError) return respond(`${escape(error.message)} <a href="/">back</a>`, error.status);
		throw error;
	}
	return new Response(null, { status: 303, headers: { location: "/" } });
}
