import { createExecutionContext, createScheduledController, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { LIMITS } from "../src/domain.ts";
import { PAGES, api, call, objectCount, publish, zip } from "./helpers.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	await reset();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function sweep(now = Date.now()): Promise<void> {
	vi.spyOn(Date, "now").mockReturnValue(now);
	const ctx = createExecutionContext();
	await worker.scheduled(createScheduledController({ scheduledTime: now, cron: "*/10 * * * *" }), env, ctx);
	await waitOnExecutionContext(ctx);
	vi.restoreAllMocks();
}

describe("publishing", () => {
	it("returns a random 12-character id on pages.example.com with a 24 hour default ttl", async () => {
		const before = Date.now();
		const page = await publish({ label: "report", agent: "claude" });
		expect(page.id).toMatch(/^[a-z2-7]{12}$/);
		expect(page.url).toBe(`${PAGES}/${page.id}/`);
		expect(page.permanent).toBe(false);
		expect(page.expiresAt).toBeGreaterThanOrEqual(before + DAY);
		expect(page.expiresAt).toBeLessThanOrEqual(Date.now() + DAY);
		expect(page.label).toBe("report");
		expect(page.agent).toBe("claude");
	});

	it("accepts durations, seconds and permanent", async () => {
		expect((await publish({ ttl: "5m" })).expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
		expect((await publish({ ttl: 7200 })).expiresAt).toBeLessThanOrEqual(Date.now() + 2 * HOUR);
		const forever = await publish({ ttl: "permanent" });
		expect(forever.permanent).toBe(true);
		expect(forever.expiresAt).toBeNull();
	});

	it("rejects ttls outside 5 minutes to 30 days", async () => {
		for (const ttl of ["1m", "31d", "soon"]) {
			const response = await api("/pages", {
				method: "POST",
				body: JSON.stringify({ files: [{ path: "index.html", content: "x" }], ttl }),
			});
			expect(response.status, ttl).toBe(400);
		}
	});

	it("requires an index.html and safe paths", async () => {
		const cases = [
			[{ path: "page.html", content: "x" }],
			[{ path: "index.html", content: "x" }, { path: "../escape.txt", content: "x" }],
			[{ path: "index.html", content: "x" }, { path: "index.html", content: "y" }],
		];
		for (const files of cases) {
			const response = await api("/pages", { method: "POST", body: JSON.stringify({ files }) });
			expect(response.status).toBe(400);
		}
	});

	it("rejects pages with too many files", async () => {
		const files = Array.from({ length: LIMITS.pageFiles + 1 }, (_, i) => ({ path: i ? `f${i}.txt` : "index.html", content: "x" }));
		const response = await api("/pages", { method: "POST", body: JSON.stringify({ files }) });
		expect(response.status).toBe(413);
	});

	it("caps permanent pages at 25", async () => {
		for (let i = 0; i < LIMITS.permanentPages; i++) await publish({ ttl: "permanent" });
		const response = await api("/pages", {
			method: "POST",
			body: JSON.stringify({ files: [{ path: "index.html", content: "x" }], ttl: "permanent" }),
		});
		expect(response.status).toBe(409);
		expect(await response.text()).toMatch(/25 permanent/);
		await publish();
	});

	it("caps temporary pages at 100", async () => {
		for (let i = 0; i < LIMITS.temporaryPages; i++) await publish();
		const response = await api("/pages", { method: "POST", body: JSON.stringify({ files: [{ path: "index.html", content: "x" }] }) });
		expect(response.status).toBe(409);
		await publish({ ttl: "permanent" });
	});

	it("needs the bearer token", async () => {
		for (const authorization of ["", "Bearer wrong"]) {
			const response = await api("/pages", { headers: { authorization }, method: "GET" });
			expect(response.status).toBe(401);
		}
	});

	it("accepts a zip upload and strips a single top-level folder", async () => {
		const body = zip({ "site/index.html": "<p>zipped</p>", "site/css/app.css": "p{}", "__MACOSX/site/._index.html": "junk" });
		const response = await api("/pages?ttl=1h&label=zipped", { method: "POST", headers: { "content-type": "application/zip" }, body });
		expect(response.status).toBe(201);
		const page = (await response.json()) as { id: string; fileCount: number; label: string };
		expect(page.fileCount).toBe(2);
		expect(page.label).toBe("zipped");
		expect(await (await call(`${PAGES}/${page.id}/`)).text()).toContain("zipped");
		expect((await call(`${PAGES}/${page.id}/css/app.css`)).headers.get("content-type")).toMatch(/^text\/css/);
	});

	it("warns about root-relative links that the rewriter can't fix", async () => {
		const page = await publish({
			files: [
				{ path: "index.html", content: '<link href="/app.css"><script>fetch("/data.json")</script>' },
				{ path: "app.css", content: "body { background: url(/bg.png) }" },
				{ path: "app.js", content: 'import x from "/lib.js"; const ok = "//cdn.example/x.js";' },
			],
		});
		expect(page.warnings.join("\n")).toMatch(/app\.css.*\/bg\.png/);
		expect(page.warnings.join("\n")).toMatch(/app\.js.*\/lib\.js/);
		expect(page.warnings.join("\n")).toMatch(/index\.html.*\/data\.json/);
		expect(page.warnings.join("\n")).not.toMatch(/app\.css"/);
		expect(page.warnings.join("\n")).not.toMatch(/cdn\.example/);
	});
});

describe("serving", () => {
	it("serves files with the sandbox, noindex, CORS and no-cache headers", async () => {
		const page = await publish({
			files: [
				{ path: "index.html", content: "<h1>hi</h1>" },
				{ path: "docs/index.html", content: "<h1>docs</h1>" },
				{ path: "data.json", content: "{}" },
			],
		});
		const response = await call(`${PAGES}/${page.id}/`);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("<h1>hi</h1>");
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
		const csp = response.headers.get("content-security-policy")!;
		expect(csp).toMatch(/^sandbox allow-scripts allow-forms allow-popups allow-modals/);
		expect(csp).not.toContain("allow-same-origin");
		expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
		expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect((await call(`${PAGES}/${page.id}/missing.png`)).headers.get("cache-control")).toBe("no-store");

		expect(await (await call(`${PAGES}/${page.id}/docs/`)).text()).toContain("docs");
		expect((await call(`${PAGES}/${page.id}/data.json`)).headers.get("content-type")).toMatch(/^application\/json/);
		expect((await call(`${PAGES}/${page.id}/missing.png`)).status).toBe(404);
	});

	it("answers 304 for a file the browser already has, and 200 once it changes", async () => {
		const page = await publish();
		const first = await call(`${PAGES}/${page.id}/`);
		const etag = first.headers.get("etag")!;
		expect(etag).toBeTruthy();
		const again = await call(`${PAGES}/${page.id}/`, { headers: { "if-none-match": etag } });
		expect(again.status).toBe(304);
		expect(again.headers.get("etag")).toBe(etag);
		expect(again.headers.get("content-security-policy")).toMatch(/^sandbox/);

		await api(`/pages/${page.id}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ files: [{ path: "index.html", content: "<h1>v2</h1>" }] }),
		});
		const changed = await call(`${PAGES}/${page.id}/`, { headers: { "if-none-match": etag } });
		expect(changed.status).toBe(200);
		expect(await changed.text()).toContain("v2");
	});

	it("gzips text files itself and keeps their ETag", async () => {
		const page = await publish({ files: [{ path: "index.html", content: "<h1>hi</h1>".repeat(100) }, { path: "a.png", content: "iVBORw0KGgo=", encoding: "base64" }] });
		const zipped = await call(`${PAGES}/${page.id}/`, { headers: { "accept-encoding": "gzip, br" } });
		expect(zipped.headers.get("content-encoding")).toBe("gzip");
		expect(zipped.headers.get("vary")).toMatch(/accept-encoding/i);
		expect(zipped.headers.get("etag")).toBeTruthy();
		const body = await new Response(zipped.body!.pipeThrough(new DecompressionStream("gzip"))).text();
		expect(body).toContain("<h1>hi</h1>");

		const plain = await call(`${PAGES}/${page.id}/`);
		expect(plain.headers.get("content-encoding")).toBeNull();
		expect(await plain.text()).toContain("<h1>hi</h1>");
		expect((await call(`${PAGES}/${page.id}/a.png`, { headers: { "accept-encoding": "gzip" } })).headers.get("content-encoding")).toBeNull();
	});

	it("redirects /<id> and folders without a trailing slash", async () => {
		const page = await publish({ files: [{ path: "index.html", content: "x" }, { path: "docs/index.html", content: "y" }] });
		const bare = await call(`${PAGES}/${page.id}`);
		expect(bare.status).toBe(301);
		expect(bare.headers.get("location")).toBe(`/${page.id}/`);
		const folder = await call(`${PAGES}/${page.id}/docs?x=1`);
		expect(folder.status).toBe(301);
		expect(folder.headers.get("location")).toBe(`/${page.id}/docs/?x=1`);
	});

	it("rewrites root-relative links in HTML attributes", async () => {
		const page = await publish({
			files: [
				{
					path: "index.html",
					content: [
						'<link rel="stylesheet" href="/style.css">',
						'<img src="/a.png" srcset="/a.png 1x, /a@2x.png 2x">',
						'<a href="//example.com/x">ext</a><a href="relative.html">rel</a><a href="#top">top</a>',
						'<form action="/submit"></form>',
					].join(""),
				},
			],
		});
		const html = await (await call(`${PAGES}/${page.id}/`)).text();
		const p = `/${page.id}`;
		expect(html).toContain(`href="${p}/style.css"`);
		expect(html).toContain(`src="${p}/a.png"`);
		expect(html).toContain(`srcset="${p}/a.png 1x, ${p}/a@2x.png 2x"`);
		expect(html).toContain(`action="${p}/submit"`);
		expect(html).toContain('href="//example.com/x"');
		expect(html).toContain('href="relative.html"');
		expect(html).toContain('href="#top"');
	});

	it("doesn't rewrite links that already point inside the page", async () => {
		const page = await publish({ files: [{ path: "index.html", content: "" }] });
		await api(`/pages/${page.id}`, {
			method: "PUT",
			body: JSON.stringify({ files: [{ path: "index.html", content: `<a href="/${page.id}/x.html">x</a>` }] }),
		});
		expect(await (await call(`${PAGES}/${page.id}/`)).text()).toContain(`href="/${page.id}/x.html"`);
	});

	it("answers 404 for unknown ids and non-page paths", async () => {
		for (const path of ["/aaaaaaaaaaaa/", "/favicon.ico", "/wp-admin", "/short/"]) {
			const response = await call(`${PAGES}${path}`);
			expect(response.status, path).toBe(404);
		}
	});

	it("puts the sandbox header on every response from the pages host", async () => {
		const page = await publish();
		const deleted = await publish();
		await api(`/pages/${deleted.id}`, { method: "DELETE" });
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
		const paths = ["/", "/cat.jpg", `/${page.id}`, `/${page.id}/`, `/${page.id}/nope`, `/${deleted.id}/`, "/nope", "/api/pages", "/mcp"];
		for (const path of paths) {
			const response = await call(`${PAGES}${path}`);
			const csp = response.headers.get("content-security-policy") ?? "";
			expect(csp, path).toMatch(/^sandbox /);
			expect(csp, path).not.toContain("allow-same-origin");
			expect(response.headers.get("set-cookie"), path).toBeNull();
		}
	});
});

describe("updating and expiry", () => {
	it("replaces files at the same URL without touching the expiry", async () => {
		const page = await publish({ ttl: "2h" });
		const response = await api(`/pages/${page.id}`, {
			method: "PUT",
			body: JSON.stringify({ files: [{ path: "index.html", content: "<p>v2</p>" }, { path: "extra.txt", content: "new" }] }),
		});
		expect(response.status).toBe(200);
		const updated = (await response.json()) as { url: string; expiresAt: number; fileCount: number };
		expect(updated.url).toBe(page.url);
		expect(updated.expiresAt).toBe(page.expiresAt);
		expect(updated.fileCount).toBe(2);
		expect(await (await call(page.url)).text()).toBe("<p>v2</p>");
		// The first version's index.html is kept for rollback.
		expect(await objectCount(page.id)).toBe(3);
	});

	it("lists versions and rolls back to one", async () => {
		const page = await publish({ files: [{ path: "index.html", content: "v1" }] });
		await api(`/pages/${page.id}`, { method: "PUT", body: JSON.stringify({ files: [{ path: "index.html", content: "v2" }] }) });
		const versions = (await (await api(`/pages/${page.id}/versions`)).json()) as { versions: { version: number; current: boolean }[] };
		expect(versions.versions.map((v) => [v.version, v.current])).toEqual([
			[2, true],
			[1, false],
		]);

		const rolledBack = await api(`/pages/${page.id}/rollback`, { method: "POST", body: JSON.stringify({ version: 1 }) });
		expect(rolledBack.status).toBe(200);
		expect(((await rolledBack.json()) as { version: number }).version).toBe(1);
		expect(await (await call(page.url)).text()).toBe("v1");

		expect((await api(`/pages/${page.id}/rollback`, { method: "POST", body: JSON.stringify({ version: 9 }) })).status).toBe(404);
		expect((await api(`/pages/${page.id}/rollback`, { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
	});

	it("extends from the current expiry, capped at 30 days from now", async () => {
		const page = await publish({ ttl: "1h" });
		const extended = (await (await api(`/pages/${page.id}`, { method: "PATCH", body: JSON.stringify({ ttl: "1d" }) })).json()) as { expiresAt: number };
		expect(extended.expiresAt).toBe(page.expiresAt! + DAY);
		const capped = (await (await api(`/pages/${page.id}`, { method: "PATCH", body: JSON.stringify({ ttl: "30d" }) })).json()) as { expiresAt: number };
		expect(capped.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * DAY);
	});

	it("switches between permanent and temporary", async () => {
		const page = await publish();
		const forever = (await (await api(`/pages/${page.id}`, { method: "PATCH", body: JSON.stringify({ ttl: "permanent" }) })).json()) as { permanent: boolean };
		expect(forever.permanent).toBe(true);
		const back = (await (await api(`/pages/${page.id}`, { method: "PATCH", body: JSON.stringify({ ttl: "2h" }) })).json()) as { permanent: boolean; expiresAt: number };
		expect(back.permanent).toBe(false);
		expect(back.expiresAt).toBeLessThanOrEqual(Date.now() + 2 * HOUR);
	});

	it("deletes a page immediately", async () => {
		const page = await publish();
		const response = await api(`/pages/${page.id}`, { method: "DELETE" });
		expect(response.status).toBe(200);
		expect((await call(page.url)).status).toBe(410);
		expect(await objectCount(page.id)).toBe(0);
		expect((await api(`/pages/${page.id}`, { method: "DELETE" })).status).toBe(410);
	});

	it("purges expired pages on the cron schedule", async () => {
		const page = await publish({ ttl: "1h" });
		await sweep(Date.now() + 2 * HOUR);
		expect(await objectCount(page.id)).toBe(0);
	});

	it("lists live pages soonest-expiring first, with usage", async () => {
		const later = await publish({ ttl: "3h", label: "later" });
		const sooner = await publish({ ttl: "1h", label: "sooner" });
		const forever = await publish({ ttl: "permanent", label: "forever" });
		const gone = await publish();
		await api(`/pages/${gone.id}`, { method: "DELETE" });
		const body = (await (await api("/pages")).json()) as { pages: { id: string }[]; usage: { temporaryPages: number; permanentPages: number; bytes: number } };
		expect(body.pages.map((p) => p.id)).toEqual([sooner.id, later.id, forever.id]);
		expect(body.usage).toMatchObject({ temporaryPages: 2, permanentPages: 1 });
		expect(body.usage.bytes).toBeGreaterThan(0);
	});
});
