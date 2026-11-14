import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/domain.ts";
import type { Page } from "../src/pages.ts";
import { access, viewerUrl } from "../src/privacy.ts";

const SECRET = "secret";
const HOST = "pages.example.com";
const NOW = Date.UTC(2026, 0, 1);

function page(overrides: Partial<Page> = {}): Page {
	return {
		id: "abcdefghijkl",
		label: null,
		agent: null,
		createdAt: NOW,
		updatedAt: NOW,
		expiresAt: null,
		permanent: true,
		size: 1,
		fileCount: 1,
		version: 1,
		latestVersion: 1,
		visibility: "public",
		passwordHash: null,
		shareEpoch: 0,
		kind: "page",
		project: null,
		...overrides,
	};
}

/** The pass in a viewer URL for `of`, minted at `at` for `ttl`. */
async function passFor(of: Page, at = NOW, ttl?: number): Promise<string> {
	const url = await viewerUrl(SECRET, HOST, of, at, ttl === undefined ? {} : { ttl });
	return new URL(url).pathname.split("/")[2]!;
}

describe("access", () => {
	it("serves a public page to anyone, and drops a pass from its path", async () => {
		const open = page();
		expect(await access(SECRET, open, "docs/a.html", "", NOW)).toEqual({ kind: "serve", rest: "docs/a.html", base: `/${open.id}`, pass: null });
		const pass = await passFor(page({ visibility: "private" }));
		expect(await access(SECRET, open, `${pass}/docs/`, "?x=1", NOW)).toEqual({ kind: "redirect", location: `/${open.id}/docs/?x=1` });
		// Even an unsigned pass-shaped segment can't send the redirect off to another page.
		expect(await access(SECRET, open, "~a.b/../zzzzzzzzzzzz/", "", NOW)).toEqual({ kind: "redirect", location: `/${open.id}/` });
	});

	it("gates a private page without a pass", async () => {
		expect(await access(SECRET, page({ visibility: "private" }), "docs/", "", NOW)).toEqual({ kind: "gate", rest: "docs/" });
	});

	it("serves a private page behind a valid pass, under a base that keeps it", async () => {
		const closed = page({ visibility: "private" });
		const pass = await passFor(closed);
		expect(await access(SECRET, closed, `${pass}/docs/a.html`, "", NOW + 1000)).toEqual({ kind: "serve", rest: "docs/a.html", base: `/${closed.id}/${pass}`, pass });
		expect(await access(SECRET, closed, pass, "?x=1", NOW)).toEqual({ kind: "redirect", location: `/${closed.id}/${pass}/?x=1` });
	});

	it("gates an expired, revoked or forged pass, keeping the path", async () => {
		const closed = page({ visibility: "private" });
		const gated = { kind: "gate", rest: "docs/", message: "This link has expired or been revoked." };
		const pass = await passFor(closed, NOW, 60_000);
		expect(await access(SECRET, closed, `${pass}/docs/`, "", NOW + 60_001)).toEqual(gated);
		expect(await access(SECRET, { ...closed, shareEpoch: 1 }, `${pass}/docs/`, "", NOW)).toEqual(gated);
		expect(await access("other secret", closed, `${pass}/docs/`, "", NOW)).toEqual(gated);
		expect(await access(SECRET, page({ id: "zzzzzzzzzzzz", visibility: "private" }), `${pass}/docs/`, "", NOW)).toEqual(gated);
	});
});

describe("viewer URLs", () => {
	it("are the plain URL of a public page, at a path inside it", async () => {
		expect(await viewerUrl(SECRET, HOST, page(), NOW, { rest: "a/" })).toBe(`https://${HOST}/abcdefghijkl/a/`);
	});

	it("put a private page behind a pass that lasts as long as asked, signing in's by default", async () => {
		const closed = page({ visibility: "private" });
		const url = await viewerUrl(SECRET, HOST, closed, NOW, { rest: "a/" });
		expect(url).toMatch(new RegExp(`^https://${HOST}/abcdefghijkl/~[^/]+/a/$`));
		const pass = new URL(url).pathname.split("/")[2]!;
		expect((await access(SECRET, closed, `${pass}/`, "", NOW + LIMITS.passTtl - 1)).kind).toBe("serve");
		expect((await access(SECRET, closed, `${pass}/`, "", NOW + LIMITS.passTtl)).kind).toBe("gate");
		const short = await passFor(closed, NOW, 1000);
		expect((await access(SECRET, closed, `${short}/`, "", NOW + 1000)).kind).toBe("gate");
	});

	it("drop a path that could leave the page", async () => {
		for (const rest of ["../x", "a/../../x", "a\\b", "./x"]) {
			expect(await viewerUrl(SECRET, HOST, page(), NOW, { rest })).toBe(`https://${HOST}/abcdefghijkl/`);
			expect(await viewerUrl(SECRET, HOST, page({ visibility: "private" }), NOW, { rest })).toMatch(/\/~[^/]+\/$/);
		}
	});
});
