import { env, reset } from "cloudflare:test";
import { zipSync, strToU8 } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { checkUploadToken } from "../src/auth.ts";
import { LIMITS, PageError } from "../src/domain.ts";
import { Operations } from "../src/operations.ts";
import { Pages } from "../src/pages.ts";

/** Background work (pruning, cache fills), settled before the next test wipes the store. */
const deferred: Promise<unknown>[] = [];

afterEach(async () => {
	await Promise.allSettled(deferred.splice(0));
	await reset();
});

const START = Date.UTC(2026, 0, 1);
const HTML = { html: "<h1>hi</h1>" };
const iso = (ms: number) => new Date(ms).toISOString();

/** Operations over a store with a clock the test moves by hand. */
function operations() {
	const clock = { now: START };
	const pages = new Pages(env, { now: () => clock.now, defer: (work) => deferred.push(work) });
	return { ops: new Operations(pages, "pages.example.com", "secret", () => clock.now), clock };
}

describe("lifetimes", () => {
	it("makes a permanent page temporary, and leaves a temporary one be", async () => {
		const { ops, clock } = operations();
		const page = await ops.publish({ content: HTML });
		clock.now += 1000;
		expect(await ops.makeTemporary(page.id)).toMatchObject({ permanent: false, expiresAt: iso(clock.now + LIMITS.temporaryTtl) });
		clock.now += 1000;
		expect(await ops.makeTemporary(page.id)).toMatchObject({ permanent: false, expiresAt: iso(START + 1000 + LIMITS.temporaryTtl), updatedAt: iso(START + 1000) });
	});

	it("extends by the ttls the dashboard offers", async () => {
		const { ops } = operations();
		const page = await ops.publish({ content: HTML, ttl: "1h" });
		expect((await ops.extend(page.id, "1d")).expiresAt).toBe(iso(START + 25 * 3_600_000));
		expect(await ops.extend(page.id, "permanent")).toMatchObject({ permanent: true, expiresAt: null });
	});
});

describe("overview", () => {
	it("reads every live page with its versions, options and the usage at once", async () => {
		const { ops } = operations();
		const page = await ops.publish({ content: HTML, ttl: "1h" });
		await ops.update(page.id, HTML);
		const set = await ops.publishMockup({ project: "p", name: "n", content: { files: [{ path: "a/index.html", content: "a" }] } });
		await ops.delete((await ops.publish({ content: HTML })).id);

		const overview = await ops.overview();
		expect(overview.pages.map((p) => p.id)).toEqual([page.id, set.id]);
		expect(overview.versions.get(page.id)?.map((v) => v.version)).toEqual([2, 1]);
		expect(overview.options.get(set.id)?.map((o) => o.name)).toEqual(["a"]);
		expect(overview.usage).toMatchObject({ temporaryPages: 1, permanentPages: 0, mockups: 1 });

		const listed = await ops.list();
		// The dashboard's overview keeps its own order; the agents' list is newest-updated first.
		expect(new Set(listed.pages.map((p) => p.id))).toEqual(new Set([page.id, set.id]));
		expect(listed.usage).toEqual(overview.usage);
	});
});

/** The status of the PageError `work` fails with. */
async function status(work: Promise<unknown>): Promise<number> {
	try {
		await work;
	} catch (error) {
		if (error instanceof PageError) return error.status;
		throw error;
	}
	throw new Error("expected a PageError");
}

describe("content", () => {
	const zip = zipSync({ "site/index.html": strToU8("<h1>zipped</h1>") });

	it("takes files, html, markdown or a zip, whichever adapter sent them", async () => {
		const { ops } = operations();
		const files = await ops.publish({ content: { files: [{ path: "index.html", content: "aGk=", encoding: "base64" }] } });
		const markdown = await ops.publish({ content: { markdown: "# hi" }, label: "Notes" });
		const zipped = await ops.publish({ content: { zip } });
		expect([files, markdown, zipped].map((page) => page.fileCount)).toEqual([1, 1, 1]);
		const set = await ops.publishMockup({ project: "p", name: "n", content: { zip: zipSync({ "a/index.html": strToU8("a"), "b/index.html": strToU8("b") }) } });
		expect((set as { options: { name: string }[] }).options.map((option) => option.name)).toEqual(["a", "b"]);
	});

	it("turns away content that isn't exactly one well-formed kind", async () => {
		const { ops } = operations();
		const bad: unknown[] = [
			{},
			{ html: "<p>", markdown: "# x" },
			{ files: [], zip },
			{ html: 3 },
			{ markdown: {} },
			{ files: "index.html" },
			{ files: [{ path: "index.html" }] },
			{ files: [{ path: 1, content: "x" }] },
			{ files: [{ path: "index.html", content: "%%", encoding: "base64" }] },
			{ zip: new Uint8Array([1, 2, 3]) },
		];
		for (const content of bad) expect(await status(ops.publish({ content: content as never }))).toBe(400);
		expect(await status(ops.publishMockup({ project: "p", name: "n", content: { html: "<p>" } }))).toBe(400);
	});

	it("titles a Markdown page with its label when published, and by its heading when updated", async () => {
		const { ops } = operations();
		const page = await ops.publish({ content: { markdown: "# hi" }, label: "Weekly notes" });
		const pages = new Pages(env, { defer: () => {} });
		const first = await pages.files.serve(await pages.get(page.id), "index.html");
		expect(await new Response(first!.body).text()).toContain("<title>Weekly notes</title>");
		await ops.update(page.id, { markdown: "# Release notes" });
		const served = await pages.files.serve(await pages.get(page.id), "index.html");
		expect(await new Response(served!.body).text()).toContain("<title>Release notes</title>");
	});

	it("patches inline files, and checks what to remove", async () => {
		const { ops } = operations();
		const page = await ops.publish({ content: { files: [{ path: "index.html", content: "x" }, { path: "a.css", content: "p{}" }] } });
		expect(await ops.patch(page.id, { remove: ["a.css"] })).toMatchObject({ fileCount: 1 });
		expect(await ops.patch(page.id, { files: [{ path: "b.css", content: "q{}" }] })).toMatchObject({ fileCount: 2 });
		expect(await status(ops.patch(page.id, { remove: "b.css" }))).toBe(400);
		expect(await status(ops.patch(page.id, { files: [{ path: "c.css" }] }))).toBe(400);
	});
});

describe("upload URLs", () => {
	/** Operations whose R2 puts fail while `failing.on` is true. */
	function withFlakyPuts() {
		const failing = { on: true };
		const bucket = new Proxy(env.BUCKET, {
			get(target, name) {
				if (name === "put" && failing.on) return () => Promise.reject(new Error("put failed"));
				const value = Reflect.get(target, name);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const pages = new Pages({ DB: env.DB, BUCKET: bucket }, { now: () => START, defer: (work) => deferred.push(work) });
		return { ops: new Operations(pages, "pages.example.com", "secret", () => START), failing };
	}

	it("still work after an upload that failed, and only once after one that worked", async () => {
		const { ops } = operations();
		const page = await ops.publish({ content: HTML });
		const minted = await ops.uploadUrl({ id: page.id });
		const token = (await checkUploadToken("secret", minted.uploadUrl.split("/upload/")[1]!, START))!;

		const flaky = withFlakyPuts();
		await expect(flaky.ops.upload(token.id, token.latestVersion, { html: "<p>first try</p>" })).rejects.toThrow("put failed");
		expect(await ops.get(page.id)).toMatchObject({ version: 1 });

		flaky.failing.on = false;
		expect(await flaky.ops.upload(token.id, token.latestVersion, { html: "<p>second try</p>" })).toMatchObject({ version: 2 });
		expect(await status(flaky.ops.upload(token.id, token.latestVersion, { html: "<p>again</p>" }))).toBe(403);
	});
});
