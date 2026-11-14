import { createExecutionContext, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { Pages } from "../src/pages.ts";
import worker from "../src/index.ts";
import { api, PAGES } from "./helpers.ts";

afterEach(() => reset());

/**
 * What serving costs in storage calls: an env whose D1 and R2 count what's
 * asked of them, so a change that adds a round trip per request shows here.
 */
function counted() {
	const calls = { d1: 0, r2: 0 };
	const DB = new Proxy(env.DB, {
		get(target, name) {
			const value = Reflect.get(target, name);
			if (name === "prepare") return (sql: string) => (calls.d1++, target.prepare(sql));
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const BUCKET = new Proxy(env.BUCKET, {
		get(target, name) {
			const value = Reflect.get(target, name);
			if (name === "get" || name === "head" || name === "list") return (...args: unknown[]) => (calls.r2++, (value as (...a: unknown[]) => unknown).apply(target, args));
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	async function get(path: string, headers: HeadersInit = {}): Promise<Response> {
		const request = new Request(`${PAGES}${path}`, { headers, redirect: "manual" });
		request.headers.set("host", new URL(PAGES).host);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request as Parameters<typeof worker.fetch>[0], { ...env, DB, BUCKET }, ctx);
		await response.arrayBuffer();
		await waitOnExecutionContext(ctx);
		return response;
	}
	return { calls, get };
}

async function publishFiles(files: { path: string; content: string }[], extra: Record<string, unknown> = {}, path = "/pages"): Promise<{ id: string; url: string }> {
	const response = await api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files, ...extra }) });
	if (response.status !== 201) throw new Error(`publish failed: ${response.status} ${await response.text()}`);
	return response.json();
}

const FILES = ["a.css", "b.js", "c.js", "d.svg", "e.json"];

describe("what serving a page costs", () => {
	it("looks a page up in D1 once for a burst of its files, 304s included", async () => {
		const page = await publishFiles([{ path: "index.html", content: "<h1>hi</h1>" }, ...FILES.map((path) => ({ path, content: path }))]);
		const { calls, get } = counted();
		const index = await get(`/${page.id}/`);
		for (const file of FILES) expect((await get(`/${page.id}/${file}`)).status).toBe(200);
		expect(calls.d1).toBe(1);
		await get(`/${page.id}/a.css`, { "if-none-match": index.headers.get("etag")! });
		expect((await get(`/${page.id}/`, { "if-none-match": index.headers.get("etag")! })).status).toBe(304);
		expect(calls.d1).toBe(1);
	});

	it("looks a mockup gallery up once for its index, every frame and their files", async () => {
		const options = ["a", "b", "c", "d", "e", "f"];
		const set = await publishFiles(
			options.flatMap((option) => [{ path: `${option}/index.html`, content: `<p>${option}</p>` }, ...FILES.slice(0, 4).map((file) => ({ path: `${option}/${file}`, content: file }))]),
			{ project: "costs", name: "gallery" },
			"/mockups",
		);
		const { calls, get } = counted();
		await get(`/${set.id}/`);
		for (const option of options) {
			await get(`/${set.id}/${option}/`);
			for (const file of FILES.slice(0, 4)) await get(`/${set.id}/${option}/${file}`);
		}
		// Index (page + options) is two queries; the 30 requests after it, none.
		expect(calls.d1).toBe(2);
	});

	it("reads R2 once for a missing file, then answers from the cache", async () => {
		const page = await publishFiles([{ path: "index.html", content: "<h1>hi</h1>" }]);
		const { calls, get } = counted();
		expect((await get(`/${page.id}/nope.css`)).status).toBe(404);
		// The file, then whether it's a folder (nope.css/index.html).
		const first = calls.r2;
		expect(first).toBe(2);
		expect((await get(`/${page.id}/nope.css`)).status).toBe(404);
		expect(calls.r2).toBe(first);
	});

	it("checks a folder without its slash in R2 once", async () => {
		const page = await publishFiles([{ path: "index.html", content: "<h1>hi</h1>" }, { path: "docs/index.html", content: "docs" }]);
		const { calls, get } = counted();
		expect((await get(`/${page.id}/docs`)).status).toBe(301);
		expect((await get(`/${page.id}/nothing`)).status).toBe(404);
		const first = calls.r2;
		expect((await get(`/${page.id}/docs`)).status).toBe(301);
		expect((await get(`/${page.id}/nothing`)).status).toBe(404);
		expect(calls.r2).toBe(first);
	});

	it("keeps a private page's cached 404 behind its gate", async () => {
		const page = await publishFiles([{ path: "index.html", content: "<h1>hi</h1>" }], { visibility: "private" });
		const share = (await (await api(`/pages/${page.id}/share`, { method: "POST", body: "{}" })).json()) as { url: string };
		const { get } = counted();
		expect((await get(`${new URL(share.url).pathname}nope.css`)).status).toBe(404);
		expect((await get(`/${page.id}/nope.css`)).status).toBe(401);
	});

	it("shows this isolate's own writes at once", async () => {
		const page = await publishFiles([{ path: "index.html", content: "v1" }]);
		const { get } = counted();
		expect((await get(`/${page.id}/`)).status).toBe(200);
		await api(`/pages/${page.id}/visibility`, { method: "POST", body: JSON.stringify({ visibility: "private" }) });
		expect((await get(`/${page.id}/`)).status).toBe(401);
		await api(`/pages/${page.id}/visibility`, { method: "POST", body: JSON.stringify({ visibility: "public" }) });
		await api(`/pages/${page.id}`, { method: "PUT", body: JSON.stringify({ html: "v2" }) });
		const response = await get(`/${page.id}/`);
		expect(response.headers.get("etag")).not.toBeNull();
		await api(`/pages/${page.id}`, { method: "DELETE" });
		expect((await get(`/${page.id}/`)).status).toBe(410);
	});
});

describe("the lookup memo", () => {
	function store(start: number) {
		const clock = { now: start };
		const queries = { n: 0 };
		const DB = new Proxy(env.DB, {
			get(target, name) {
				const value = Reflect.get(target, name);
				if (name === "prepare") return (sql: string) => (queries.n++, target.prepare(sql));
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		return { pages: new Pages({ DB, BUCKET: env.BUCKET }, { defer: () => {}, now: () => clock.now }), clock, queries };
	}

	it("still checks expiry against the time of each request", async () => {
		const { pages, clock, queries } = store(Date.now());
		const page = await pages.publish({ files: [{ path: "index.html", body: new Uint8Array([1]) }], ttl: 5 * 60_000 });
		queries.n = 0;
		clock.now = page.expiresAt! - 1_000;
		expect((await pages.lookup(page.id)).state).toBe("live");
		clock.now = page.expiresAt! - 1;
		expect((await pages.lookup(page.id)).state).toBe("live");
		clock.now = page.expiresAt!;
		expect((await pages.lookup(page.id)).state).toBe("gone");
		expect(queries.n).toBe(1);
	});

	it("reads D1 again once an entry is two seconds old, and always for writes", async () => {
		const { pages, clock, queries } = store(Date.now());
		const page = await pages.publish({ files: [{ path: "index.html", body: new Uint8Array([1]) }], ttl: "permanent" });
		queries.n = 0;
		await pages.lookup(page.id);
		await pages.lookup(page.id);
		expect(queries.n).toBe(1);
		clock.now += 2_000;
		await pages.lookup(page.id);
		expect(queries.n).toBe(2);
		await pages.get(page.id);
		expect(queries.n).toBe(3);
	});

	it("takes a change made elsewhere up to its lifetime to show", async () => {
		const { pages, clock } = store(Date.now());
		const page = await pages.publish({ files: [{ path: "index.html", body: new Uint8Array([1]) }], ttl: "permanent" });
		await pages.lookup(page.id);
		await env.DB.prepare("UPDATE pages SET visibility = 'private' WHERE id = ?").bind(page.id).run();
		expect(((await pages.lookup(page.id)) as { page: { visibility: string } }).page.visibility).toBe("public");
		clock.now += 2_000;
		expect(((await pages.lookup(page.id)) as { page: { visibility: string } }).page.visibility).toBe("private");
	});

	it("stays bounded", async () => {
		const { pages, queries } = store(Date.now());
		const page = await pages.publish({ files: [{ path: "index.html", body: new Uint8Array([1]) }], ttl: "permanent" });
		await pages.lookup(page.id);
		// 500 other ids, each 12 characters of the id alphabet.
		const letters = "abcdefghijklmnopqrstuvwxyz";
		for (let i = 0; i < 500; i++) await pages.lookup(`zzzzzzzzzz${letters[Math.floor(i / 26)]}${letters[i % 26]}`);
		queries.n = 0;
		await pages.lookup(page.id);
		expect(queries.n).toBe(1);
	});
});
