import { checkCsrf, csrfToken } from "./auth.ts";
import { bytesText, PageError, pageUrl } from "./domain.ts";
import { FAVICON_LINK, favicon, mark } from "./logo.ts";
import { type MockupOption, VERDICTS } from "./mockups.ts";
import { Operations, type Overview } from "./operations.ts";
import { ID_SOURCE, type Page, type Pages, type Version } from "./pages.ts";
import { viewerUrl } from "./privacy.ts";
import { type Shot, type ShotResult, screenshots } from "./thumbnails.ts";

/** What the dashboard's extend buttons add, as ttls. */
const EXTENSIONS = ["1h", "1d", "7d"];
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
	const extend = EXTENSIONS
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

/**
 * An option's thumbnail and verdict form. The form's first button saves the
 * note and sends no verdict, so Enter in the note box (which presses the
 * first button) leaves the verdict as it is now, even if it changed since
 * the page loaded. `note_was` is the note as the page loaded it: an
 * unchanged box doesn't overwrite a note set since.
 */
function optionFigure(page: Page, option: MockupOption, open: string, csrf: string): string {
	const save = "<button>save</button>";
	const buttons = (["picked", "rejected", "pending"] as const)
		.filter((verdict) => verdict !== option.verdict)
		.map((verdict) => `<button name="verdict" value="${verdict}">${{ picked: "pick", rejected: "reject", pending: "undecide" }[verdict]}</button>`)
		.join("");
	const badge = option.verdict === "pending" ? "" : ` <span class="badge ${option.verdict}">${option.verdict}</span>`;
	return `<figure class="option ${option.verdict}">
<a class="shot" href="${open}${option.path}" target="_blank" rel="noopener noreferrer"><img src="/thumbnails/${page.id}/${encodeURIComponent(option.name)}.png?v=${page.version}" loading="lazy" alt=""></a>
<figcaption>${escape(option.name)}${badge}</figcaption>
<form class="verdict" method="post" action="/pages/${page.id}/verdict">${hidden(page, csrf)}<input type="hidden" name="option" value="${escape(option.name)}"><input type="hidden" name="note_was" value="${escape(option.note ?? "")}"><input name="note" value="${escape(option.note ?? "")}" placeholder="note" maxlength="200" aria-label="Note">${save}${buttons}</form>
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
${options.map((option) => optionFigure(page, option, open, csrf)).join("\n")}
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

function render(tab: Tab, { pages: all, versions, options, usage }: Overview, host: string, csrf: string, nonce: string, now: number): string {
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
<p class="usage">${usage.permanentPages} kept · ${usage.temporaryPages} expiring · ${usage.mockups} mockup set${usage.mockups === 1 ? "" : "s"} · ${bytesText(usage.bytes)}</p>
<nav class="tabs">${tabLink("pages", "/", "Pages")}${tabLink("mockups", "/mockups", "Mockups")}</nav>
${body}
<script nonce="${nonce}">${SCRIPT}</script>
</html>
`;
}

function shareRender(link: { url: string; expiresAt: string | null }, nonce: string, now: number): string {
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Share link</title>
${FAVICON_LINK}
<style nonce="${nonce}">${CSS} .share { display: flex; gap: .5rem; } .share input { flex: 1; }</style>
<h1>Share link</h1>
<p class="usage">Opens the page without signing in${link.expiresAt ? ` for ${duration(Date.parse(link.expiresAt) - now)}` : ""}. Making the page public or private again revokes it.</p>
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

/** How long a failed thumbnail is remembered, so dashboard loads in between show a blank tile without starting a browser. */
const FAILURE_MEMORY = 10 * 60_000;

function placeholder(maxAge: number): Response {
	const cacheControl = maxAge > 0 ? `private, max-age=${Math.ceil(maxAge / 1000)}` : "no-store";
	return new Response(PLACEHOLDER, { headers: { "content-type": "image/svg+xml", "cache-control": cacheControl } });
}

/*
 * Making missing thumbnails. A dashboard load asks for each one in a request
 * of its own, and Browser Run allows only 3 browser launches a second, so the
 * requests of a load share browsers: one request (the owner) shoots up to
 * `BATCH_SIZE` queued thumbnails in one browser while the others wait.
 *
 * No request ever waits on a promise another request resolves: the runtime
 * cancels a request whose own context has nothing pending, as hung. So what
 * requests share is plain data (the queue, the outcomes, the lease), and each
 * waits in its own context on its own timer. Nothing shared is cleared by
 * whoever set it, either: the owner holds a lease it renews on a timer, and
 * every taken job carries the same deadline, so if the owner's request is
 * cancelled (its client went away; `waitUntil` would only give it 30 more
 * seconds, short of a batch) its timer stops, the lease lapses within
 * `LEASE`, and a waiting request takes over the jobs that are left.
 */
const BATCH_WINDOW = 150;
const BATCH_SIZE = 10;
/** This isolate starts a browser at most this often: Browser Run allows 3 launches a second per account. */
const LAUNCH_GAP = 400;
const LEASE = 3_000;
const HEARTBEAT = 1_000;
/** How long a request waits for its thumbnail before answering with a blank tile (not remembered, so the next load asks again). */
const WAIT = 60_000;
const POLL = 200;
/** How long a finished shot is kept for the requests waiting on it. */
const OUTCOME_LIFE = 60_000;

interface Job {
	page: Page;
	option: string | undefined;
	queuedAt: number;
	/** While an owner is shooting it; 0 when free. */
	takenUntil: number;
}

/** What became of a shot: a PNG, "failed", null when no browser could be had, undefined when the set has no such option. */
type Outcome = ShotResult | undefined;

const jobs = new Map<string, Job>();
const outcomes = new Map<string, { outcome: Outcome; at: number }>();
let lease = { owner: 0, until: 0 };
let owners = 0;
let nextLaunch = 0;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function forgetOld(now: number): void {
	for (const [key, { at }] of outcomes) if (now - at > OUTCOME_LIFE) outcomes.delete(key);
	for (const [key, job] of jobs) if (job.takenUntil <= now && now - job.queuedAt > WAIT) jobs.delete(key);
}

/** Queues a thumbnail of `page` (or of one of its options) and waits for it, shooting the queue itself when nobody else is. "timeout" if it took too long. */
async function waitForShot(env: Env, pages: Pages, page: Page, option: string | undefined): Promise<Outcome | "timeout"> {
	const key = JSON.stringify([page.id, page.version, option ?? null]);
	const deadline = Date.now() + WAIT;
	forgetOld(Date.now());
	// A browser that couldn't be had earlier may be had now; anything else that finished is what's kept.
	if (outcomes.get(key)?.outcome === null) outcomes.delete(key);
	if (!outcomes.has(key) && !jobs.has(key)) jobs.set(key, { page, option, queuedAt: Date.now(), takenUntil: 0 });
	while (Date.now() < deadline) {
		const done = outcomes.get(key);
		if (done) return done.outcome;
		const now = Date.now();
		if (lease.until <= now && [...jobs.values()].some((job) => job.takenUntil <= now)) await shoot(env, pages);
		else await sleep(POLL);
	}
	return "timeout";
}

/** Takes the lease and shoots up to `BATCH_SIZE` free jobs in one browser, keeping each shot (or its failure) in R2 as it comes. */
async function shoot(env: Env, pages: Pages): Promise<void> {
	const owner = ++owners;
	const ours = () => lease.owner === owner;
	lease = { owner, until: Date.now() + LEASE };
	const taken: [string, Job][] = [];
	const renew = () => {
		if (!ours()) return;
		lease.until = Date.now() + LEASE;
		for (const [, job] of taken) job.takenUntil = lease.until;
	};
	const heartbeat = setInterval(renew, HEARTBEAT);
	const finish = (key: string, outcome: Outcome) => {
		outcomes.set(key, { outcome, at: Date.now() });
		jobs.delete(key);
	};
	try {
		// Let the rest of the dashboard's requests queue, and keep to the launch rate.
		await sleep(Math.max(BATCH_WINDOW, nextLaunch - Date.now()));
		if (!ours()) return;
		nextLaunch = Date.now() + LAUNCH_GAP;
		const now = Date.now();
		for (const entry of jobs) {
			if (taken.length === BATCH_SIZE) break;
			if (entry[1].takenUntil <= now) taken.push(entry);
		}
		renew();
		// An option's URL needs its path, read once per set.
		const sets = new Map<string, Promise<MockupOption[]>>();
		const planned = await Promise.all(
			taken.map(async ([, job]): Promise<Shot | undefined> => {
				const url = await viewerUrl(env.EPHEMERA_TOKEN, env.PAGES_HOST, job.page, Date.now(), { ttl: THUMBNAIL_PASS });
				if (job.option === undefined) return { url, kind: "page" };
				let options = sets.get(job.page.id);
				if (!options) sets.set(job.page.id, (options = pages.options(job.page.id)));
				const found = (await options).find((option) => option.name === job.option);
				return found && { url: `${url}${found.path}`, kind: "option" };
			}),
		);
		const wanted = taken.flatMap(([key, job], i) => (planned[i] ? [{ key, job, shot: planned[i] }] : (finish(key, undefined), [])));
		if (!wanted.length) return;
		const keep = async (i: number, result: ShotResult) => {
			const { key, job } = wanted[i]!;
			if (!jobs.has(key)) return;
			try {
				if (result instanceof Uint8Array) await pages.files.saveThumbnail(job.page, result, job.option);
				else if (result === "failed") await pages.files.saveThumbnailFailure(job.page, Date.now(), job.option);
			} catch (error) {
				console.warn(`keeping the thumbnail of ${job.page.id} failed: ${error}`);
			}
			finish(key, result);
		};
		const results = await screenshots(
			env.BROWSER,
			wanted.map(({ shot }) => shot),
			keep,
		);
		// Any the browser didn't report one by one.
		for (const [i, result] of results.entries()) await keep(i, result);
	} finally {
		clearInterval(heartbeat);
		// Jobs left over (something threw) go back to the queue at once.
		for (const [key, job] of taken) if (jobs.get(key) === job) job.takenUntil = 0;
		if (ours()) lease = { owner: 0, until: 0 };
	}
}

/**
 * GET /thumbnails/<id>.png, and /thumbnails/<id>/<option>.png for an option
 * of a mockup set: the screenshot kept for the version being served, made on
 * first request. A failure is remembered for `FAILURE_MEMORY`; when no
 * browser could be had, or the shot took too long, the next load tries again.
 */
async function thumbnail(env: Env, pages: Pages, id: string, option?: string): Promise<Response> {
	const found = await pages.lookup(id);
	if (found.state !== "live" || (option !== undefined && found.page.kind !== "mockup")) return new Response("Not found", { status: 404 });
	const page = found.page;
	const headers = { "content-type": "image/png", "cache-control": "private, max-age=86400" };
	const kept = await pages.files.thumbnail(page, option);
	if (kept && "png" in kept) return new Response(kept.png.body, { headers });
	const remembered = kept ? kept.failedAt + FAILURE_MEMORY - Date.now() : 0;
	if (remembered > 0) return placeholder(remembered);

	const made = await waitForShot(env, pages, page, option);
	if (made === undefined) return new Response("Not found", { status: 404 });
	if (made instanceof Uint8Array) return new Response(made, { headers });
	return placeholder(made === "failed" ? FAILURE_MEMORY : 0);
}

const ACTIONS = new RegExp(`^/pages/(${ID_SOURCE})/(extend|permanent|temporary|delete|label|private|public|password|share|rollback|verdict)$`);

/** The admin dashboard on ADMIN_HOST. Only reachable through the Cloudflare Access app with audience ACCESS_AUD. */
export async function handleDashboard(request: Request, env: Env, ctx: ExecutionContext, pages: Pages): Promise<Response> {
	if (!ctx.access || ctx.access.aud !== env.ACCESS_AUD) return respond("Forbidden", 403);
	const identity = await ctx.access.getIdentity().catch(() => undefined);
	const user = String((identity as { email?: string } | undefined)?.email ?? "owner");
	const url = new URL(request.url);
	const ops = new Operations(pages, env.PAGES_HOST, env.EPHEMERA_TOKEN);

	if (request.method === "GET" && url.pathname === "/favicon.svg") return favicon();
	if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/mockups")) {
		const nonce = crypto.randomUUID().replaceAll("-", "");
		const [overview, csrf] = await Promise.all([ops.overview(), csrfToken(env.EPHEMERA_TOKEN, user)]);
		const tab = url.pathname === "/" ? "pages" : "mockups";
		return respond(render(tab, overview, env.PAGES_HOST, csrf, nonce, Date.now()), 200, nonce);
	}

	const thumb = new RegExp(`^/thumbnails/(${ID_SOURCE})\\.png$`).exec(url.pathname);
	if (request.method === "GET" && thumb) return thumbnail(env, pages, thumb[1]!);
	const optionThumb = new RegExp(`^/thumbnails/(${ID_SOURCE})/([^/]+)\\.png$`).exec(url.pathname);
	if (request.method === "GET" && optionThumb) {
		let option: string;
		try {
			option = decodeURIComponent(optionThumb[2]!);
		} catch {
			return new Response("Not found", { status: 404 });
		}
		return thumbnail(env, pages, optionThumb[1]!, option);
	}

	// Signing in to a private page: Access has checked who this is, so hand out a pass.
	const opening = new RegExp(`^/open/(${ID_SOURCE})(?:/(.*))?$`).exec(url.pathname);
	if (request.method === "GET" && opening) {
		const [, id, rest = ""] = opening as unknown as [string, string, string | undefined];
		const found = await pages.lookup(id);
		if (found.state !== "live") return respond(found.state === "gone" ? "This page has expired." : "Not found", found.state === "gone" ? 410 : 404);
		const page = found.page;
		const location = await viewerUrl(env.EPHEMERA_TOKEN, env.PAGES_HOST, page, Date.now(), { rest });
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
	try {
		switch (name) {
			case "extend": {
				const by = url.searchParams.get("by") ?? "";
				if (!EXTENSIONS.includes(by)) return respond("Unknown extension", 400);
				await ops.extend(id, by);
				break;
			}
			case "permanent":
				await ops.extend(id, "permanent");
				break;
			case "temporary":
				await ops.makeTemporary(id);
				break;
			case "label":
				await ops.setLabel(id, String(form.get("label") ?? ""));
				break;
			case "private":
			case "public":
				// No password given: a private page keeps the one it has.
				await ops.setVisibility(id, name, undefined);
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
				await ops.delete(id);
				break;
			case "verdict": {
				// No verdict (the save button) keeps the verdict there is now.
				const verdict = form.get("verdict") === null ? undefined : String(form.get("verdict"));
				const typed = String(form.get("note") ?? "");
				const was = form.get("note_was");
				// A note left as it loaded keeps whatever the note is now.
				const note = was !== null && typed === String(was) ? undefined : typed;
				if (verdict !== undefined || note !== undefined) await ops.setVerdict(id, String(form.get("option") ?? ""), verdict, note);
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
