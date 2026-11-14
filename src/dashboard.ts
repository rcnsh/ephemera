import { checkCsrf, csrfToken } from "./auth.ts";
import { bytesText, PageError, pageUrl } from "./domain.ts";
import { FAVICON_LINK, favicon, mark } from "./logo.ts";
import { type MockupOption, VERDICTS } from "./mockups.ts";
import { Operations, type Overview } from "./operations.ts";
import { ID_PATTERN, ID_SOURCE, type Page, type Pages, type Version } from "./pages.ts";
import { viewerUrl } from "./privacy.ts";
import { screenshot, screenshotOptions } from "./thumbnails.ts";

/** What the dashboard's extend buttons add, as ttls. */
const EXTENSIONS = ["1h", "1d", "7d"];
const SHARES = ["1d", "7d", "30d"];

/** How long the pass the screenshot browser opens a private page with lasts. */
const THUMBNAIL_PASS = 5 * 60_000;

/** Under this much time left, a page's expiry is highlighted. */
const SOON = 60 * 60_000;

/** How the Pages tab can be ordered; the first is the default. */
const SORTS = { newest: "newest", expiring: "expiring soonest", largest: "largest" } as const;
type Sort = keyof typeof SORTS;

/**
 * Sent by the dashboard's script with an action it posts itself: the answer
 * is then the affected card's new HTML (or 204 once it's gone, or the error as
 * text), not a redirect.
 */
const FRAGMENT_HEADER = "x-ephemera-fragment";

/** Most pages one bulk action takes. */
const BULK_LIMIT = 500;

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

// Text colours are at least 4.5:1 on every background they sit on, in both
// themes (checked against #fff, #fafafa, #eee, and #161616, #1e1e1e, #2a2a2a).
const CSS = `
:root { color-scheme: light dark; }
body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem auto; max-width: 80rem; padding: 0 1rem; color: #222; background: #fafafa; }
h1 { font-size: 1.1rem; margin: 0 0 .25rem; display: flex; align-items: center; gap: .4rem; }
h1 .logo { width: 1.25em; height: 1.25em; }
.usage { color: #666; margin: 0 0 1rem; }
.filters { display: flex; flex-wrap: wrap; gap: .5rem; margin: 0 0 .5rem; }
.filters input { flex: 1 1 12rem; }
.count { color: #666; margin: 0 0 1rem; }
input, select, button { font: inherit; color: inherit; }
input, select { background: #fff; border: 1px solid #bbb; border-radius: 3px; padding: .1rem .4rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(20rem, 100%), 1fr)); gap: 1rem; }
.card { border: 1px solid #ddd; border-radius: 6px; background: #fff; overflow: hidden; display: flex; flex-direction: column; }
.card:has(.select:checked), .set:has(.select:checked) { outline: 2px solid #0645ad; outline-offset: -1px; }
.busy { opacity: .6; cursor: progress; }
.busy * { pointer-events: none; }
.error { color: #b00; margin: 0; }
.thumb { display: block; aspect-ratio: 16 / 10; background: #eee; }
.thumb img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
.body { padding: .6rem .75rem .75rem; display: flex; flex-direction: column; gap: .4rem; }
.label { display: flex; gap: .3rem; align-items: center; }
.label input[name=label] { flex: 1; min-width: 0; font-weight: 600; border-color: transparent; padding-left: 0; background: transparent; }
.label input[name=label]:hover, .label input[name=label]:focus { border-color: #bbb; padding-left: .4rem; }
.meta { color: #666; margin: 0; overflow-wrap: anywhere; }
.badge { display: inline-block; border: 1px solid #bbb; border-radius: 3px; padding: 0 .3rem; font-size: .85em; }
.badge.private { border-color: #8a5300; color: #8a5300; }
.expiry.soon { color: #8a5300; font-weight: 600; }
.expiry.expired { color: #b00; font-weight: 600; }
.actions { display: flex; flex-wrap: wrap; gap: .3rem; align-items: flex-start; }
form { display: inline; margin: 0; }
button { cursor: pointer; background: none; border: 1px solid #bbb; border-radius: 3px; padding: 0 .4rem; }
button:hover { background: #eee; }
button:disabled { cursor: progress; }
details > summary { cursor: pointer; color: #666; }
details ul { margin: .3rem 0 0; padding-left: 1.2rem; }
.danger, details.delete > summary, details.confirm > summary { border-color: #b00; color: #b00; }
details.confirm > summary { display: inline-block; border: 1px solid; border-radius: 3px; padding: 0 .4rem; list-style: none; }
details.confirm > summary::-webkit-details-marker { display: none; }
.muted { color: #6b6b6b; }
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
.option.picked { border-color: #17702f; background: #1a7f3712; }
.option.rejected .shot { opacity: .45; }
.shot { display: block; height: 16rem; background: #eee; border-radius: 3px; overflow: hidden; }
.shot img { display: block; width: 100%; height: 100%; object-fit: contain; object-position: top; }
.option figcaption { font-weight: 600; overflow-wrap: anywhere; }
.verdict { display: flex; flex-wrap: wrap; gap: .25rem; }
.verdict input[name=note] { width: 100%; }
.badge.picked { border-color: #17702f; color: #17702f; }
.badge.rejected { border-color: #b00; color: #b00; }
.bulk { display: none; position: sticky; bottom: 0; z-index: 1; margin: 1rem 0 0; padding: .5rem .75rem; flex-wrap: wrap; align-items: center; gap: .5rem; background: #fff; border: 1px solid #bbb; border-radius: 6px; box-shadow: 0 -2px 12px rgb(0 0 0 / .08); }
body:has(.select:checked) .bulk, .bulk.active { display: flex; }
.bulk .n { font-weight: 600; margin-right: auto; }
.share { display: flex; flex-wrap: wrap; gap: .5rem; } .share input { flex: 1 1 16rem; min-width: 0; }
@media (pointer: coarse) {
	button, select, input:not([type=checkbox]) { min-height: 44px; }
	button { padding: 0 .8rem; }
	details > summary { padding: .6rem 0; }
	details.confirm > summary { padding: .6rem .8rem; }
	input[type=checkbox] { width: 24px; height: 24px; }
	.actions, .verdict { gap: .5rem; }
}
@media (prefers-color-scheme: dark) {
	body { color: #ddd; background: #161616; }
	.card, .set, .bulk { background: #1e1e1e; border-color: #333; }
	.set .meta strong { color: #ddd; }
	.thumb, .shot { background: #2a2a2a; }
	input, select { background: #1e1e1e; border-color: #555; }
	button { border-color: #555; }
	button:hover { background: #2a2a2a; }
	a { color: #8ab4f8; }
	.usage, .count, .meta, details > summary, .tabs a, .muted { color: #a3a3a3; }
	.danger, details.delete > summary, details.confirm > summary, .badge.rejected, .error, .expiry.expired { border-color: #ff7b72; color: #ff7b72; }
	.badge.private { border-color: #e3a33b; color: #e3a33b; }
	.expiry.soon { color: #e3a33b; }
	.option.picked, .badge.picked { border-color: #4ac26b; }
	.badge.picked { color: #4ac26b; }
	.card:has(.select:checked), .set:has(.select:checked) { outline-color: #8ab4f8; }
}
`;

// Event delegation throughout, so cards swapped in after an action work
// without rebinding. No template literals inside: this is one already.
const SCRIPT = `
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const items = () => $$(".card, .set");

for (const button of $$("[data-share]")) if (navigator.share) button.hidden = false;
for (const button of $$(".bulk [hidden]")) button.hidden = false;

document.addEventListener("click", async (event) => {
	const copy = event.target.closest("[data-copy]");
	if (copy) {
		try {
			await navigator.clipboard.writeText(copy.dataset.copy);
			copy.textContent = "copied";
		} catch {
			copy.textContent = "copy failed";
			copy.closest(".share")?.querySelector("input")?.select();
		}
		setTimeout(() => (copy.textContent = "copy"), 2000);
		return;
	}
	const share = event.target.closest("[data-share]");
	if (share) navigator.share({ url: share.dataset.share }).catch(() => {});
	const all = event.target.closest(".bulk .all");
	if (all || event.target.closest(".bulk .none-selected")) {
		for (const box of $$(".select")) box.checked = !!all && !box.closest(".hidden");
		updateBulk();
	}
});

// Expiry counts down in place, every minute.
function duration(ms) {
	const minutes = Math.max(0, Math.round(ms / 60000));
	if (minutes < 60) return minutes + "m";
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return hours + "h " + (minutes % 60) + "m";
	return Math.floor(hours / 24) + "d " + (hours % 24) + "h";
}
function tick() {
	const now = Date.now();
	// .expiry only: cards carry data-expires too, for sorting.
	for (const el of $$(".expiry[data-expires]")) {
		const left = Number(el.dataset.expires) - now;
		el.textContent = left > 0 ? "expires in " + duration(left) : "expired";
		el.classList.toggle("soon", left > 0 && left < ${SOON});
		el.classList.toggle("expired", left <= 0);
	}
}
setInterval(tick, 60000);

// Filtering, sorting, and keeping both in the URL so a reload or a link keeps them.
const search = $("#search");
const agent = $("#agent");
const verdict = $("#verdict");
const sort = $("#sort");
function filter() {
	if (!search) return;
	const words = search.value.toLowerCase().split(/\\s+/).filter(Boolean);
	for (const card of items()) {
		const text = card.dataset.search;
		const shown =
			words.every((word) => text.includes(word)) &&
			(!agent || !agent.value || card.dataset.agent === agent.value) &&
			(!verdict || !verdict.value || card.dataset.verdicts.split(" ").includes(verdict.value));
		card.classList.toggle("hidden", !shown);
		// Bulk actions only ever touch cards in view.
		if (!shown) for (const box of $$(".select", card)) box.checked = false;
	}
	for (const project of $$(".project")) {
		project.classList.toggle("hidden", !project.querySelector(".set:not(.hidden)"));
	}
	const total = items().length;
	const shown = items().filter((card) => !card.classList.contains("hidden")).length;
	const noun = $(".set") ? "set" : "page";
	$("#count").textContent = shown === total ? total + " " + noun + (total === 1 ? "" : "s") : shown + " of " + total + " " + noun + (total === 1 ? "" : "s");
	$("#none").hidden = shown > 0 || total === 0;
	updateBulk();
}
function order() {
	const grid = $(".grid");
	if (!sort || !grid) return;
	const number = (card, key) => Number(card.dataset[key] || 0);
	const compare = {
		newest: (a, b) => number(b, "updated") - number(a, "updated"),
		expiring: (a, b) => (!a.dataset.expires - !b.dataset.expires) || number(a, "expires") - number(b, "expires") || number(b, "updated") - number(a, "updated"),
		largest: (a, b) => number(b, "size") - number(a, "size"),
	}[sort.value];
	for (const card of [...grid.children].sort(compare)) grid.append(card);
}
function remember() {
	const params = new URLSearchParams();
	if (search.value.trim()) params.set("q", search.value.trim());
	if (agent?.value) params.set("agent", agent.value);
	if (verdict?.value) params.set("verdict", verdict.value);
	if (sort && sort.selectedIndex > 0) params.set("sort", sort.value);
	const query = params.toString();
	history.replaceState(null, "", location.pathname + (query ? "?" + query : ""));
}
const changed = () => { filter(); remember(); };
search?.addEventListener("input", changed);
agent?.addEventListener("change", changed);
verdict?.addEventListener("change", changed);
sort?.addEventListener("change", () => { order(); remember(); });
$(".filters")?.addEventListener("submit", (event) => event.preventDefault());

// The bulk bar counts what's selected; CSS shows it.
const bulk = $("#bulk");
function updateBulk() {
	if (!bulk) return;
	const n = $$(".select:checked").length;
	bulk.classList.toggle("active", n > 0);
	$(".n", bulk).textContent = n + " selected";
}
document.addEventListener("change", (event) => event.target.matches(".select") && updateBulk());

// Actions post in the background and swap in the card's new HTML, so the
// page keeps its place. Share links still open a page of their own.
function showError(where, message) {
	const p = document.createElement("p");
	p.className = "error";
	p.setAttribute("role", "alert");
	p.textContent = message;
	(where.querySelector(".body") || where).append(p);
}
function swap(item, html) {
	const focused = item.contains(document.activeElement) ? document.activeElement.closest("form")?.getAttribute("action") : null;
	const kept = new Set($$("details[open][data-keep]", item).map((d) => d.dataset.keep));
	const selected = $(".select", item)?.checked;
	const template = document.createElement("template");
	template.innerHTML = html;
	const next = template.content.firstElementChild;
	for (const d of $$("details[data-keep]", next)) d.open = kept.has(d.dataset.keep);
	if (selected && $(".select", next)) $(".select", next).checked = true;
	item.replaceWith(next);
	const target = focused && $$("form", next).find((form) => form.getAttribute("action") === focused);
	(target?.querySelector("button, input:not([type=hidden])") || next).focus({ preventScroll: true });
	return next;
}
function remove(item) {
	const after = item.nextElementSibling || item.previousElementSibling;
	const project = item.closest(".project");
	item.remove();
	if (project && !project.querySelector(".set")) project.remove();
	(after?.matches(".card, .set") ? after : $("h1")).focus({ preventScroll: true });
}
async function post(form, submitter) {
	const body = new FormData(form);
	if (submitter?.name) body.append(submitter.name, submitter.value);
	const response = await fetch(form.action, { method: "POST", body, headers: { "${FRAGMENT_HEADER}": "1" } }).catch(() => {
		throw new Error("Couldn't reach the dashboard. Check the connection and try again.");
	});
	const text = await response.text();
	if (!response.ok) throw new Error(text.trim() || "That didn't work (" + response.status + ")");
	return { body, text, status: response.status };
}
document.addEventListener("submit", async (event) => {
	const form = event.target;
	if (form.method !== "post" || new URL(form.action).pathname.endsWith("/share")) return;
	event.preventDefault();
	const item = form.closest(".card, .set");
	const busy = item || form;
	if (busy.classList.contains("busy")) return;
	for (const old of $$(".error", busy)) old.remove();
	const submitter = event.submitter;
	busy.classList.add("busy");
	busy.setAttribute("aria-busy", "true");
	if (submitter) submitter.disabled = true;
	try {
		const { body, text, status } = await post(form, submitter);
		// Not form.id: the bulk form's checkboxes are named "id", which shadows it.
		if (form.getAttribute("id") === "bulk") {
			const template = document.createElement("template");
			template.innerHTML = text;
			for (const id of body.getAll("id")) {
				const card = document.getElementById("p-" + id);
				if (!card) continue;
				const fresh = template.content.getElementById("p-" + id);
				const failed = template.content.querySelector('[data-error-for="' + id + '"]');
				if (fresh) swap(card, fresh.outerHTML);
				else if (failed) showError(card, failed.textContent);
				else remove(card);
			}
			for (const box of $$(".select")) box.checked = false;
			form.querySelector("details")?.removeAttribute("open");
		} else if (status === 204) remove(item);
		else swap(item, text);
		// Not re-sorted: an action changes updatedAt, and the card should stay where you are.
		filter();
		tick();
		for (const button of $$("[data-share]")) if (navigator.share) button.hidden = false;
	} catch (error) {
		showError(busy, error.message);
	} finally {
		busy.classList.remove("busy");
		busy.removeAttribute("aria-busy");
		if (submitter?.isConnected) submitter.disabled = false;
	}
});

filter();
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
	return `<details data-keep="versions"><summary>${versions.length} versions</summary><ul>${items}</ul></details>`;
}

function passwordForm(page: Page, csrf: string): string {
	if (page.visibility !== "private") return "";
	const remove = page.passwordHash ? ` ${action(page, csrf, "password", "remove password")}` : "";
	return `<details><summary>${page.passwordHash ? "change password" : "set a password"}</summary>
<form method="post" action="/pages/${page.id}/password">${hidden(page, csrf)}<input type="password" name="password" minlength="8" required autocomplete="new-password" placeholder="8+ characters" aria-label="New password for ${escape(page.label ?? page.id)}"> <button>set</button></form>${remove}
</details>`;
}

/** Text a card is searched by, lower case. */
function pageSearch(page: Page): string {
	return [page.label, page.id, page.agent].filter(Boolean).join(" ").toLowerCase();
}

function setSearch(page: Page, options: MockupOption[]): string {
	return [page.label, page.id, page.project, ...options.map((option) => `${option.name} ${option.note ?? ""}`)].filter(Boolean).join(" ").toLowerCase();
}

/** "expires in 3h 2m", counted down by the script; highlighted with under an hour left. */
function expiry(page: Page, now: number): string {
	if (page.permanent) return "never expires";
	const left = page.expiresAt! - now;
	return `<span class="expiry${left <= 0 ? " expired" : left < SOON ? " soon" : ""}" data-expires="${page.expiresAt}">${left > 0 ? `expires in ${duration(left)}` : "expired"}</span>`;
}

/** Extend, make permanent, or make temporary. */
function lifetime(page: Page, csrf: string): string {
	if (page.permanent) return action(page, csrf, "temporary", "make temporary");
	return `${EXTENSIONS.map((by) => action(page, csrf, `extend?by=${by}`, `+${by}`)).join("")}${action(page, csrf, "permanent", "make permanent")}`;
}

/** Make private, or make public behind a confirmation: it revokes every share link. */
function visibilityAction(page: Page, csrf: string): string {
	if (page.visibility !== "private") return action(page, csrf, "private", "make private");
	return `<details class="confirm"><summary>make public</summary> <span class="muted">revokes every share link</span> ${action(page, csrf, "public", "really make public", "danger")}</details>`;
}

function shareLinks(page: Page, csrf: string): string {
	if (page.visibility !== "private") return "";
	return `<details data-keep="share"><summary>share link</summary>${SHARES.map((ttl) => action(page, csrf, `share?ttl=${ttl}`, ttl)).join(" ")}</details>`;
}

/** The rename form, with the checkbox that selects the page for bulk actions. */
function labelForm(page: Page, csrf: string): string {
	const name = escape(page.label ?? page.id);
	return `<form class="label" method="post" action="/pages/${page.id}/label"><input type="checkbox" class="select" form="bulk" name="id" value="${page.id}" aria-label="Select ${name}">${hidden(page, csrf)}<input name="label" value="${escape(page.label ?? "")}" placeholder="untitled" maxlength="200" aria-label="Label for ${page.id}"><button>save</button></form>`;
}

function card(page: Page, versions: Version[], host: string, csrf: string, now: number, shown = true): string {
	const url = pageUrl(host, page.id);
	const open = page.visibility === "private" ? `/open/${page.id}/` : url;
	const badges = [
		page.visibility === "private" ? `<span class="badge private">private${page.passwordHash ? " · password" : ""}</span>` : "",
		page.permanent ? '<span class="badge">permanent</span>' : "",
	].join(" ");
	return `<article class="card${shown ? "" : " hidden"}" id="p-${page.id}" tabindex="-1" data-search="${escape(pageSearch(page))}" data-agent="${escape(page.agent ?? "")}" data-updated="${page.updatedAt}" data-expires="${page.expiresAt ?? ""}" data-size="${page.size}">
<a class="thumb" href="${open}" target="_blank" rel="noopener noreferrer"><img src="/thumbnails/${page.id}.png?v=${page.version}" loading="lazy" alt=""></a>
<div class="body">
${labelForm(page, csrf)}
<p class="meta">${page.agent ? escape(page.agent) : '<span class="muted">no agent</span>'} · <a href="${open}" target="_blank" rel="noopener noreferrer">${page.id}</a> <button type="button" data-copy="${url}">copy</button></p>
<p class="meta">${duration(now - page.createdAt)} old · ${expiry(page, now)} · ${bytesText(page.size)} · ${page.fileCount} file${page.fileCount === 1 ? "" : "s"} · v${page.version} ${badges}</p>
<div class="actions">${lifetime(page, csrf)}${visibilityAction(page, csrf)}</div>
${shareLinks(page, csrf)}
${passwordForm(page, csrf)}
${versionList(page, versions, csrf, now)}
<details class="delete"><summary>delete</summary> ${action(page, csrf, "delete", "really delete", "danger")}</details>
</div>
</article>`;
}

function optionFigure(page: Page, option: MockupOption, open: string, csrf: string): string {
	const buttons = (["picked", "rejected", "pending"] as const)
		.filter((verdict) => verdict !== option.verdict)
		.map((verdict) => `<button name="verdict" value="${verdict}">${{ picked: "pick", rejected: "reject", pending: "undecide" }[verdict]}</button>`)
		.join("");
	const badge = option.verdict === "pending" ? "" : ` <span class="badge ${option.verdict}">${option.verdict}</span>`;
	return `<figure class="option ${option.verdict}">
<a class="shot" href="${open}${option.path}" target="_blank" rel="noopener noreferrer"><img src="/thumbnails/${page.id}/${encodeURIComponent(option.name)}.png?v=${page.version}" loading="lazy" alt=""></a>
<figcaption>${escape(option.name)}${badge}</figcaption>
<form class="verdict" method="post" action="/pages/${page.id}/verdict">${hidden(page, csrf)}<input type="hidden" name="option" value="${escape(option.name)}"><input name="note" value="${escape(option.note ?? "")}" placeholder="note" maxlength="200" aria-label="Note on ${escape(option.name)}">${buttons}</form>
</figure>`;
}

/**
 * Where an option's thumbnail links, relative to the set's URL: the gallery's
 * full-size view of it (`#option=<name>`, which survives the /open/ redirect),
 * or, when the set has a root index.html of its own and so no gallery, the
 * option itself.
 */
function shotTarget(option: MockupOption, ownIndex: boolean): MockupOption {
	return ownIndex ? option : { ...option, path: `#option=${encodeURIComponent(option.name)}` };
}

function mockupSet(page: Page, options: MockupOption[], versions: Version[], host: string, csrf: string, now: number, ownIndex = false, shown = true): string {
	const url = pageUrl(host, page.id);
	const open = page.visibility === "private" ? `/open/${page.id}/` : url;
	const badges = [
		page.visibility === "private" ? `<span class="badge private">private${page.passwordHash ? " · password" : ""}</span>` : "",
		page.permanent ? "" : `<span class="badge">${expiry(page, now)}</span>`,
	].join(" ");
	const verdicts = [...new Set(options.map((option) => option.verdict))].join(" ");
	return `<article class="set${shown ? "" : " hidden"}" id="p-${page.id}" tabindex="-1" data-search="${escape(setSearch(page, options))}" data-verdicts="${verdicts}">
${labelForm(page, csrf)}
<p class="meta"><a href="${open}" target="_blank" rel="noopener noreferrer">${page.id}</a> <button type="button" data-copy="${url}">copy</button> · ${duration(now - page.createdAt)} old · ${bytesText(page.size)} · v${page.version} ${badges}</p>
<div class="options">
${options.map((option) => optionFigure(page, shotTarget(option, ownIndex), open, csrf)).join("\n")}
</div>
<div class="actions">${lifetime(page, csrf)}${visibilityAction(page, csrf)}</div>
${shareLinks(page, csrf)}
${passwordForm(page, csrf)}
${versionList(page, versions, csrf, now)}
<details class="delete"><summary>delete</summary> ${action(page, csrf, "delete", "really delete", "danger")}</details>
</article>`;
}

/** What the dashboard's URL asks to see: `?q=`, `?agent=`, `?verdict=` and `?sort=`. */
interface View {
	q: string;
	agent: string;
	verdict: string;
	sort: Sort;
}

function viewOf(url: URL): View {
	const sort = url.searchParams.get("sort") ?? "";
	return {
		q: url.searchParams.get("q") ?? "",
		agent: url.searchParams.get("agent") ?? "",
		verdict: url.searchParams.get("verdict") ?? "",
		sort: sort in SORTS ? (sort as Sort) : "newest",
	};
}

function matches(text: string, q: string): boolean {
	return q
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((word) => text.includes(word));
}

/** The Pages tab's order. The store's own order (soonest to expire first) is the API's, and stays as it is. */
function sortPages(pages: Page[], sort: Sort): Page[] {
	const newest = (a: Page, b: Page) => b.updatedAt - a.updatedAt;
	const compare = {
		newest,
		expiring: (a: Page, b: Page) => Number(a.permanent) - Number(b.permanent) || (a.expiresAt ?? 0) - (b.expiresAt ?? 0) || newest(a, b),
		largest: (a: Page, b: Page) => b.size - a.size || newest(a, b),
	}[sort];
	return [...pages].sort(compare);
}

/** Mockup sets by project, newest first; projects ordered by their newest set. */
function mockupSets(sets: Page[], options: Map<string, MockupOption[]>, versions: Map<string, Version[]>, host: string, csrf: string, now: number, ownIndex: Set<string>, view: View): string {
	const byProject = new Map<string, Page[]>();
	for (const page of [...sets].sort((a, b) => b.createdAt - a.createdAt)) {
		const project = page.project ?? "";
		byProject.set(project, [...(byProject.get(project) ?? []), page]);
	}
	return [...byProject]
		.map(([project, pages]) => {
			const rendered = pages.map((page) => {
				const opts = options.get(page.id) ?? [];
				const shown = matches(setSearch(page, opts), view.q) && (!view.verdict || opts.some((option) => option.verdict === view.verdict));
				return { shown, html: mockupSet(page, opts, versions.get(page.id) ?? [], host, csrf, now, ownIndex.has(page.id), shown) };
			});
			return `<section class="project${rendered.some((set) => set.shown) ? "" : " hidden"}">
<h2>${project ? escape(project) : '<span class="muted">no project</span>'}</h2>
${rendered.map((set) => set.html).join("\n")}
</section>`;
		})
		.join("\n");
}

/** Which mockup sets have a root index.html of their own, and so show it instead of the gallery. */
async function setsWithOwnIndex(pages: Pages, sets: Page[], options: Map<string, MockupOption[]>): Promise<Set<string>> {
	const own = await Promise.all(sets.map((page) => hasOwnIndex(pages, page, options.get(page.id) ?? [])));
	return new Set(sets.filter((_, i) => own[i]).map((page) => page.id));
}

async function hasOwnIndex(pages: Pages, page: Page, options: MockupOption[]): Promise<boolean> {
	// A set that is just a root index.html has it as its one option.
	if (options.some((option) => option.path === "")) return true;
	return pages.files.exists(page, "index.html");
}

/** "3 of 24 pages", or "24 pages" when nothing is filtered out. */
function countText(shown: number, total: number, noun: string): string {
	const nouns = `${noun}${total === 1 ? "" : "s"}`;
	return shown === total ? `${total} ${nouns}` : `${shown} of ${total} ${nouns}`;
}

/** The bar that acts on the selected cards; shown once one is selected. */
function bulkBar(csrf: string, back: string): string {
	return `<form id="bulk" class="bulk" method="post" action="/bulk" aria-label="Selected pages"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="back" value="${back}">
<span class="n" aria-live="polite">selected</span>
<button type="button" class="all" hidden>select all shown</button><button type="button" class="none-selected" hidden>clear</button>
<button name="do" value="temporary">make temporary</button>
<details class="delete"><summary>delete</summary> <button name="do" value="delete" class="danger">really delete selected</button></details>
</form>`;
}

type Tab = "pages" | "mockups";

function selectOption(value: string, label: string, selected: boolean): string {
	return `<option value="${escape(value)}"${selected ? " selected" : ""}>${escape(label)}</option>`;
}

/** The dashboard's HTML shell around `body`. */
function shell(title: string, body: string, nonce: string): string {
	return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
${FAVICON_LINK}
<style nonce="${nonce}">${CSS}</style>
${body}
<script nonce="${nonce}">${SCRIPT}</script>
</html>
`;
}

function render(tab: Tab, { pages: all, versions, options, usage }: Overview, host: string, csrf: string, nonce: string, now: number, view: View, ownIndex: Set<string>): string {
	let body: string;
	if (tab === "pages") {
		const pages = sortPages(
			all.filter((page) => page.kind === "page"),
			view.sort,
		);
		const agents = [...new Set(pages.map((page) => page.agent).filter((agent): agent is string => !!agent))].sort();
		const shown = (page: Page) => matches(pageSearch(page), view.q) && (!view.agent || page.agent === view.agent);
		const visible = pages.filter(shown).length;
		const cards = pages.map((page) => card(page, versions.get(page.id) ?? [], host, csrf, now, shown(page))).join("\n");
		body = pages.length
			? `<form class="filters" method="get" role="search"><input type="search" id="search" name="q" value="${escape(view.q)}" placeholder="Search labels, ids, agents" aria-label="Search pages">
<select id="agent" name="agent" aria-label="Agent"><option value="">all agents</option>${agents.map((agent) => (agent === view.agent ? selectOption(agent, agent, true) : `<option>${escape(agent)}</option>`)).join("")}</select>
<select id="sort" name="sort" aria-label="Sort by">${Object.entries(SORTS).map(([value, label]) => selectOption(value, label, value === view.sort)).join("")}</select>
<noscript><button>apply</button></noscript></form>
<p class="count" id="count" aria-live="polite">${countText(visible, pages.length, "page")}</p>
<p class="none" id="none"${visible ? " hidden" : ""}>No pages match. <a href="/">Show all</a></p>
<div class="grid">
${cards}
</div>
${bulkBar(csrf, "/")}`
			: '<p class="muted">No live pages.</p>';
	} else {
		const sets = all.filter((page) => page.kind === "mockup");
		const visible = sets.filter((page) => {
			const opts = options.get(page.id) ?? [];
			return matches(setSearch(page, opts), view.q) && (!view.verdict || opts.some((option) => option.verdict === view.verdict));
		}).length;
		body = sets.length
			? `<form class="filters" method="get" role="search"><input type="search" id="search" name="q" value="${escape(view.q)}" placeholder="Search projects, names, options, notes" aria-label="Search mockup sets">
<select id="verdict" name="verdict" aria-label="Verdict"><option value="">any verdict</option>${VERDICTS.map((verdict) => selectOption(verdict, `has ${verdict}`, verdict === view.verdict)).join("")}</select>
<noscript><button>apply</button></noscript></form>
<p class="count" id="count" aria-live="polite">${countText(visible, sets.length, "set")}</p>
<p class="none" id="none"${visible ? " hidden" : ""}>No mockup sets match. <a href="/mockups">Show all</a></p>
${mockupSets(sets, options, versions, host, csrf, now, ownIndex, view)}
${bulkBar(csrf, "/mockups")}`
			: '<p class="muted">No mockup sets yet. Agents publish them with publish_mockup.</p>';
	}
	const tabLink = (name: Tab, href: string, label: string) => `<a href="${href}"${tab === name ? ' class="current" aria-current="page"' : ""}>${label}</a>`;
	return shell(
		`ephemera${tab === "mockups" ? " · mockups" : ""}`,
		`<h1 tabindex="-1">${mark("logo", 7, 'class="logo"')}ephemera</h1>
<p class="usage">${usage.permanentPages} kept · ${usage.temporaryPages} expiring · ${usage.mockups} mockup set${usage.mockups === 1 ? "" : "s"} · ${bytesText(usage.bytes)}</p>
<nav class="tabs">${tabLink("pages", "/", "Pages")}${tabLink("mockups", "/mockups", "Mockups")}</nav>
${body}`,
		nonce,
	);
}

function shareRender(link: { url: string; expiresAt: number | null }, back: string, nonce: string, now: number): string {
	return shell(
		"Share link",
		`<h1>Share link</h1>
<p class="usage">Opens the page without signing in${link.expiresAt ? ` for ${duration(link.expiresAt - now)}` : ""}. Making the page public or private again revokes it.</p>
<p class="share"><input readonly value="${escape(link.url)}" aria-label="Share link"> <button type="button" data-copy="${escape(link.url)}">copy</button> <button type="button" data-share="${escape(link.url)}" hidden>share</button></p>
<p><a href="${escape(back)}">back</a></p>`,
		nonce,
	);
}

function respond(body: string, status: number, nonce = ""): Response {
	return new Response(body, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": `default-src 'none'; img-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
			// Not no-referrer: under that, browsers send `Origin: null` with the
			// dashboard's own form posts, and the origin check refuses them.
			// same-origin still sends nothing to pages on PAGES_HOST.
			"referrer-policy": "same-origin",
			"x-content-type-options": "nosniff",
		},
	});
}

/** A whole page for an error, in the dashboard's shell, with a way back. */
function errorPage(message: string, status: number, back = "/"): Response {
	const nonce = crypto.randomUUID().replaceAll("-", "");
	return respond(shell("ephemera", `<h1>${escape(message)}</h1>\n<p><a href="${escape(back)}">back</a></p>`, nonce), status, nonce);
}

const PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#888" fill-opacity=".15"/></svg>`;

/** GET /thumbnails/<id>.png: the cached screenshot for the version being served, made on first request. */
async function thumbnail(env: Env, ctx: ExecutionContext, pages: Pages, id: string): Promise<Response> {
	const found = await pages.lookup(id);
	if (found.state !== "live") return new Response("Not found", { status: 404 });
	const page = found.page;
	const cached = await pages.files.thumbnail(page);
	const headers = { "content-type": "image/png", "cache-control": "private, max-age=86400" };
	if (cached) return new Response(cached.body, { headers });

	const url = await viewerUrl(env.EPHEMERA_TOKEN, env.PAGES_HOST, page, Date.now(), { ttl: THUMBNAIL_PASS });
	const png = await screenshot(env.BROWSER, url);
	// Not cached, so the next dashboard load tries again.
	if (!png) return new Response(PLACEHOLDER, { headers: { "content-type": "image/svg+xml", "cache-control": "no-store" } });
	ctx.waitUntil(pages.files.saveThumbnail(page, png));
	return new Response(png, { headers });
}

/** Option thumbnails being made, by set and version, so the dashboard's requests for one set's options share a browser. */
const shooting = new Map<string, Promise<Map<string, Uint8Array | null>>>();

/** Shoots every option of a mockup set in one browser launch, and keeps the ones that worked. */
async function shootOptions(env: Env, ctx: ExecutionContext, pages: Pages, page: Page): Promise<Map<string, Uint8Array | null>> {
	const options = await pages.options(page.id);
	// One URL (and pass) for the set; option paths are relative to it.
	const set = await viewerUrl(env.EPHEMERA_TOKEN, env.PAGES_HOST, page, Date.now(), { ttl: THUMBNAIL_PASS });
	const urls = options.map((option) => `${set}${option.path}`);
	const pngs = await screenshotOptions(env.BROWSER, urls);
	const shots = new Map(options.map((option, i) => [option.name, pngs[i] ?? null]));
	for (const [option, png] of shots) if (png) ctx.waitUntil(pages.files.saveThumbnail(page, png, option));
	return shots;
}

/** GET /thumbnails/<id>/<option>.png: like `thumbnail`, for one option of a mockup set. */
async function optionThumbnail(env: Env, ctx: ExecutionContext, pages: Pages, id: string, option: string): Promise<Response> {
	const found = await pages.lookup(id);
	if (found.state !== "live" || found.page.kind !== "mockup") return new Response("Not found", { status: 404 });
	const page = found.page;
	const cached = await pages.files.thumbnail(page, option);
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

/**
 * Where an action that redirects comes back to: the tab it was sent from,
 * search and sort included, so the dashboard looks as it did. Taken from the
 * Referer when it's one of the dashboard's tabs, else the form's `back`.
 */
function backTo(request: Request, form: FormData, adminHost: string): string {
	const origin = `https://${adminHost}`;
	for (const candidate of [request.headers.get("referer"), form.get("back")]) {
		if (typeof candidate !== "string" || !candidate) continue;
		try {
			const url = new URL(candidate, origin);
			if (url.origin === origin && (url.pathname === "/" || url.pathname === "/mockups")) return url.pathname + url.search;
		} catch {
			// Not a URL: try the next.
		}
	}
	return "/";
}

/** One page's card (or mockup set) as it is now, for the script to swap in. */
async function renderOne(pages: Pages, host: string, csrf: string, id: string, now: number): Promise<string> {
	const page = await pages.get(id);
	const [versions, options] = await Promise.all([pages.versions(id), page.kind === "mockup" ? pages.options(id) : Promise.resolve([])]);
	if (page.kind === "mockup") return mockupSet(page, options, versions, host, csrf, now, await hasOwnIndex(pages, page, options));
	return card(page, versions, host, csrf, now);
}

/**
 * POST /bulk: makes temporary or deletes every page selected (`id`, repeated),
 * one by one through `Operations`. A page that fails doesn't stop the rest.
 * The script gets the cards that changed, and a `data-error-for` line per
 * page that failed.
 */
async function bulk(ops: Operations, pages: Pages, host: string, csrf: string, form: FormData): Promise<{ html: string; status: number }> {
	const verb = form.get("do");
	if (verb !== "delete" && verb !== "temporary") return { html: "Unknown bulk action", status: 400 };
	const ids = [...new Set(form.getAll("id").map(String))];
	if (!ids.length) return { html: "Select some pages first", status: 400 };
	if (ids.length > BULK_LIMIT) return { html: `Select at most ${BULK_LIMIT} pages at once`, status: 400 };
	if (!ids.every((id) => ID_PATTERN.test(id))) return { html: "Unknown page", status: 400 };
	const results = await Promise.allSettled(ids.map((id) => (verb === "delete" ? ops.delete(id) : ops.makeTemporary(id))));
	const now = Date.now();
	const parts = await Promise.all(
		results.map(async (result, i) => {
			const id = ids[i]!;
			if (result.status === "rejected") {
				if (!(result.reason instanceof PageError)) console.error(`bulk ${verb} of ${id} failed`, result.reason);
				const message = result.reason instanceof PageError ? result.reason.message : "Something went wrong";
				return `<p class="error" data-error-for="${id}">${escape(message)}</p>`;
			}
			return verb === "delete" ? "" : renderOne(pages, host, csrf, id, now);
		}),
	);
	return { html: parts.join("\n"), status: 200 };
}

/** The admin dashboard on ADMIN_HOST. Only reachable through the Cloudflare Access app with audience ACCESS_AUD. */
export async function handleDashboard(request: Request, env: Env, ctx: ExecutionContext, pages: Pages): Promise<Response> {
	if (!ctx.access || ctx.access.aud !== env.ACCESS_AUD) return errorPage("Forbidden", 403);
	const identity = await ctx.access.getIdentity().catch(() => undefined);
	const user = String((identity as { email?: string } | undefined)?.email ?? "owner");
	const url = new URL(request.url);
	const ops = new Operations(pages, env.PAGES_HOST, env.EPHEMERA_TOKEN);

	if (request.method === "GET" && url.pathname === "/favicon.svg") return favicon();
	if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/mockups")) {
		const nonce = crypto.randomUUID().replaceAll("-", "");
		const [overview, csrf] = await Promise.all([ops.overview(), csrfToken(env.EPHEMERA_TOKEN, user)]);
		const tab = url.pathname === "/" ? "pages" : "mockups";
		const ownIndex = tab === "mockups" ? await setsWithOwnIndex(pages, overview.pages.filter((page) => page.kind === "mockup"), overview.options) : new Set<string>();
		return respond(render(tab, overview, env.PAGES_HOST, csrf, nonce, Date.now(), viewOf(url), ownIndex), 200, nonce);
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
		if (found.state !== "live") return errorPage(found.state === "gone" ? "This page has expired." : "Not found", found.state === "gone" ? 410 : 404);
		const page = found.page;
		const location = await viewerUrl(env.EPHEMERA_TOKEN, env.PAGES_HOST, page, Date.now(), { rest });
		return new Response(null, { status: 302, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
	}

	const match = ACTIONS.exec(url.pathname);
	const isBulk = url.pathname === "/bulk";
	if (request.method !== "POST" || !(match || isBulk)) return errorPage("Not found", 404);

	const form = await request.formData().catch(() => new FormData());
	const fragment = request.headers.get(FRAGMENT_HEADER) === "1";
	const back = backTo(request, form, env.ADMIN_HOST);
	// The script shows a failure as text inside the card; a plain form post gets a page.
	const fail = (message: string, status: number) =>
		fragment ? new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } }) : errorPage(message, status, back);
	const origin = request.headers.get("origin");
	if (origin !== `https://${env.ADMIN_HOST}` || !(await checkCsrf(env.EPHEMERA_TOKEN, user, String(form.get("csrf") ?? "")))) {
		return fail("Forbidden: reload the dashboard and try again", 403);
	}
	const csrf = () => csrfToken(env.EPHEMERA_TOKEN, user);

	if (isBulk) {
		const done = await bulk(ops, pages, env.PAGES_HOST, await csrf(), form);
		if (done.status !== 200) return fail(done.html, done.status);
		return fragment ? respond(done.html, 200) : new Response(null, { status: 303, headers: { location: back } });
	}

	const [, id, name] = match as unknown as [string, string, string];
	try {
		switch (name) {
			case "extend": {
				const by = url.searchParams.get("by") ?? "";
				if (!EXTENSIONS.includes(by)) return fail("Unknown extension", 400);
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
				await ops.setVisibility(id, name, null);
				break;
			case "password":
				// Without a password, this removes it; the page stays private.
				await ops.setVisibility(id, "private", String(form.get("password") ?? "") || null);
				break;
			case "share": {
				const ttl = url.searchParams.get("ttl") ?? "";
				if (!SHARES.includes(ttl)) return fail("Unknown share length", 400);
				const nonce = crypto.randomUUID().replaceAll("-", "");
				return respond(shareRender(await ops.shareLink(id, ttl), back, nonce, Date.now()), 200, nonce);
			}
			case "rollback":
				await ops.rollback(id, Number(url.searchParams.get("version")));
				break;
			case "delete":
				await ops.delete(id);
				break;
			case "verdict": {
				const verdict = String(form.get("verdict") ?? "");
				await ops.setVerdict(id, String(form.get("option") ?? ""), verdict, String(form.get("note") ?? ""));
				break;
			}
		}
		if (fragment) return name === "delete" ? new Response(null, { status: 204 }) : respond(await renderOne(pages, env.PAGES_HOST, await csrf(), id, Date.now()), 200);
	} catch (error) {
		if (error instanceof PageError) return fail(error.message, error.status);
		throw error;
	}
	// Back to the card that was acted on, unless it's gone.
	return new Response(null, { status: 303, headers: { location: name === "delete" ? back : `${back}#p-${id}` } });
}
