import { checkCsrf, csrfToken } from "./auth.ts";
import { bytesText, LIMITS, PageError, pageUrl } from "./domain.ts";
import { FAVICON_LINK, favicon, mark } from "./logo.ts";
import { MAIN_OPTION, type MockupOption, optionPath, VERDICTS } from "./mockups.ts";
import { Operations } from "./operations.ts";
import { ID_SOURCE, type Page, type Pages, type Usage, type Version } from "./pages.ts";
import { passFor, passUrl, safeRest } from "./privacy.ts";
import { screenshot, screenshotOptions } from "./thumbnails.ts";

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
h1 { font-size: 1.1rem; margin: 0 0 .25rem; display: flex; align-items: center; gap: .4rem; }
h1 .logo { width: 1.25em; height: 1.25em; }
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
.tabs { display: flex; gap: 1rem; margin: 0 0 1rem; }
.tabs a { text-decoration: none; color: #666; }
.tabs a.current { color: inherit; font-weight: 600; border-bottom: 2px solid currentColor; }
.project > h2 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
.set { border: 1px solid #ddd; border-radius: 6px; background: #fff; padding: .6rem .75rem .75rem; margin: 0 0 1rem; display: flex; flex-direction: column; gap: .5rem; }
.set .meta strong { color: #222; }
.options { display: flex; gap: .75rem; overflow-x: auto; padding-bottom: .25rem; }
.option { margin: 0; flex: 0 0 auto; width: 14rem; display: flex; flex-direction: column; gap: .3rem; border: 2px solid transparent; border-radius: 6px; padding: .3rem; }
.option.picked { border-color: #1a7f37; background: #1a7f3712; }
.option.rejected .shot { opacity: .45; }
.shot { display: block; height: 16rem; background: #eee; border-radius: 3px; overflow: hidden; }
.shot img { display: block; width: 100%; height: 100%; object-fit: contain; object-position: top; }
.option figcaption { font-weight: 600; overflow-wrap: anywhere; }
.verdict { display: flex; flex-wrap: wrap; gap: .25rem; }
.verdict input[name=note] { width: 100%; }
.badge.picked { border-color: #1a7f37; color: #1a7f37; }
.badge.rejected { border-color: #b00; color: #b00; }
@media (prefers-color-scheme: dark) {
	body { color: #ddd; background: #161616; }
	.card, .set { background: #1e1e1e; border-color: #333; }
	.set .meta strong { color: #ddd; }
	.thumb, .shot { background: #2a2a2a; }
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
const verdict = document.getElementById("verdict");
function filter() {
	const words = search.value.toLowerCase().split(/\\s+/).filter(Boolean);
	for (const card of document.querySelectorAll(".card, .set")) {
		const text = card.dataset.search;
		const shown =
			words.every((word) => text.includes(word)) &&
			(!agent || !agent.value || card.dataset.agent === agent.value) &&
			(!verdict || !verdict.value || card.dataset.verdicts.split(" ").includes(verdict.value));
		card.classList.toggle("hidden", !shown);
	}
	for (const project of document.querySelectorAll(".project")) {
		project.classList.toggle("hidden", !project.querySelector(".set:not(.hidden)"));
	}
}
search?.addEventListener("input", filter);
agent?.addEventListener("change", filter);
verdict?.addEventListener("change", filter);
`;

/** The tab a page is shown on, where its actions come back to. */
function tabOf(page: Page): string {
	return page.kind === "mockup" ? "/mockups" : "/";
}

/** A form's hidden fields: the CSRF token, and the tab to come back to. */
function hidden(page: Page, csrf: string): string {
	return `<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="back" value="${tabOf(page)}">`;
}

/** A POST button for a page action, carrying the CSRF token. */
function action(page: Page, csrf: string, path: string, label: string, cls = ""): string {
	return `<form method="post" action="/pages/${page.id}/${path}">${hidden(page, csrf)}<button${cls ? ` class="${cls}"` : ""}>${label}</button></form>`;
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
<form method="post" action="/pages/${page.id}/password">${hidden(page, csrf)}<input type="password" name="password" minlength="8" required autocomplete="new-password" placeholder="8+ characters"> <button>set</button></form>${remove}
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
<form class="label" method="post" action="/pages/${page.id}/label">${hidden(page, csrf)}<input name="label" value="${escape(page.label ?? "")}" placeholder="untitled" maxlength="200" aria-label="Label"><button>save</button></form>
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

/** The path of an option inside its set. A lone `main` option is the set's root page. */
function optionHref(options: MockupOption[], option: MockupOption): string {
	return optionPath(option.name, !(options.length === 1 && option.name === MAIN_OPTION));
}

function optionFigure(page: Page, options: MockupOption[], option: MockupOption, open: string, csrf: string): string {
	const buttons = (["picked", "rejected", "pending"] as const)
		.filter((verdict) => verdict !== option.verdict)
		.map((verdict) => `<button name="verdict" value="${verdict}">${{ picked: "pick", rejected: "reject", pending: "undecide" }[verdict]}</button>`)
		.join("");
	const badge = option.verdict === "pending" ? "" : ` <span class="badge ${option.verdict}">${option.verdict}</span>`;
	return `<figure class="option ${option.verdict}">
<a class="shot" href="${open}${optionHref(options, option)}" target="_blank" rel="noopener noreferrer"><img src="/thumbnails/${page.id}/${encodeURIComponent(option.name)}.png?v=${page.version}" loading="lazy" alt=""></a>
<figcaption>${escape(option.name)}${badge}</figcaption>
<form class="verdict" method="post" action="/pages/${page.id}/verdict">${hidden(page, csrf)}<input type="hidden" name="option" value="${escape(option.name)}"><input name="note" value="${escape(option.note ?? "")}" placeholder="note" maxlength="200" aria-label="Note">${buttons}</form>
</figure>`;
}

function mockupSet(page: Page, options: MockupOption[], versions: Version[], host: string, csrf: string, now: number): string {
	const url = pageUrl(host, page.id);
	const open = page.visibility === "private" ? `/open/${page.id}/` : url;
	const visibility = page.visibility === "private" ? action(page, csrf, "public", "make public") : action(page, csrf, "private", "make private");
	const share =
		page.visibility === "private"
			? `<details><summary>share link</summary>${SHARES.map((ttl) => action(page, csrf, `share?ttl=${ttl}`, ttl)).join(" ")}</details>`
			: "";
	const badges = [
		page.visibility === "private" ? `<span class="badge private">private${page.passwordHash ? " · password" : ""}</span>` : "",
		page.permanent ? "" : `<span class="badge">expires in ${duration(page.expiresAt! - now)}</span>`,
	].join(" ");
	const verdicts = [...new Set(options.map((option) => option.verdict))].join(" ");
	const search = [page.label, page.id, page.project, ...options.map((option) => `${option.name} ${option.note ?? ""}`)].filter(Boolean).join(" ").toLowerCase();
	return `<article class="set" data-search="${escape(search)}" data-verdicts="${verdicts}">
<p class="meta"><strong>${escape(page.label ?? page.id)}</strong> · <a href="${open}" target="_blank" rel="noopener noreferrer">${page.id}</a> <button type="button" data-copy="${url}">copy</button> · ${duration(now - page.createdAt)} old · ${bytesText(page.size)} · v${page.version} ${badges}</p>
<div class="options">
${options.map((option) => optionFigure(page, options, option, open, csrf)).join("\n")}
</div>
<div class="actions">${visibility}</div>
${share}
${passwordForm(page, csrf)}
${versionList(page, versions, csrf, now)}
<details class="delete"><summary>delete</summary> ${action(page, csrf, "delete", "really delete", "danger")}</details>
</article>`;
}

/** Mockup sets by project, newest first; projects ordered by their newest set. */
function mockupSets(sets: Page[], options: Map<string, MockupOption[]>, versions: Map<string, Version[]>, host: string, csrf: string, now: number): string {
	const byProject = new Map<string, Page[]>();
	for (const page of [...sets].sort((a, b) => b.createdAt - a.createdAt)) {
		const project = page.project ?? "";
		byProject.set(project, [...(byProject.get(project) ?? []), page]);
	}
	return [...byProject]
		.map(
			([project, pages]) => `<section class="project">
<h2>${project ? escape(project) : '<span class="muted">no project</span>'}</h2>
${pages.map((page) => mockupSet(page, options.get(page.id) ?? [], versions.get(page.id) ?? [], host, csrf, now)).join("\n")}
</section>`,
		)
		.join("\n");
}

type Tab = "pages" | "mockups";

function render(
	tab: Tab,
	all: Page[],
	versions: Map<string, Version[]>,
	options: Map<string, MockupOption[]>,
	usage: Usage,
	host: string,
	csrf: string,
	nonce: string,
	now: number,
): string {
	let body: string;
	if (tab === "pages") {
		const pages = all.filter((page) => page.kind === "page");
		const agents = [...new Set(pages.map((page) => page.agent).filter((agent): agent is string => !!agent))].sort();
		const cards = pages.map((page) => card(page, versions.get(page.id) ?? [], host, csrf, now)).join("\n");
		body = pages.length
			? `<div class="filters"><input type="search" id="search" placeholder="Search labels, ids, agents" aria-label="Search">
<select id="agent" aria-label="Agent"><option value="">all agents</option>${agents.map((agent) => `<option>${escape(agent)}</option>`).join("")}</select></div>
<div class="grid">
${cards}
</div>`
			: '<p class="muted">No live pages.</p>';
	} else {
		const sets = all.filter((page) => page.kind === "mockup");
		body = sets.length
			? `<div class="filters"><input type="search" id="search" placeholder="Search projects, names, options, notes" aria-label="Search">
<select id="verdict" aria-label="Verdict"><option value="">any verdict</option>${VERDICTS.map((verdict) => `<option value="${verdict}">has ${verdict}</option>`).join("")}</select></div>
${mockupSets(sets, options, versions, host, csrf, now)}`
			: '<p class="muted">No mockup sets yet. Agents publish them with publish_mockup.</p>';
	}
	const tabLink = (name: Tab, href: string, label: string) => `<a href="${href}"${tab === name ? ' class="current" aria-current="page"' : ""}>${label}</a>`;
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ephemera${tab === "mockups" ? " · mockups" : ""}</title>
${FAVICON_LINK}
<style nonce="${nonce}">${CSS}</style>
<h1>${mark("logo", 7, 'class="logo"')}ephemera</h1>
<p class="usage">${usage.temporaryPages} / ${LIMITS.temporaryPages} temporary · ${usage.permanentPages} / ${LIMITS.permanentPages} permanent · ${usage.mockups} mockup set${usage.mockups === 1 ? "" : "s"} · ${bytesText(usage.bytes)} / ${bytesText(LIMITS.totalBytes)}</p>
<nav class="tabs">${tabLink("pages", "/", "Pages")}${tabLink("mockups", "/mockups", "Mockups")}</nav>
${body}
<script nonce="${nonce}">${SCRIPT}</script>
</html>
`;
}

function shareRender(link: { url: string; expiresAt: number | null }, nonce: string, now: number): string {
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Share link</title>
${FAVICON_LINK}
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
			// Not no-referrer: under that, browsers send `Origin: null` with the
			// dashboard's own form posts, and the origin check refuses them.
			// same-origin still sends nothing to pages on PAGES_HOST.
			"referrer-policy": "same-origin",
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

/** Option thumbnails being made, by set and version, so the dashboard's requests for one set's options share a browser. */
const shooting = new Map<string, Promise<Map<string, Uint8Array | null>>>();

/** Shoots every option of a mockup set in one browser launch, and keeps the ones that worked. */
async function shootOptions(env: Env, ctx: ExecutionContext, pages: Pages, page: Page): Promise<Map<string, Uint8Array | null>> {
	const options = await pages.options(page.id);
	const pass = page.visibility === "private" ? await passFor(env.EPHEMERA_TOKEN, page, Date.now(), THUMBNAIL_PASS) : null;
	const urls = await Promise.all(
		options.map(async (option) => {
			const path = optionPath(option.name, await pages.hasFile(page, `${option.name}/index.html`));
			return pass ? passUrl(env.PAGES_HOST, page.id, pass, path) : `${pageUrl(env.PAGES_HOST, page.id)}${path}`;
		}),
	);
	const pngs = await screenshotOptions(env.BROWSER, urls);
	const shots = new Map(options.map((option, i) => [option.name, pngs[i] ?? null]));
	for (const [option, png] of shots) if (png) ctx.waitUntil(pages.saveOptionThumbnail(page, option, png));
	return shots;
}

/** GET /thumbnails/<id>/<option>.png: like `thumbnail`, for one option of a mockup set. */
async function optionThumbnail(env: Env, ctx: ExecutionContext, pages: Pages, id: string, option: string): Promise<Response> {
	const found = await pages.lookup(id);
	if (found.state !== "live" || found.page.kind !== "mockup") return new Response("Not found", { status: 404 });
	const page = found.page;
	const cached = await pages.optionThumbnail(page, option);
	const headers = { "content-type": "image/png", "cache-control": "private, max-age=86400" };
	if (cached) return new Response(cached.body, { headers });

	const key = `${id}/${page.version}`;
	let shots = shooting.get(key);
	if (!shots) {
		shots = shootOptions(env, ctx, pages, page).finally(() => shooting.delete(key));
		shooting.set(key, shots);
	}
	const png = (await shots).get(option);
	if (png === undefined) return new Response("Not found", { status: 404 });
	if (!png) return new Response(PLACEHOLDER, { headers: { "content-type": "image/svg+xml", "cache-control": "no-store" } });
	return new Response(png, { headers });
}

const ACTIONS = new RegExp(`^/pages/(${ID_SOURCE})/(extend|permanent|temporary|delete|label|private|public|password|share|rollback|verdict)$`);

/** The admin dashboard on ADMIN_HOST. Only reachable through the Cloudflare Access app with audience ACCESS_AUD. */
export async function handleDashboard(request: Request, env: Env, ctx: ExecutionContext, pages: Pages): Promise<Response> {
	if (!ctx.access || ctx.access.aud !== env.ACCESS_AUD) return respond("Forbidden", 403);
	const identity = await ctx.access.getIdentity().catch(() => undefined);
	const user = String((identity as { email?: string } | undefined)?.email ?? "owner");
	const url = new URL(request.url);

	if (request.method === "GET" && url.pathname === "/favicon.svg") return favicon();
	if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/mockups")) {
		const nonce = crypto.randomUUID().replaceAll("-", "");
		const [list, versions, options, usage] = await Promise.all([pages.list(), pages.allVersions(), pages.allOptions(), pages.usage()]);
		const csrf = await csrfToken(env.EPHEMERA_TOKEN, user);
		const tab = url.pathname === "/" ? "pages" : "mockups";
		return respond(render(tab, list, versions, options, usage, env.PAGES_HOST, csrf, nonce, Date.now()), 200, nonce);
	}

	const thumb = new RegExp(`^/thumbnails/(${ID_SOURCE})\\.png$`).exec(url.pathname);
	if (request.method === "GET" && thumb) return thumbnail(env, ctx, pages, thumb[1]!);
	const optionThumb = new RegExp(`^/thumbnails/(${ID_SOURCE})/([^/]+)\\.png$`).exec(url.pathname);
	if (request.method === "GET" && optionThumb) {
		let option: string;
		try {
			option = decodeURIComponent(optionThumb[2]!);
		} catch {
			return new Response("Not found", { status: 404 });
		}
		return optionThumbnail(env, ctx, pages, optionThumb[1]!, option);
	}

	// Signing in to a private page: Access has checked who this is, so hand out a pass.
	const opening = new RegExp(`^/open/(${ID_SOURCE})(?:/(.*))?$`).exec(url.pathname);
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
			case "verdict": {
				const verdict = String(form.get("verdict") ?? "");
				await ops.setVerdict(id, String(form.get("option") ?? ""), verdict, String(form.get("note") ?? ""));
				break;
			}
		}
	} catch (error) {
		if (error instanceof PageError) return respond(`${escape(error.message)} <a href="/">back</a>`, error.status);
		throw error;
	}
	const back = form.get("back") === "/mockups" ? "/mockups" : "/";
	return new Response(null, { status: 303, headers: { location: back } });
}
