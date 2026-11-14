import { reset, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { screenshots } from "../src/thumbnails.ts";
import { ADMIN, publish } from "./helpers.ts";

/**
 * Thumbnail requests as browsers send them: each through `SELF`, so each has
 * a request context of its own, as in production. (`call` in helpers.ts runs
 * every request inside the test's one context, which hides any request that
 * waits on work another request's context owns.) SELF requests don't come
 * through Access, so this lends them the Access context the dashboard checks.
 */
const original = worker.fetch;
beforeAll(() => {
	worker.fetch = ((request, env, ctx) => {
		if (new URL(request.url).hostname === new URL(ADMIN).hostname) {
			Object.defineProperty(ctx, "access", { value: { aud: "test-aud", getIdentity: async () => ({ email: "owner@example.com" }) } });
		}
		return original.call(worker, request, env, ctx);
	}) as typeof worker.fetch;
});
afterAll(() => {
	worker.fetch = original;
});

afterEach(async () => {
	vi.mocked(screenshots).mockReset().mockImplementation(async (_browser, shots) => shots.map(() => null));
	await reset();
});

function thumbnail(id: string): Promise<Response> {
	return SELF.fetch(`${ADMIN}/thumbnails/${id}.png`);
}

/** A browser that takes `ms` a shot, and draws each page as one byte. */
function slowBrowser(ms: number) {
	vi.mocked(screenshots).mockImplementation(async (_browser, shots) => {
		const pngs = [];
		for (const _ of shots) {
			await new Promise((resolve) => setTimeout(resolve, ms));
			pngs.push(new Uint8Array([7]));
		}
		return pngs;
	});
}

describe("thumbnails asked for at once, each in its own request", () => {
	it("all come back, from one browser launch", async () => {
		const ids = (await Promise.all([1, 2, 3, 4, 5].map(() => publish()))).map((page) => page.id);
		slowBrowser(300);
		const responses = await Promise.all(ids.map(thumbnail));
		expect(responses.map((response) => [response.status, response.headers.get("content-type")])).toEqual(ids.map(() => [200, "image/png"]));
		for (const response of responses) expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([7]));
		expect(screenshots).toHaveBeenCalledTimes(1);

		// And the next load is served from what was kept, without a browser.
		const again = await Promise.all(ids.map(thumbnail));
		expect(again.map((response) => response.status)).toEqual(ids.map(() => 200));
		await Promise.all(again.map((response) => response.arrayBuffer()));
		expect(screenshots).toHaveBeenCalledTimes(1);
	});

	it("leave nothing stuck when the request shooting them goes away", async () => {
		const ids = (await Promise.all([1, 2, 3].map(() => publish()))).map((page) => page.id);
		slowBrowser(300);
		// The first request starts shooting, and its client leaves at once.
		const abort = new AbortController();
		const first = SELF.fetch(`${ADMIN}/thumbnails/${ids[0]}.png`, { signal: abort.signal }).catch(() => null);
		await new Promise((resolve) => setTimeout(resolve, 150));
		abort.abort();
		await first;
		const responses = await Promise.all(ids.map(thumbnail));
		expect(responses.map((response) => response.status)).toEqual(ids.map(() => 200));
		await Promise.all(responses.map((response) => response.arrayBuffer()));
	});
});
