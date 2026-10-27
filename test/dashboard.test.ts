import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screenshot } from "../src/thumbnails.ts";
import { ADMIN, api, call, PAGES, publish } from "./helpers.ts";

afterEach(async () => {
	vi.mocked(screenshot).mockReset().mockResolvedValue(null);
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

function post(path: string, csrf: string, origin = ADMIN, fields: Record<string, string> = {}): Promise<Response> {
	return admin(path, {
		method: "POST",
		headers: { origin, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ csrf, ...fields }),
	});
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
		await publish({ label: "quarterly report", agent: "codex" });
		await publish({ ttl: "permanent", label: "keeper" });
		const response = await admin();
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("quarterly report");
		expect(html).toContain("codex");
		expect(html).toContain("permanent");
		expect(html).toMatch(/1\s*\/\s*100 temporary/);
		expect(html).toMatch(/1\s*\/\s*25 permanent/);
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
		expect(extended.headers.get("location")).toBe("/");

		expect((await post(`/pages/${page.id}/permanent`, csrf)).status).toBe(303);
		expect(await (await admin()).text()).toMatch(/permanent/);
		expect((await post(`/pages/${page.id}/temporary`, csrf)).status).toBe(303);

		expect((await post(`/pages/${page.id}/delete`, csrf)).status).toBe(303);
		expect((await call(page.url)).status).toBe(410);
	});

	it("shows a card per page with a thumbnail, search and an agent filter", async () => {
		const page = await publish({ label: "chart", agent: "codex" });
		await publish({ agent: "claude-code" });
		const html = await (await admin()).text();
		expect(html).toContain(`<img src="/thumbnails/${page.id}.png?v=1"`);
		expect(html).toContain('id="search"');
		expect(html).toMatch(/<option>claude-code<\/option><option>codex<\/option>/);
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

	it("makes a thumbnail once per version, and doesn't cache a failed one", async () => {
		const png = new Uint8Array([137, 80, 78, 71]);
		vi.mocked(screenshot).mockResolvedValue(png);
		const page = await publish();

		const first = await admin(`/thumbnails/${page.id}.png`);
		expect(first.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await first.arrayBuffer())).toEqual(png);
		expect(vi.mocked(screenshot).mock.calls[0]![1]).toBe(page.url);
		await admin(`/thumbnails/${page.id}.png`);
		expect(screenshot).toHaveBeenCalledTimes(1);

		await api(`/pages/${page.id}`, { method: "PUT", body: JSON.stringify({ html: "v2" }) });
		vi.mocked(screenshot).mockResolvedValue(null);
		const failed = await admin(`/thumbnails/${page.id}.png`);
		expect(failed.headers.get("content-type")).toBe("image/svg+xml");
		expect(failed.headers.get("cache-control")).toBe("no-store");
		await admin(`/thumbnails/${page.id}.png`);
		expect(screenshot).toHaveBeenCalledTimes(3);
		expect((await admin(`/thumbnails/${page.id}.png`, {}, null)).status).toBe(403);
	});

	it("shoots private pages through a short-lived pass", async () => {
		vi.mocked(screenshot).mockResolvedValue(new Uint8Array([1]));
		const page = await publish({ visibility: "private" });
		await admin(`/thumbnails/${page.id}.png`);
		const url = vi.mocked(screenshot).mock.calls[0]![1];
		expect(url).toMatch(new RegExp(`/${page.id}/~`));
		expect((await call(url)).status).toBe(200);
	});
});

describe("renaming through the API", () => {
	it("takes a label in PATCH, with or without a ttl", async () => {
		const page = await publish({ ttl: "1h" });
		const renamed = (await (await api(`/pages/${page.id}`, { method: "PATCH", body: JSON.stringify({ label: "x" }) })).json()) as { label: string; expiresAt: number };
		expect(renamed).toMatchObject({ label: "x", expiresAt: page.expiresAt });
		const both = (await (await api(`/pages/${page.id}`, { method: "PATCH", body: JSON.stringify({ label: "y", ttl: "1h" }) })).json()) as { label: string; expiresAt: number };
		expect(both.label).toBe("y");
		expect(both.expiresAt).toBe(page.expiresAt! + 3_600_000);
	});
});
