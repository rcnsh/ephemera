import { checkCsrf, csrfToken } from "./auth.ts";
import { bytesText, PageError, pageUrl } from "./domain.ts";
import { FAVICON_LINK, favicon, mark } from "./logo.ts";
import { type MockupOption, VERDICTS } from "./mockups.ts";
import { Operations, type Overview } from "./operations.ts";
import { ID_PATTERN, ID_SOURCE, type Page, type Pages, type Version } from "./pages.ts";
import { viewerUrl } from "./privacy.ts";
import { type Shot, type ShotResult, screenshots } from "./thumbnails.ts";

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

/** Sent with every answer to the script, so the totals under the title stay true. URI-encoded: headers are bytes. */
const USAGE_HEADER = "x-ephemera-usage";

/**
 * Most pages one bulk action takes, and how many it works on at once. One
 * invocation may make 1,000 D1 queries (Workers Paid) and keep 6 connections
 * open; a delete is 3 queries and 2 R2 calls per page, so 100 pages stay well
 * inside both, in batches of 4.
 */
const BULK_LIMIT = 100;
const BULK_BATCH = 4;

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
for (const button of $$(".bulk .all, .bulk .none-selected")) button.hidden = false;

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
	if (!search?.isConnected) return;
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
	// As the server sorts (sortPages), ties included: newest, then by id.
	const newest = (a, b) => number(b, "updated") - number(a, "updated") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	const compare = {
		newest,
		expiring: (a, b) => (!a.dataset.expires - !b.dataset.expires) || number(a, "expires") - number(b, "expires") || newest(a, b),
		largest: (a, b) => number(b, "size") - number(a, "size") || newest(a, b),
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

// The control someone was using, told apart from its twins: every verdict
// form in a set shares one action, so a form is its action plus its place
// among the card's forms with that action, and a control is its tag, name,
// value and text inside it.
function controlOf(item, form, submitter) {
	if (!item) return null;
	const active = document.activeElement;
	const control = form.contains(active) && active !== form ? active : submitter;
	if (!control) return null;
	const action = form.getAttribute("action");
	return {
		action,
		index: $$("form", item).filter((f) => f.getAttribute("action") === action).indexOf(form),
		tag: control.tagName,
		name: control.getAttribute("name") || "",
		value: control.tagName === "BUTTON" ? control.value : "",
		text: control.tagName === "BUTTON" ? control.textContent : "",
	};
}
// Never the selection checkbox: Enter there would act on the bulk form.
const FOCUSABLE = "button, input:not([type=hidden]):not(.select), select, textarea";
function refocus(next, key) {
	let target = null;
	if (key) {
		const forms = $$("form", next).filter((f) => f.getAttribute("action") === key.action);
		const form = forms[key.index] || forms[0];
		if (form) {
			const controls = $$(FOCUSABLE, form);
			target =
				controls.find((c) => c.tagName === key.tag && (c.getAttribute("name") || "") === key.name && (c.tagName !== "BUTTON" || (c.value === key.value && c.textContent === key.text))) ||
				controls[0] ||
				null;
		}
		// Its form went (make permanent turns into make temporary): the card's actions.
		if (!target) target = $(".actions " + FOCUSABLE.split(", ").join(", .actions "), next);
	}
	target = target || next;
	// A control inside a closed <details> can't take focus; its summary can.
	const closed = target.parentElement?.closest("details:not([open])");
	if (closed) target = closed.querySelector("summary");
	target.focus({ preventScroll: true });
	// Back in a text box, the caret goes at the end, where typing carries on.
	if (target.tagName === "INPUT" && /^(text|search|password|)$/.test(target.getAttribute("type") || "")) target.setSelectionRange(target.value.length, target.value.length);
}
function swap(item, html, key) {
	const kept = new Set($$("details[open][data-keep]", item).map((d) => d.dataset.keep));
	const selected = $(".select", item)?.checked;
	const template = document.createElement("template");
	template.innerHTML = html;
	const next = template.content.firstElementChild;
	for (const d of $$("details[data-keep]", next)) d.open = kept.has(d.dataset.keep);
	if (selected && $(".select", next)) $(".select", next).checked = true;
	item.replaceWith(next);
	if (key !== undefined) refocus(next, key);
	return next;
}
// Removes a card, and tidies what depended on it: its project heading, the
// agent menu, and, once nothing is left, the whole list for the empty state.
function remove(item, focus) {
	const after = item.nextElementSibling || item.previousElementSibling;
	const project = item.closest(".project");
	item.remove();
	if (project && !project.querySelector(".set")) project.remove();
	if (agent) {
		const left = new Set(items().map((card) => card.dataset.agent).filter(Boolean));
		for (const option of [...agent.options]) if (option.value && !left.has(option.value)) option.remove();
	}
	if (!items().length) {
		for (const el of $$(".filters, #count, #none, .grid, .sets, #bulk")) el.remove();
		$("#empty")?.removeAttribute("hidden");
		if (focus) $("h1").focus({ preventScroll: true });
		return;
	}
	if (focus) (after?.matches(".card, .set") ? after : $("h1")).focus({ preventScroll: true });
}
async function post(form, submitter) {
	const body = new FormData(form);
	if (submitter?.name) body.append(submitter.name, submitter.value);
	const response = await fetch(form.action, { method: "POST", body, headers: { "${FRAGMENT_HEADER}": "1" } }).catch(() => {
		throw new Error("Couldn't reach the dashboard. Check the connection and try again.");
	});
	const text = await response.text();
	if (!response.ok) throw new Error(text.trim() || "That didn't work (" + response.status + ")");
	const usage = response.headers.get("${USAGE_HEADER}");
	if (usage && $(".usage")) $(".usage").textContent = decodeURIComponent(usage);
	return { body, text, status: response.status };
}
document.addEventListener("submit", async (event) => {
	const form = event.target;
	if (form.method !== "post" || new URL(form.action).pathname.endsWith("/share")) return;
	event.preventDefault();
	// Not form.id: the bulk form's checkboxes are named "id", which shadows it.
	const isBulk = form.getAttribute("id") === "bulk";
	const submitter = event.submitter;
	// The bulk form acts only on a press of one of its own buttons.
	if (isBulk && !(submitter && submitter.name === "do" && (submitter.value === "delete" || submitter.value === "temporary"))) return;
	const item = form.closest(".card, .set");
	const busy = item || form;
	if (busy.classList.contains("busy")) return;
	const key = controlOf(item, form, submitter);
	for (const old of $$(".error", busy)) old.remove();
	// Not disabled while it runs: that would drop focus. Busy guards against a second press.
	busy.classList.add("busy");
	busy.setAttribute("aria-busy", "true");
	try {
		const { body, text, status } = await post(form, submitter);
		if (isBulk) {
			const template = document.createElement("template");
			template.innerHTML = text;
			for (const id of body.getAll("id")) {
				const card = document.getElementById("p-" + id);
				if (!card) continue;
				for (const old of $$(".error", card)) old.remove();
				const fresh = template.content.getElementById("p-" + id);
				const failed = template.content.querySelector('[data-error-for="' + id + '"]');
				if (fresh) swap(card, fresh.outerHTML);
				else if (failed) showError(card, failed.textContent);
				else remove(card, false);
			}
			for (const box of $$(".select")) box.checked = false;
			form.querySelector("details")?.removeAttribute("open");
			// The bar hides with nothing selected: focus moves to the count, which says what's left.
			($("#count") || $("h1")).focus({ preventScroll: true });
		} else if (status === 204) remove(item, true);
		else swap(item, text, key);
		// Not re-sorted: an action changes updatedAt, and the card should stay where you are.
		filter();
		tick();
		for (const button of $$("[data-share]")) if (navigator.share) button.hidden = false;
	} catch (error) {
		showError(busy, error.message);
	} finally {
		busy.classList.remove("busy");
		busy.removeAttribute("aria-busy");
	}
});

filter();
// The URL keeps only what the page shows: an agent with no pages, say, is dropped.
if (search) remember();
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
<form class="verdict" method="post" action="/pages/${page.id}/verdict">${hidden(page, csrf)}<input type="hidden" name="option" value="${escape(option.name)}"><input type="hidden" name="note_was" value="${escape(option.note ?? "")}"><input name="note" value="${escape(option.note ?? "")}" placeholder="note" maxlength="200" aria-label="Note on ${escape(option.name)}">${save}${buttons}</form>
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
		verdict: (VERDICTS as readonly string[]).includes(url.searchParams.get("verdict") ?? "") ? url.searchParams.get("verdict")! : "",
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
	// The script sorts the same way, ties included (see `order` in SCRIPT).
	const newest = (a: Page, b: Page) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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

/**
 * Whether a set has a root index.html. A set that is just one has it as its
 * option. Otherwise the files say: the edge cache remembers a version's
 * missing file, so a gallery set costs R2 nothing after the first look, and a
 * root index.html found is usually cached from publishing or viewing it.
 */
async function hasOwnIndex(pages: Pages, page: Page, options: MockupOption[]): Promise<boolean> {
	if (options.some((option) => option.path === "")) return true;
	return pages.files.exists(page, "index.html");
}

/** The line of totals under the title. */
function usageText(usage: Overview["usage"]): string {
	return `${usage.permanentPages} kept · ${usage.temporaryPages} expiring · ${usage.mockups} mockup set${usage.mockups === 1 ? "" : "s"} · ${bytesText(usage.bytes)}`;
}


/** "3 of 24 pages", or "24 pages" when nothing is filtered out. */
function countText(shown: number, total: number, noun: string): string {
	const nouns = `${noun}${total === 1 ? "" : "s"}`;
	return shown === total ? `${total} ${nouns}` : `${shown} of ${total} ${nouns}`;
}

/** The bar that acts on the selected cards; shown once one is selected. */
function bulkBar(csrf: string, back: string): string {
	// Enter in a field of this form (its checkboxes live in every card)
	// "clicks" its first enabled submit button; browsers skip a disabled one.
	// So the first is a hidden button that asks for nothing (`do` empty),
	// which the script ignores and the server answers by doing nothing. Only
	// a press of one of the real buttons acts.
	return `<form id="bulk" class="bulk" method="post" action="/bulk" aria-label="Selected pages"><button type="submit" class="default" name="do" value="" hidden aria-hidden="true" tabindex="-1"></button><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="back" value="${back}">
<span class="n" aria-live="polite">selected</span>
<button type="button" class="all" hidden>select all shown</button><button type="button" class="none-selected" hidden>clear</button>
<span class="muted">at most ${BULK_LIMIT} at once</span>
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
		// An agent with no pages filters nothing; the script drops it from the URL.
		if (!agents.includes(view.agent)) view = { ...view, agent: "" };
		const shown = (page: Page) => matches(pageSearch(page), view.q) && (!view.agent || page.agent === view.agent);
		const visible = pages.filter(shown).length;
		const cards = pages.map((page) => card(page, versions.get(page.id) ?? [], host, csrf, now, shown(page))).join("\n");
		body = pages.length
			? `<form class="filters" method="get" role="search"><input type="search" id="search" name="q" value="${escape(view.q)}" placeholder="Search labels, ids, agents" aria-label="Search pages">
<select id="agent" name="agent" aria-label="Agent"><option value="">all agents</option>${agents.map((agent) => (agent === view.agent ? selectOption(agent, agent, true) : `<option>${escape(agent)}</option>`)).join("")}</select>
<select id="sort" name="sort" aria-label="Sort by">${Object.entries(SORTS).map(([value, label]) => selectOption(value, label, value === view.sort)).join("")}</select>
<noscript><button>apply</button></noscript></form>
<p class="count" id="count" tabindex="-1" aria-live="polite">${countText(visible, pages.length, "page")}</p>
<p class="none" id="none"${visible ? " hidden" : ""}>No pages match. <a href="/">Show all</a></p>
<div class="grid">
${cards}
</div>
${bulkBar(csrf, "/")}
<p class="muted" id="empty" hidden>No live pages.</p>`
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
<p class="count" id="count" tabindex="-1" aria-live="polite">${countText(visible, sets.length, "set")}</p>
<p class="none" id="none"${visible ? " hidden" : ""}>No mockup sets match. <a href="/mockups">Show all</a></p>
<div class="sets">
${mockupSets(sets, options, versions, host, csrf, now, ownIndex, view)}
</div>
${bulkBar(csrf, "/mockups")}
<p class="muted" id="empty" hidden>No mockup sets yet. Agents publish them with publish_mockup.</p>`
			: '<p class="muted">No mockup sets yet. Agents publish them with publish_mockup.</p>';
	}
	const tabLink = (name: Tab, href: string, label: string) => `<a href="${href}"${tab === name ? ' class="current" aria-current="page"' : ""}>${label}</a>`;
	return shell(
		`ephemera${tab === "mockups" ? " · mockups" : ""}`,
		`<h1 tabindex="-1">${mark("logo", 7, 'class="logo"')}ephemera</h1>
<p class="usage">${usageText(usage)}</p>
<nav class="tabs">${tabLink("pages", "/", "Pages")}${tabLink("mockups", "/mockups", "Mockups")}</nav>
${body}`,
		nonce,
	);
}

function shareRender(link: { url: string; expiresAt: string | null }, back: string, nonce: string, now: number): string {
	return shell(
		"Share link",
		`<h1>Share link</h1>
<p class="usage">Opens the page without signing in${link.expiresAt ? ` for ${duration(Date.parse(link.expiresAt) - now)}` : ""}. Making the page public or private again, or rolling it back, revokes it.</p>
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
		// Another request's tidying may have dropped a job this one is still waiting for.
		if (!jobs.has(key)) jobs.set(key, { page, option, queuedAt: now, takenUntil: 0 });
		if (lease.until <= now && [...jobs.values()].some((job) => job.takenUntil <= now)) await shoot(env, pages);
		else await sleep(POLL);
	}
	// A batch this request shot itself can run past the deadline with its own shot long done.
	const done = outcomes.get(key);
	return done ? done.outcome : "timeout";
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
				// The page may have been deleted or updated while its shot was queued; a thumbnail kept then would never be cleaned up.
				const current = await pages.lookup(job.page.id, { fresh: true });
				if (current.state !== "live" || current.page.version !== job.page.version) return finish(key, undefined);
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
	// Read fresh: a shot of a page that has just gone private, taken from a stale row, would photograph its gate and be kept.
	const found = await pages.lookup(id, { fresh: true });
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
 * POST /bulk: makes temporary or deletes every page selected (`id`,
 * repeated) through `Operations`, `BULK_BATCH` at a time. Each page has
 * its own outcome, and one that fails doesn't stop the rest. The script gets
 * the cards that changed (rendered from one read of everything), a
 * `data-error-for` line per page that failed, and nothing for a page that's
 * gone: deleted, here or elsewhere, so its card goes too.
 */
async function bulk(ops: Operations, pages: Pages, host: string, csrf: string, form: FormData): Promise<{ html: string; status: number }> {
	const verb = form.get("do");
	if (verb !== "delete" && verb !== "temporary") return { html: "Unknown bulk action", status: 400 };
	const ids = [...new Set(form.getAll("id").map(String))];
	if (!ids.length) return { html: "Select some pages first", status: 400 };
	if (ids.length > BULK_LIMIT) return { html: `Select at most ${BULK_LIMIT} pages at once`, status: 400 };
	if (!ids.every((id) => ID_PATTERN.test(id))) return { html: "Unknown page", status: 400 };
	const errors = new Map<string, string>();
	const changed: string[] = [];
	for (let i = 0; i < ids.length; i += BULK_BATCH) {
		const batch = ids.slice(i, i + BULK_BATCH);
		const results = await Promise.allSettled(batch.map((id) => (verb === "delete" ? ops.delete(id) : ops.makeTemporary(id))));
		results.forEach((result, j) => {
			const id = batch[j]!;
			if (result.status === "fulfilled") {
				if (verb === "temporary") changed.push(id);
			} else if (result.reason instanceof PageError && (result.reason.status === 404 || result.reason.status === 410)) {
				// Already gone: nothing to do, and its card should go.
			} else {
				if (!(result.reason instanceof PageError)) console.error(`bulk ${verb} of ${id} failed`, result.reason);
				errors.set(id, result.reason instanceof PageError ? result.reason.message : "Something went wrong");
			}
		});
	}
	const parts: string[] = [];
	if (changed.length) {
		const overview = await ops.overview();
		const live = new Map(overview.pages.map((page) => [page.id, page]));
		const now = Date.now();
		for (const id of changed) {
			const page = live.get(id);
			if (!page) continue;
			try {
				const versions = overview.versions.get(id) ?? [];
				parts.push(
					page.kind === "mockup"
						? mockupSet(page, overview.options.get(id) ?? [], versions, host, csrf, now, await hasOwnIndex(pages, page, overview.options.get(id) ?? []))
						: card(page, versions, host, csrf, now),
				);
			} catch (error) {
				console.error(`rendering ${id} after bulk ${verb} failed`, error);
				errors.set(id, "Done, but its card couldn't be shown; reload to see it");
			}
		}
	}
	for (const [id, message] of errors) parts.push(`<p class="error" data-error-for="${id}">${escape(message)}</p>`);
	return { html: parts.join("\n"), status: 200 };
}

/** Adds the current totals to an answer for the script (see `USAGE_HEADER`). */
async function withUsage(response: Response, pages: Pages): Promise<Response> {
	response.headers.set(USAGE_HEADER, encodeURIComponent(usageText(await pages.usage())));
	return response;
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
		// Enter in the form, rather than a press of one of its buttons: nothing to do.
		if (form.get("do") === "") return fragment ? new Response(null, { status: 204 }) : new Response(null, { status: 303, headers: { location: back } });
		const done = await bulk(ops, pages, env.PAGES_HOST, await csrf(), form);
		if (done.status !== 200) return fail(done.html, done.status);
		return fragment ? withUsage(respond(done.html, 200), pages) : new Response(null, { status: 303, headers: { location: back } });
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
				// No password given: a private page keeps the one it has.
				await ops.setVisibility(id, name, undefined);
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
		if (fragment) return withUsage(name === "delete" ? new Response(null, { status: 204 }) : respond(await renderOne(pages, env.PAGES_HOST, await csrf(), id, Date.now()), 200), pages);
	} catch (error) {
		if (error instanceof PageError) return fail(error.message, error.status);
		throw error;
	}
	// Back to the card that was acted on, unless it's gone.
	return new Response(null, { status: 303, headers: { location: name === "delete" ? back : `${back}#p-${id}` } });
}
