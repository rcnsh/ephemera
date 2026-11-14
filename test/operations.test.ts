import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS } from "../src/domain.ts";
import { Operations } from "../src/operations.ts";
import { Pages } from "../src/pages.ts";

afterEach(() => reset());

const START = Date.UTC(2026, 0, 1);
const HTML = [{ path: "index.html", body: new TextEncoder().encode("<h1>hi</h1>") }];

/** Operations over a store with a clock the test moves by hand. */
function operations() {
	const clock = { now: START };
	const pages = new Pages(env, { now: () => clock.now, defer: () => {} });
	return { ops: new Operations(pages, "pages.example.com", "secret", () => clock.now), clock };
}

describe("lifetimes", () => {
	it("makes a permanent page temporary, and leaves a temporary one be", async () => {
		const { ops, clock } = operations();
		const page = await ops.publish({ files: HTML });
		clock.now += 1000;
		expect(await ops.makeTemporary(page.id)).toMatchObject({ permanent: false, expiresAt: clock.now + LIMITS.temporaryTtl });
		clock.now += 1000;
		expect(await ops.makeTemporary(page.id)).toMatchObject({ permanent: false, expiresAt: START + 1000 + LIMITS.temporaryTtl, updatedAt: START + 1000 });
	});

	it("extends by the ttls the dashboard offers", async () => {
		const { ops } = operations();
		const page = await ops.publish({ files: HTML, ttl: "1h" });
		expect((await ops.extend(page.id, "1d")).expiresAt).toBe(START + 25 * 3_600_000);
		expect(await ops.extend(page.id, "permanent")).toMatchObject({ permanent: true, expiresAt: null });
	});
});

describe("overview", () => {
	it("reads every live page with its versions, options and the usage at once", async () => {
		const { ops } = operations();
		const page = await ops.publish({ files: HTML, ttl: "1h" });
		await ops.update(page.id, HTML);
		const set = await ops.publishMockup({ project: "p", name: "n", files: [{ path: "a/index.html", body: new Uint8Array([1]) }] });
		await ops.delete((await ops.publish({ files: HTML })).id);

		const overview = await ops.overview();
		expect(overview.pages.map((p) => p.id)).toEqual([page.id, set.id]);
		expect(overview.versions.get(page.id)?.map((v) => v.version)).toEqual([2, 1]);
		expect(overview.options.get(set.id)?.map((o) => o.name)).toEqual(["a"]);
		expect(overview.usage).toMatchObject({ temporaryPages: 1, permanentPages: 0, mockups: 1 });

		const listed = await ops.list();
		expect(listed.pages.map((p) => p.id)).toEqual([page.id, set.id]);
		expect(listed.usage).toEqual(overview.usage);
	});
});
