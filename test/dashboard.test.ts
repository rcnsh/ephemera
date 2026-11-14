import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageError } from "../src/domain.ts";
import { Operations } from "../src/operations.ts";
import { VersionFiles } from "../src/version-files.ts";
import { screenshots } from "../src/thumbnails.ts";
import { ADMIN, api, call, PAGES, publish } from "./helpers.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(async () => {
	vi.mocked(screenshots).mockReset().mockImplementation(async (_browser, shots) => shots.map(() => null));
	await reset();
});

const AUD = "test-aud";

/** `accessAud: null` simulates a request that didn't come through Access. */
function admin(path = "/", init: RequestInit = {}, accessAud: string | null = AUD): Promise<Response> {
	return call(`${ADMIN}${path}`, init, { accessAud: accessAud ?? undefined });
}

async function csrfToken(): Promise<string> {
	const html = await (await admin()).text();
	return /name="csrf" value="([^"]+)"/.exec(html)![1]!;
}

function post(path: string, csrf: string, origin = ADMIN, fields: Record<string, string> | [string, string][] = {}, headers: Record<string, string> = {}): Promise<Response> {
	const body = new URLSearchParams(fields);
	body.set("csrf", csrf);
	return admin(path, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded", ...headers },
		body,
	});
}

/** An action as the dashboard's script sends it: the answer is the card's new HTML. */
function fragment(path: string, csrf: string, fields: Record<string, string> | [string, string][] = {}, origin = ADMIN): Promise<Response> {
	return post(path, csrf, origin, fields, { "x-ephemera-fragment": "1" });
}

/** The ids of the cards on a tab, in order, with whether each is shown. */
function cards(html: string): { id: string; shown: boolean }[] {
	return [...html.matchAll(/<article class="(card|set)( hidden)?" id="p-([^"]+)"/g)].map((m) => ({ id: m[3]!, shown: !m[2] }));
}

async function pageInfo(id: string): Promise<Record<string, unknown>> {
	return (await api(`/pages/${id}`)).json();
}

describe("dashboard", () => {
	it("refuses requests that didn't come through Access, or for another Access app", async () => {
		expect((await admin("/", {}, null)).status).toBe(403);
		expect((await admin("/", {}, "other-app")).status).toBe(403);
	});

	it("serves the favicon on both hosts", async () => {
		for (const response of [await admin("/favicon.svg"), await call(`${PAGES}/favicon.svg`)]) {
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("image/svg+xml");
			expect(await response.text()).toContain("prefers-color-scheme");
		}
		expect(await (await admin()).text()).toContain('href="/favicon.svg"');
	});

	it("lists live pages with usage, and isn't sandboxed or cached", async () => {
		await publish({ ttl: "1h", label: "quarterly report", agent: "codex" });
		await publish({ label: "keeper" });
		const response = await admin();
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("quarterly report");
		expect(html).toContain("codex");
		expect(html).toContain("permanent");
		expect(html).toContain("1 kept · 1 expiring");
		expect(response.headers.get("content-security-policy")).not.toMatch(/^sandbox/);
		expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(response.headers.get("cache-control")).toBe("no-store");
		// no-referrer would make browsers send `Origin: null` with the dashboard's form posts.
		expect(response.headers.get("referrer-policy")).toBe("same-origin");
	});

	it("rejects actions without a valid CSRF token or from another origin", async () => {
		const page = await publish();
		const csrf = await csrfToken();
		expect((await post(`/pages/${page.id}/delete`, "forged")).status).toBe(403);
		expect((await post(`/pages/${page.id}/delete`, csrf, "https://pages.example.com")).status).toBe(403);
		expect((await call(page.url)).status).toBe(200);
	});

	it("extends, toggles permanent and deletes pages", async () => {
		const page = await publish({ ttl: "1h" });
		const csrf = await csrfToken();

		const extended = await post(`/pages/${page.id}/extend?by=1d`, csrf);
		expect(extended.status).toBe(303);
		// Back to the card, on the tab it was on.
		expect(extended.headers.get("location")).toBe(`/#p-${page.id}`);
		expect((await post(`/pages/${page.id}/extend?by=60d`, csrf)).status).toBe(400);

		expect((await post(`/pages/${page.id}/permanent`, csrf)).status).toBe(303);
		expect(await (await admin()).text()).toMatch(/permanent/);
		expect((await post(`/pages/${page.id}/temporary`, csrf)).status).toBe(303);

		const deleted = await post(`/pages/${page.id}/delete`, csrf);
		expect(deleted.status).toBe(303);
		expect(deleted.headers.get("location")).toBe("/");
		expect((await call(page.url)).status).toBe(410);
	});

	it("shows a card per page with a thumbnail, search and an agent filter", async () => {
		const page = await publish({ label: "chart", agent: "codex" });
		await publish({ agent: "claude-code" });
		const html = await (await admin()).text();
		expect(html).toContain(`<img src="/thumbnails/${page.id}.png?v=1"`);
		expect(html).toContain('id="search"');
		expect(html).toMatch(/<option value="claude-code">claude-code<\/option><option value="codex">codex<\/option>/);
		expect(html).toContain('data-search="chart');
		expect((await admin()).headers.get("content-security-policy")).toContain("img-src 'self'");
	});

	it("renames pages", async () => {
		const page = await publish({ label: "old" });
		const csrf = await csrfToken();
		expect((await post(`/pages/${page.id}/label`, csrf, ADMIN, { label: "  new name " })).status).toBe(303);
		expect((await pageInfo(page.id)).label).toBe("new name");
		await post(`/pages/${page.id}/label`, csrf, ADMIN, { label: "" });
		expect((await pageInfo(page.id)).label).toBeNull();
	});

	it("makes pages private, sets and removes passwords, and makes share links", async () => {
		const page = await publish();
		const csrf = await csrfToken();
		await post(`/pages/${page.id}/private`, csrf);
		expect(await pageInfo(page.id)).toMatchObject({ visibility: "private", hasPassword: false });
		expect(await (await admin()).text()).toContain(`href="/open/${page.id}/"`);

		await post(`/pages/${page.id}/password`, csrf, ADMIN, { password: "correct horse" });
		expect(await pageInfo(page.id)).toMatchObject({ visibility: "private", hasPassword: true });
		expect((await post(`/pages/${page.id}/password`, csrf, ADMIN, { password: "short" })).status).toBe(400);
		await post(`/pages/${page.id}/password`, csrf);
		expect(await pageInfo(page.id)).toMatchObject({ visibility: "private", hasPassword: false });

		const shared = await post(`/pages/${page.id}/share?ttl=7d`, csrf);
		expect(shared.status).toBe(200);
		const link = /<input readonly value="([^"]+)"/.exec(await shared.text())![1]!;
		expect((await call(link)).status).toBe(200);
		expect((await post(`/pages/${page.id}/share?ttl=1y`, csrf)).status).toBe(400);

		await post(`/pages/${page.id}/public`, csrf);
		expect((await call(page.url)).status).toBe(200);
	});

	it("lists versions and rolls back", async () => {
		const page = await publish({ files: [{ path: "index.html", content: "v1" }] });
		await api(`/pages/${page.id}`, { method: "PUT", body: JSON.stringify({ html: "v2" }) });
		const csrf = await csrfToken();
		const html = await (await admin()).text();
		expect(html).toContain("2 versions");
		expect(html).toContain(`action="/pages/${page.id}/rollback?version=1"`);
		expect((await post(`/pages/${page.id}/rollback?version=1`, csrf)).status).toBe(303);
		expect(await (await call(page.url)).text()).toBe("v1");
		expect((await post(`/pages/${page.id}/rollback?version=7`, csrf)).status).toBe(404);
	});

	it("makes a thumbnail once per version", async () => {
		const png = new Uint8Array([137, 80, 78, 71]);
		vi.mocked(screenshots).mockResolvedValue([png]);
		const page = await publish();

		const first = await admin(`/thumbnails/${page.id}.png`);
		expect(first.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await first.arrayBuffer())).toEqual(png);
		expect(vi.mocked(screenshots).mock.calls[0]![1]).toEqual([{ url: page.url, kind: "page" }]);
		await admin(`/thumbnails/${page.id}.png`);
		expect(screenshots).toHaveBeenCalledTimes(1);
		expect((await admin(`/thumbnails/${page.id}.png`, {}, null)).status).toBe(403);
	});

	it("remembers a page that failed to shoot for a while, but retries when no browser could be had", async () => {
		const page = await publish();
		vi.mocked(screenshots).mockResolvedValue([null]);
		const noBrowser = await admin(`/thumbnails/${page.id}.png`);
		expect(noBrowser.headers.get("content-type")).toBe("image/svg+xml");
		expect(noBrowser.headers.get("cache-control")).toBe("no-store");
		await admin(`/thumbnails/${page.id}.png`);
		expect(screenshots).toHaveBeenCalledTimes(2);

		vi.mocked(screenshots).mockResolvedValue(["failed"]);
		const failed = await admin(`/thumbnails/${page.id}.png`);
		expect(failed.headers.get("cache-control")).toBe("private, max-age=600");
		const again = await admin(`/thumbnails/${page.id}.png`);
		expect(again.headers.get("content-type")).toBe("image/svg+xml");
		expect(screenshots).toHaveBeenCalledTimes(3);

		// A new version is shot afresh.
		await api(`/pages/${page.id}`, { method: "PUT", body: JSON.stringify({ html: "v2" }) });
		vi.mocked(screenshots).mockResolvedValue([new Uint8Array([1])]);
		expect((await admin(`/thumbnails/${page.id}.png`)).headers.get("content-type")).toBe("image/png");
		expect(screenshots).toHaveBeenCalledTimes(4);
	});

	it("tries a remembered failure again once it's old", async () => {
		const page = await publish();
		await env.BUCKET.put(`pages/${page.id}/thumbnail.png`, new Uint8Array(0), { customMetadata: { version: "1", failedAt: String(Date.now() - 11 * 60_000) } });
		vi.mocked(screenshots).mockResolvedValue([new Uint8Array([1])]);
		expect((await admin(`/thumbnails/${page.id}.png`)).headers.get("content-type")).toBe("image/png");
		expect(screenshots).toHaveBeenCalledTimes(1);
	});

	it("shoots a dashboard's worth of thumbnails asked for at once in one browser", async () => {
		const ids = (await Promise.all([1, 2, 3, 4, 5].map(() => publish()))).map((page) => page.id);
		vi.mocked(screenshots).mockImplementation(async (_browser, shots) => shots.map(() => new Uint8Array([7])));
		const responses = await Promise.all(ids.map((id) => admin(`/thumbnails/${id}.png`)));
		expect(responses.map((response) => response.headers.get("content-type"))).toEqual(ids.map(() => "image/png"));
		expect(screenshots).toHaveBeenCalledTimes(1);
		expect(vi.mocked(screenshots).mock.calls[0]![1]).toHaveLength(5);
	});

	it("shoots private pages through a short-lived pass", async () => {
		vi.mocked(screenshots).mockResolvedValue([new Uint8Array([1])]);
		const page = await publish({ visibility: "private" });
		await admin(`/thumbnails/${page.id}.png`);
		const url = vi.mocked(screenshots).mock.calls[0]![1][0]!.url;
		expect(url).toMatch(new RegExp(`/${page.id}/~`));
		expect((await call(url)).status).toBe(200);
	});
});

describe("renaming through the API", () => {
	it("takes a label in PATCH, with or without a ttl", async () => {
		const page = await publish({ ttl: "1h" });
		const renamed = (await (await api(`/pages/${page.id}`, { method: "PATCH", body: JSON.stringify({ label: "x" }) })).json()) as { label: string; expiresAt: string };
		expect(renamed).toMatchObject({ label: "x", expiresAt: page.expiresAt });
		const both = (await (await api(`/pages/${page.id}`, { method: "PATCH", body: JSON.stringify({ label: "y", ttl: "1h" }) })).json()) as { label: string; expiresAt: string };
		expect(both.label).toBe("y");
		expect(Date.parse(both.expiresAt)).toBe(Date.parse(page.expiresAt!) + 3_600_000);
	});
});

describe("dashboard actions that keep your place", () => {
	it("answers the script with the card's new HTML instead of a redirect", async () => {
		const page = await publish({ ttl: "1h", label: "chart" });
		const csrf = await csrfToken();
		const response = await fragment(`/pages/${page.id}/permanent`, csrf);
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toMatch(new RegExp(`^<article class="card" id="p-${page.id}"`));
		expect(html).not.toContain("<!doctype");
		expect(html).toContain("never expires");
		expect(html).toContain('name="csrf"');

		const deleted = await fragment(`/pages/${page.id}/delete`, csrf);
		expect(deleted.status).toBe(204);
	});

	it("answers the script's failures as text, and still checks the origin and CSRF token", async () => {
		const page = await publish({ ttl: "1h" });
		const csrf = await csrfToken();
		const bad = await fragment(`/pages/${page.id}/extend?by=60d`, csrf);
		expect(bad.status).toBe(400);
		expect(bad.headers.get("content-type")).toContain("text/plain");
		expect(await bad.text()).toBe("Unknown extension");
		const short = await fragment(`/pages/${page.id}/password`, csrf, { password: "short" });
		expect(short.status).toBe(400);

		expect((await fragment(`/pages/${page.id}/delete`, "forged")).status).toBe(403);
		expect((await fragment(`/pages/${page.id}/delete`, csrf, {}, PAGES)).status).toBe(403);
		expect((await call(page.url)).status).toBe(200);
	});

	it("redirects a plain form post back to the tab it came from, search included", async () => {
		const page = await publish({ ttl: "1h" });
		const csrf = await csrfToken();
		const back = await post(`/pages/${page.id}/extend?by=1d`, csrf, ADMIN, {}, { referer: `${ADMIN}/?q=chart&sort=largest` });
		expect(back.headers.get("location")).toBe(`/?q=chart&sort=largest#p-${page.id}`);
		// Only the dashboard's own tabs.
		const elsewhere = await post(`/pages/${page.id}/extend?by=1d`, csrf, ADMIN, {}, { referer: "https://evil.example/?q=x" });
		expect(elsewhere.headers.get("location")).toBe(`/#p-${page.id}`);
		const share = await post(`/pages/${page.id}/extend?by=1d`, csrf, ADMIN, { back: "//evil.example/" });
		expect(share.headers.get("location")).toBe(`/#p-${page.id}`);
	});

	it("shows errors as whole pages with a way back", async () => {
		const page = await publish();
		const csrf = await csrfToken();
		const response = await post(`/pages/${page.id}/rollback?version=7`, csrf, ADMIN, {}, { referer: `${ADMIN}/?q=x` });
		expect(response.status).toBe(404);
		const html = await response.text();
		expect(html).toMatch(/^<!doctype html>/);
		expect(html).toContain('<meta name="viewport"');
		expect(html).toContain('<a href="/?q=x">back</a>');
		expect(await (await admin("/nope")).text()).toContain('<meta name="viewport"');
		expect((await admin("/", {}, null)).headers.get("content-type")).toContain("text/html");
	});

	it("lets the script fetch, and nothing else", async () => {
		expect((await admin()).headers.get("content-security-policy")).toContain("connect-src 'self'");
	});
});

describe("the Pages tab", () => {
	it("lists the newest-updated pages first, and sorts by expiry or size on request", async () => {
		const old = await publish({ label: "old", files: [{ path: "index.html", content: "x".repeat(500) }] });
		await tick();
		const soon = await publish({ label: "soon", ttl: "1h" });
		await tick();
		const later = await publish({ label: "later", ttl: "7d" });
		await tick();
		const fresh = await publish({ label: "fresh" });
		const ids = async (query = "") => cards(await (await admin(`/${query}`)).text()).map((card) => card.id);

		expect(await ids()).toEqual([fresh.id, later.id, soon.id, old.id]);
		expect(await ids("?sort=expiring")).toEqual([soon.id, later.id, fresh.id, old.id]);
		expect((await ids("?sort=largest"))[0]).toBe(old.id);
		expect(await ids("?sort=bogus")).toEqual([fresh.id, later.id, soon.id, old.id]);
		expect(await (await admin("/?sort=largest")).text()).toContain('<option value="largest" selected>');

	});

	it("filters by ?q= and ?agent= before the script runs, with a count and a no-matches line", async () => {
		const chart = await publish({ label: "quarterly chart", agent: "codex" });
		const other = await publish({ label: "notes", agent: "claude-code" });
		let html = await (await admin("/?q=chart")).text();
		expect(cards(html)).toEqual(expect.arrayContaining([{ id: chart.id, shown: true }, { id: other.id, shown: false }]));
		expect(html).toContain('name="q" value="chart"');
		expect(html).toContain("1 of 2 pages");
		expect(html).toContain('<p class="none" id="none" hidden>');

		html = await (await admin("/?q=nothing")).text();
		expect(html).toContain("0 of 2 pages");
		expect(html).toContain('<p class="none" id="none">No pages match.');

		html = await (await admin("/?agent=claude-code")).text();
		expect(cards(html)).toEqual(expect.arrayContaining([{ id: chart.id, shown: false }, { id: other.id, shown: true }]));
		expect(html).toContain('<option value="claude-code" selected>');
		expect(await (await admin("/")).text()).toContain("2 pages");
	});

	it("gives each card its expiry as a timestamp, highlighted with under an hour left", async () => {
		const soon = await publish({ ttl: "30m" });
		const later = await publish({ ttl: "1d" });
		const html = await (await admin()).text();
		expect(html).toContain(`<span class="expiry soon" data-expires="${Date.parse(soon.expiresAt!)}">expires in 30m</span>`);
		expect(html).toContain(`<span class="expiry" data-expires="${Date.parse(later.expiresAt!)}">expires in 24h 0m</span>`);
		expect(html).toContain("setInterval(tick, 60000)");
		// Cards carry data-expires for sorting; the countdown must leave them alone.
		expect(html).toContain('$$(".expiry[data-expires]")');
	});

	it("asks before making a page public, since that revokes its share links", async () => {
		const page = await publish({ visibility: "private" });
		const html = await (await admin()).text();
		expect(html).toMatch(new RegExp(`<details class="confirm"><summary>make public</summary>[^]*?action="/pages/${page.id}/public"[^]*?really make public`));
	});

	it("labels inputs by what they're for", async () => {
		const page = await publish({ visibility: "private", label: "Roadmap" });
		const html = await (await admin()).text();
		expect(html).toContain('aria-label="New password for Roadmap"');
		expect(html).toContain(`aria-label="Label for ${page.id}"`);
		expect(html).toContain('aria-label="Select Roadmap"');
		expect(html).toContain("copy failed");
	});
});

describe("the share-link page", () => {
	it("has the dashboard's shell, a share button, and goes back to the tab it came from", async () => {
		const page = await publish({ visibility: "private" });
		const csrf = await csrfToken();
		const response = await post(`/pages/${page.id}/share?ttl=1d`, csrf, ADMIN, { back: "/mockups" }, { referer: `${ADMIN}/mockups?q=x` });
		const html = await response.text();
		expect(html).toContain('<meta name="viewport"');
		expect(html).toContain('<a href="/mockups?q=x">back</a>');
		expect(html).toMatch(/<button type="button" data-share="[^"]+" hidden>share<\/button>/);
		expect(response.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[0-9a-f]+'/);
		// Without a Referer, the form's own tab.
		const plain = await (await post(`/pages/${page.id}/share?ttl=1d`, csrf, ADMIN, { back: "/mockups" })).text();
		expect(plain).toContain('<a href="/mockups">back</a>');
	});
});

describe("bulk actions", () => {
	it("puts a checkbox for the bulk form on every card", async () => {
		const page = await publish();
		const html = await (await admin()).text();
		expect(html).toContain(`<input type="checkbox" class="select" form="bulk" name="id" value="${page.id}"`);
		expect(html).toContain('<form id="bulk" class="bulk" method="post" action="/bulk"');
	});

	it("deletes or makes temporary every selected page", async () => {
		const a = await publish();
		const b = await publish();
		const keep = await publish();
		const csrf = await csrfToken();

		const temporary = await fragment("/bulk", csrf, [["do", "temporary"], ["id", a.id], ["id", b.id]]);
		expect(temporary.status).toBe(200);
		const html = await temporary.text();
		expect(cards(html).map((card) => card.id)).toEqual([a.id, b.id]);
		expect(await pageInfo(a.id)).toMatchObject({ permanent: false });
		expect(await pageInfo(keep.id)).toMatchObject({ permanent: true });

		const deleted = await post("/bulk", csrf, ADMIN, [["do", "delete"], ["id", a.id], ["id", b.id]], { referer: `${ADMIN}/?q=x` });
		expect(deleted.status).toBe(303);
		expect(deleted.headers.get("location")).toBe("/?q=x");
		expect((await call(a.url)).status).toBe(410);
		expect((await call(b.url)).status).toBe(410);
		expect((await call(keep.url)).status).toBe(200);
	});

	it("carries on past a page that fails, and says which", async () => {
		const [a, b, c] = [await publish(), await publish(), await publish()];
		const csrf = await csrfToken();
		const real = Operations.prototype.makeTemporary;
		const spy = vi.spyOn(Operations.prototype, "makeTemporary").mockImplementation(function (this: Operations, id: string) {
			if (id === b.id) return Promise.reject(new PageError(409, "Page is busy"));
			return real.call(this, id);
		});
		try {
			const html = await (await fragment("/bulk", csrf, [["do", "temporary"], ["id", a.id], ["id", b.id], ["id", c.id]])).text();
			expect(cards(html).map((card) => card.id)).toEqual([a.id, c.id]);
			expect(html).toContain(`<p class="error" data-error-for="${b.id}">Page is busy</p>`);
			expect(await pageInfo(c.id)).toMatchObject({ permanent: false });
		} finally {
			spy.mockRestore();
		}
	});

	it("treats a page already gone as done, so its card goes rather than showing an error", async () => {
		const page = await publish();
		const gone = await publish();
		await api(`/pages/${gone.id}`, { method: "DELETE" });
		const csrf = await csrfToken();
		for (const verb of ["delete", "temporary"]) {
			const html = await (await fragment("/bulk", csrf, [["do", verb], ["id", gone.id], ["id", "zzzzzzzzzzzz"]])).text();
			expect(html).not.toContain("error");
		}
		await fragment("/bulk", csrf, [["do", "delete"], ["id", page.id]]);
		expect((await call(page.url)).status).toBe(410);
	});

	it("takes at most 100 pages, and sends the totals back for the header", async () => {
		const page = await publish();
		const csrf = await csrfToken();
		const ids = Array.from({ length: 101 }, (_, i) => ["id", `zzzzzzzzzz${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`] as [string, string]);
		const tooMany = await fragment("/bulk", csrf, [["do", "delete"], ...ids]);
		expect(tooMany.status).toBe(400);
		expect(await tooMany.text()).toBe("Select at most 100 pages at once");
		const response = await fragment("/bulk", csrf, [["do", "temporary"], ["id", page.id]]);
		expect(decodeURIComponent(response.headers.get("x-ephemera-usage")!)).toBe("0 kept · 1 expiring · 0 mockup sets · 29 B");
		const single = await fragment(`/pages/${page.id}/delete`, csrf);
		expect(decodeURIComponent(single.headers.get("x-ephemera-usage")!)).toMatch(/^0 kept · 0 expiring/);
	});

	it("makes 24 pages temporary in batches, and renders their cards from one read", async () => {
		const pages = await Promise.all(Array.from({ length: 24 }, () => publish()));
		const csrf = await csrfToken();
		const response = await fragment("/bulk", csrf, [["do", "temporary"], ...pages.map((page) => ["id", page.id] as [string, string])]);
		expect(cards(await response.text())).toHaveLength(24);
		for (const page of pages) expect(await pageInfo(page.id)).toMatchObject({ permanent: false });
	});

	it("does nothing when submitted by Enter, which presses its first button, a hidden one that asks for nothing", async () => {
		const page = await publish();
		const html = await (await admin()).text();
		expect(html).toMatch(/<form id="bulk"[^>]*><button type="submit" class="default" name="do" value="" hidden/);
		const csrf = await csrfToken();
		expect((await fragment("/bulk", csrf, [["do", ""], ["id", page.id]])).status).toBe(204);
		const plain = await post("/bulk", csrf, ADMIN, [["do", ""], ["id", page.id]]);
		expect(plain.status).toBe(303);
		expect(await pageInfo(page.id)).toMatchObject({ permanent: true });
		expect((await call(page.url)).status).toBe(200);
	});

	it("refuses unknown actions, empty selections, and requests without the origin or CSRF token", async () => {
		const page = await publish();
		const csrf = await csrfToken();
		expect((await fragment("/bulk", csrf, [["do", "explode"], ["id", page.id]])).status).toBe(400);
		expect((await fragment("/bulk", csrf, [["do", "delete"]])).status).toBe(400);
		expect((await fragment("/bulk", csrf, [["do", "delete"], ["id", "../x"]])).status).toBe(400);
		expect((await fragment("/bulk", "forged", [["do", "delete"], ["id", page.id]])).status).toBe(403);
		expect((await fragment("/bulk", csrf, [["do", "delete"], ["id", page.id]], PAGES)).status).toBe(403);
		expect((await admin("/bulk")).status).toBe(404);
		expect((await call(page.url)).status).toBe(200);
	});
});

describe("agent names the browser would mangle", () => {
	it("gives every agent option its exact value, so one with doubled spaces still filters", async () => {
		const page = await publish({ agent: "claude  code" });
		await publish({ agent: "codex" });
		expect(await (await admin()).text()).toContain('<option value="claude  code">claude  code</option>');
		const filtered = await (await admin("/?agent=claude%20%20code")).text();
		expect(filtered).toContain('<option value="claude  code" selected>');
		expect(cards(filtered)).toEqual(expect.arrayContaining([{ id: page.id, shown: true }]));
		expect(filtered).toContain("1 of 2 pages");
	});
});

describe("bulk outcomes", () => {
	function failCleanup() {
		return vi.spyOn(VersionFiles.prototype, "deletePage").mockRejectedValue(new Error("R2 is down"));
	}

	it("tells the script a page was deleted even when its files' cleanup failed", async () => {
		const page = await publish();
		const csrf = await csrfToken();
		const spy = failCleanup();
		try {
			const html = await (await fragment("/bulk", csrf, [["do", "delete"], ["id", page.id]])).text();
			expect(html).toContain(`<p class="notice" data-notice-for="${page.id}">Deleted ${page.id}; its files will be cleaned up shortly.</p>`);
			expect(html).not.toContain("error");
		} finally {
			spy.mockRestore();
		}
		expect((await call(page.url)).status).toBe(410);
	});

	it("does the same for a single delete", async () => {
		const page = await publish();
		const csrf = await csrfToken();
		const spy = failCleanup();
		try {
			const response = await fragment(`/pages/${page.id}/delete`, csrf);
			expect(response.status).toBe(204);
			expect(decodeURIComponent(response.headers.get("x-ephemera-notice")!)).toBe(`Deleted ${page.id}; its files will be cleaned up shortly.`);
			const other = await publish();
			const plain = await post(`/pages/${other.id}/delete`, csrf, ADMIN, {}, { referer: `${ADMIN}/?q=x` });
			expect(plain.headers.get("location")).toMatch(new RegExp(`^/\\?q=x&cleanup=${other.id}&sig=[\\w-]+$`));
		} finally {
			spy.mockRestore();
		}
	});

	it("carries failures and pending cleanups through the redirect when sent without script, and shows them", async () => {
		const [a, b, c] = [await publish({ label: "alpha" }), await publish({ label: "bravo" }), await publish()];
		const csrf = await csrfToken();
		const real = Operations.prototype.makeTemporary;
		const busy = vi.spyOn(Operations.prototype, "makeTemporary").mockImplementation(function (this: Operations, id: string) {
			if (id === b.id) return Promise.reject(new PageError(409, "Page is busy"));
			return real.call(this, id);
		});
		let location: string;
		try {
			const response = await post("/bulk", csrf, ADMIN, [["do", "temporary"], ["id", a.id], ["id", b.id]], { referer: `${ADMIN}/?q=x` });
			location = response.headers.get("location")!;
		} finally {
			busy.mockRestore();
		}
		expect(location).toMatch(new RegExp(`^/\\?q=x&did=temporary&failed=${b.id}&sig=[\\w-]+$`));
		const shown = await (await admin(location.replace("q=x&", ""))).text();
		expect(shown).toContain("<p class=\"error\">Couldn't make temporary bravo. Try again.</p>");
		// Only the dashboard's own redirect is believed: a link made by hand, or one whose outcome was edited, says nothing.
		const unsigned = location.replace(/&sig=.*/, "");
		expect(await (await admin(unsigned)).text()).not.toContain('<p class="error">Couldn');
		expect(await (await admin(location.replace(b.id, a.id))).text()).not.toContain('<p class="error">Couldn');
		expect(await (await admin(location.replace("did=temporary", "did=delete"))).text()).not.toContain('<p class="error">Couldn');
		expect(await (await admin(`/?cleanup=${a.id},${b.id}`)).text()).not.toContain('<p class="notice">Deleted');

		const spy = failCleanup();
		try {
			const deleted = await post("/bulk", csrf, ADMIN, [["do", "delete"], ["id", c.id]]);
			location = deleted.headers.get("location")!;
		} finally {
			spy.mockRestore();
		}
		expect(location).toMatch(new RegExp(`^/\\?cleanup=${c.id}&sig=[\\w-]+$`));
		expect(await (await admin(location)).text()).toContain('<p class="notice">Deleted 1 page; its files will be cleaned up shortly.</p>');
		// The next action's redirect drops the last one's outcome, so it isn't said twice.
		const next = await post(`/pages/${a.id}/label`, csrf, ADMIN, { label: "alpha two" }, { referer: `${ADMIN}/?q=x&did=temporary&failed=${b.id}&cleanup=${c.id}&sig=abc` });
		expect(next.headers.get("location")).toBe(`/?q=x#p-${a.id}`);
		// Ids that aren't page ids never reach the page.
		expect(await (await admin("/?did=delete&failed=%3Cb%3E")).text()).not.toMatch(/<p class="error">Couldn't/);
	});
});
