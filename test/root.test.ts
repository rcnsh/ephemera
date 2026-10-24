import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGES, call } from "./helpers.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	await reset();
});

describe("the cat at p.rcn.sh/", () => {
	it("serves a page showing /cat.jpg, uncached", async () => {
		const response = await call(`${PAGES}/`);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const html = await response.text();
		expect(html).toMatch(/<img[^>]+src="\/cat\.jpg\?/);
		expect(html).not.toMatch(/ephemera/i);
	});

	it("proxies a cat from cataas", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("JPEGDATA", { headers: { "content-type": "image/jpeg" } }));
		const response = await call(`${PAGES}/cat.jpg`);
		expect(String(fetch.mock.calls[0]![0])).toMatch(/^https:\/\/cataas\.com\/cat/);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/jpeg");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).toBe("JPEGDATA");
	});

	it("falls back to a built-in SVG cat when cataas fails", async () => {
		for (const failure of [() => Promise.reject(new Error("down")), () => Promise.resolve(new Response("nope", { status: 503 })), () => Promise.resolve(new Response("<html>", { headers: { "content-type": "text/html" } }))]) {
			vi.spyOn(globalThis, "fetch").mockImplementation(failure);
			const response = await call(`${PAGES}/cat.jpg`);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("image/svg+xml");
			expect(await response.text()).toContain("<svg");
			vi.restoreAllMocks();
		}
	});

	it("doesn't serve cats on other hosts or paths", async () => {
		expect((await call("https://elsewhere.example/")).status).toBe(404);
		expect((await call(`${PAGES}/cat.png`)).status).toBe(404);
	});
});
