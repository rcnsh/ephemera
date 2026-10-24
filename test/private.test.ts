import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN, PAGES, api, call, publish } from "./helpers.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	await reset();
});

const AUD = "test-aud";
const FILES = [
	{ path: "index.html", content: '<link rel="stylesheet" href="/app.css"><a href="docs">docs</a>' },
	{ path: "app.css", content: "body{}" },
	{ path: "docs/index.html", content: "<h1>docs</h1>" },
];

function post(path: string, body: unknown): Promise<Response> {
	return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function shareLink(id: string, ttl?: string): Promise<{ url: string; expiresAt: number }> {
	return (await post(`/pages/${id}/share`, ttl ? { ttl } : {})).json();
}

function unlock(id: string, password: string, next = ""): Promise<Response> {
	return call(`${PAGES}/${id}/_unlock`, { method: "POST", body: new URLSearchParams({ password, next }) });
}

describe("private pages", () => {
	it("answer every path with a gate that links to signing in", async () => {
		const page = await publish({ files: FILES, visibility: "private", label: "secret plans" });
		expect(page).toMatchObject({ visibility: "private", hasPassword: false });
		for (const path of ["", "app.css", "docs/"]) {
			const response = await call(`${PAGES}/${page.id}/${path}`);
			expect(response.status, path).toBe(401);
			const html = await response.text();
			expect(html).not.toContain("body{}");
			expect(html).toContain(`href="${ADMIN}/open/${page.id}/${path}"`);
			expect(html).not.toContain("<form");
			expect(html).not.toContain("secret plans");
			expect(response.headers.get("content-security-policy")).toMatch(/^sandbox/);
		}
	});

	it("serve the page, its files and its links behind a share link", async () => {
		const page = await publish({ files: FILES, visibility: "private" });
		const link = await shareLink(page.id, "2h");
		expect(link.url).toMatch(new RegExp(`^${PAGES}/${page.id}/~[0-9a-z]+\\.[A-Za-z0-9]+/$`));
		const pass = new URL(link.url).pathname.split("/")[2]!;

		const index = await call(link.url);
		expect(index.status).toBe(200);
		expect(index.headers.get("cache-control")).toBe("private, no-cache, no-transform");
		expect(await index.text()).toContain(`href="/${page.id}/${pass}/app.css"`);
		expect(await (await call(`${link.url}app.css`)).text()).toBe("body{}");

		const folder = await call(`${link.url}docs`);
		expect(folder.status).toBe(301);
		expect(folder.headers.get("location")).toBe(`/${page.id}/${pass}/docs/`);
		const bare = await call(link.url.slice(0, -1));
		expect(bare.headers.get("location")).toBe(`/${page.id}/${pass}/`);
	});

	it("turn away forged and expired passes", async () => {
		const page = await publish({ files: FILES, visibility: "private" });
		const link = await shareLink(page.id, "1h");
		const forged = link.url.replace(/\.[A-Za-z0-9]+\/$/, ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/");
		expect((await call(forged)).status).toBe(401);
		const other = await publish({ visibility: "private" });
		expect((await call(link.url.replace(page.id, other.id))).status).toBe(401);

		vi.spyOn(Date, "now").mockReturnValue(link.expiresAt + 1);
		const expired = await call(link.url);
		expect(expired.status).toBe(401);
		expect(await expired.text()).toContain("expired or been revoked");
	});

	it("open through the dashboard host for whoever Access let in", async () => {
		const page = await publish({ files: FILES, visibility: "private" });
		expect((await call(`${ADMIN}/open/${page.id}/docs/`)).status).toBe(403);
		const opened = await call(`${ADMIN}/open/${page.id}/docs/`, {}, { accessAud: AUD });
		expect(opened.status).toBe(302);
		const location = opened.headers.get("location")!;
		expect(location).toMatch(new RegExp(`^${PAGES}/${page.id}/~.+/docs/$`));
		expect(await (await call(location)).text()).toBe("<h1>docs</h1>");

		const pub = await publish();
		expect((await call(`${ADMIN}/open/${pub.id}/`, {}, { accessAud: AUD })).headers.get("location")).toBe(pub.url);
	});

	it("unlock with the password", async () => {
		const page = await publish({ files: FILES, password: "correct horse" });
		expect(page).toMatchObject({ visibility: "private", hasPassword: true });
		const gate = await (await call(`${PAGES}/${page.id}/docs/`)).text();
		expect(gate).toContain(`action="/${page.id}/_unlock"`);
		expect(gate).toContain('name="next" value="docs/"');

		const wrong = await unlock(page.id, "wrong password");
		expect(wrong.status).toBe(401);
		expect(await wrong.text()).toContain("Wrong password");

		const right = await unlock(page.id, "correct horse", "docs/");
		expect(right.status).toBe(303);
		const location = right.headers.get("location")!;
		expect(location).toMatch(new RegExp(`/${page.id}/~.+/docs/$`));
		expect(await (await call(location)).text()).toBe("<h1>docs</h1>");

		expect((await unlock(page.id, "correct horse", "../../elsewhere")).headers.get("location")).toMatch(new RegExp(`/${page.id}/~[^/]+/$`));
	});

	it("check passwords and visibilities", async () => {
		const bad = [{ password: "short" }, { visibility: "public", password: "long enough" }, { visibility: "secret" }, { password: 12345678 }];
		for (const body of bad) {
			expect((await post("/pages", { html: "x", ...body })).status, JSON.stringify(body)).toBe(400);
		}
	});

	it("revoke share links when the visibility is set again, and drop passes once public", async () => {
		const page = await publish({ files: FILES, visibility: "private" });
		const link = await shareLink(page.id);
		expect((await post(`/pages/${page.id}/visibility`, { visibility: "private" })).status).toBe(200);
		expect((await call(link.url)).status).toBe(401);

		const fresh = await shareLink(page.id);
		const made = (await (await post(`/pages/${page.id}/visibility`, { visibility: "public" })).json()) as { visibility: string };
		expect(made.visibility).toBe("public");
		const dropped = await call(`${fresh.url}docs/`);
		expect(dropped.status).toBe(301);
		expect(dropped.headers.get("location")).toBe(`/${page.id}/docs/`);
		expect((await call(page.url)).status).toBe(200);
		expect((await shareLink(page.id)).url).toBe(page.url);
	});

	it("clear the password when made public, and keep it off public pages", async () => {
		const page = await publish({ password: "correct horse" });
		const made = (await (await post(`/pages/${page.id}/visibility`, { visibility: "public" })).json()) as { hasPassword: boolean };
		expect(made.hasPassword).toBe(false);
		expect((await unlock(page.id, "correct horse")).status).toBe(303);
	});
});
