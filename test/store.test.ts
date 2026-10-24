import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS, PageError } from "../src/domain.ts";
import type { PageFile } from "../src/files.ts";
import { Pages } from "../src/pages.ts";
import { objectCount } from "./helpers.ts";

afterEach(() => reset());

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 0, 1);

function file(path: string, content = "x"): PageFile {
	return { path, body: new TextEncoder().encode(content) };
}

const INDEX = [file("index.html", "<h1>hi</h1>")];

/** A store with a clock the test moves by hand, collecting its background work. */
function store(bucket: R2Bucket = env.BUCKET) {
	const clock = { now: START };
	const deferred: Promise<unknown>[] = [];
	const pages = new Pages({ DB: env.DB, BUCKET: bucket }, { now: () => clock.now, defer: (work) => deferred.push(work) });
	return { pages, clock, settle: () => Promise.all(deferred) };
}

/** An R2 bucket whose `method` fails after `succeed` calls, while `failing.on` is true. */
function flaky(method: "put" | "delete", succeed = 0) {
	const failing = { on: true };
	let calls = 0;
	const bucket = new Proxy(env.BUCKET, {
		get(target, name) {
			if (name === method && failing.on && calls++ >= succeed) return () => Promise.reject(new Error(`${method} failed`));
			const value = Reflect.get(target, name);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { bucket, failing };
}

async function status(promise: Promise<unknown>): Promise<number | undefined> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		if (error instanceof PageError) return error.status;
		throw error;
	}
}

describe("page lifecycle", () => {
	it("is live until it expires, gone for the grace period, then missing", async () => {
		const { pages, clock } = store();
		const page = await pages.publish({ files: INDEX, ttl: HOUR });
		expect((await pages.lookup(page.id)).state).toBe("live");

		clock.now = START + HOUR;
		expect((await pages.lookup(page.id)).state).toBe("gone");
		expect(await status(pages.update(page.id, INDEX))).toBe(410);

		clock.now = START + HOUR + LIMITS.goneGrace;
		expect((await pages.lookup(page.id)).state).toBe("missing");
	});

	it("sweeps the files of gone pages, then forgets them after the grace period", async () => {
		const { pages, clock } = store();
		const page = await pages.publish({ files: INDEX, ttl: HOUR });

		clock.now = START + 2 * HOUR;
		expect(await pages.sweep()).toEqual({ purged: 1, forgotten: 0 });
		expect(await objectCount(page.id)).toBe(0);
		expect((await pages.lookup(page.id)).state).toBe("gone");

		clock.now = START + HOUR + LIMITS.goneGrace;
		expect(await pages.sweep()).toEqual({ purged: 0, forgotten: 1 });
		expect((await pages.lookup(page.id)).state).toBe("missing");
	});

	it("never sweeps permanent pages", async () => {
		const { pages, clock } = store();
		const page = await pages.publish({ files: INDEX, ttl: "permanent" });
		clock.now = START + 365 * DAY;
		await pages.sweep();
		expect((await pages.lookup(page.id)).state).toBe("live");
		expect(await objectCount(page.id)).toBe(1);
	});

	it("extends from the current expiry, capped at the maximum ttl from now", async () => {
		const { pages } = store();
		const page = await pages.publish({ files: INDEX, ttl: HOUR });
		expect((await pages.extend(page.id, DAY)).expiresAt).toBe(START + HOUR + DAY);
		expect((await pages.extend(page.id, LIMITS.maxTtl)).expiresAt).toBe(START + LIMITS.maxTtl);
	});

	it("won't extend a page that has gone", async () => {
		const { pages, clock } = store();
		const page = await pages.publish({ files: INDEX, ttl: HOUR });
		clock.now = START + HOUR;
		expect(await status(pages.extend(page.id, DAY))).toBe(410);
	});


	it("normalizes paths itself, whoever calls it", async () => {
		const { pages } = store();
		const page = await pages.publish({ files: [file("./index.html"), file("/css/a.css")], ttl: HOUR });
		expect(await pages.hasFile(page, "index.html")).toBe(true);
		expect(await pages.hasFile(page, "css/a.css")).toBe(true);
		expect(await status(pages.publish({ files: [file("index.html"), file("../x")], ttl: HOUR }))).toBe(400);
	});
});

describe("versions", () => {
	async function text(pages: Pages, id: string): Promise<string> {
		const object = (await pages.file(await pages.get(id), "index.html")) as R2ObjectBody;
		return object.text();
	}

	it("keeps the newest versions and deletes older ones in the background", async () => {
		const { pages, settle } = store();
		const page = await pages.publish({ files: [file("index.html", "v1")], ttl: HOUR });
		for (let n = 2; n <= LIMITS.keptVersions + 2; n++) await pages.update(page.id, [file("index.html", `v${n}`)]);
		await settle();
		const versions = await pages.versions(page.id);
		expect(versions.map((v) => v.version)).toEqual([7, 6, 5, 4, 3]);
		expect(versions[0]!.current).toBe(true);
		expect(await objectCount(page.id)).toBe(LIMITS.keptVersions);
	});

	it("rolls back, and gives the next update a new number", async () => {
		const { pages } = store();
		const page = await pages.publish({ files: [file("index.html", "v1")], ttl: HOUR });
		await pages.update(page.id, [file("index.html", "v2")]);
		const rolledBack = await pages.rollback(page.id, 1);
		expect(rolledBack.version).toBe(1);
		expect(await text(pages, page.id)).toBe("v1");

		const updated = await pages.update(page.id, [file("index.html", "v3")]);
		expect(updated.version).toBe(3);
		expect(await text(pages, page.id)).toBe("v3");
		expect(await status(pages.rollback(page.id, 9))).toBe(404);
	});

	it("never prunes the version being served", async () => {
		const { pages, settle } = store();
		const page = await pages.publish({ files: [file("index.html", "v1")], ttl: HOUR });
		await pages.update(page.id, [file("index.html", "v2")]);
		await pages.rollback(page.id, 1);
		for (let n = 3; n <= LIMITS.keptVersions + 3; n++) await pages.update(page.id, [file("index.html", `v${n}`)]);
		await pages.rollback(page.id, LIMITS.keptVersions + 3);
		await settle();
		expect(await text(pages, page.id)).toBe(`v${LIMITS.keptVersions + 3}`);
		expect((await pages.versions(page.id)).length).toBe(LIMITS.keptVersions);
	});

	it("counts every kept version towards storage", async () => {
		const { pages } = store();
		const page = await pages.publish({ files: [file("index.html", "12345")], ttl: HOUR });
		await pages.update(page.id, [file("index.html", "123")]);
		expect((await pages.usage()).bytes).toBe(8);
		expect((await pages.get(page.id)).size).toBe(3);
	});

	it("forgets a page's versions with the page", async () => {
		const { pages, clock } = store();
		const page = await pages.publish({ files: INDEX, ttl: HOUR });
		await pages.update(page.id, INDEX);
		clock.now = START + HOUR + LIMITS.goneGrace;
		await pages.sweep();
		const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM versions WHERE page_id = ?").bind(page.id).first<{ n: number }>();
		expect(left!.n).toBe(0);
	});
});

describe("limits", () => {
	it("holds when publishes race for the last slot", async () => {
		const { pages } = store();
		await Promise.all(Array.from({ length: LIMITS.permanentPages - 1 }, () => pages.publish({ files: INDEX, ttl: "permanent" })));
		const results = await Promise.all(Array.from({ length: 4 }, () => status(pages.publish({ files: INDEX, ttl: "permanent" }))));
		expect(results.filter((result) => result === undefined)).toHaveLength(1);
		expect(results.filter((result) => result === 409)).toHaveLength(3);
		expect((await pages.usage()).permanentPages).toBe(LIMITS.permanentPages);
		expect((await env.BUCKET.list({ prefix: "pages/" })).objects).toHaveLength(LIMITS.permanentPages);
	});

	it("holds when pages race to become permanent", async () => {
		const { pages } = store();
		await Promise.all(Array.from({ length: LIMITS.permanentPages - 1 }, () => pages.publish({ files: INDEX, ttl: "permanent" })));
		const temporary = await Promise.all(Array.from({ length: 3 }, () => pages.publish({ files: INDEX, ttl: HOUR })));
		const results = await Promise.all(temporary.map((page) => status(pages.extend(page.id, "permanent"))));
		expect(results.filter((result) => result === undefined)).toHaveLength(1);
		expect(results.filter((result) => result === 409)).toHaveLength(2);
		expect((await pages.usage()).permanentPages).toBe(LIMITS.permanentPages);
	});
});

describe("storage failures", () => {
	it("leaves no files behind when a publish fails part way", async () => {
		const { bucket } = flaky("put", 1);
		const { pages } = store(bucket);
		await expect(pages.publish({ files: [...INDEX, file("a.txt")], ttl: HOUR })).rejects.toThrow("put failed");
		expect((await env.BUCKET.list({ prefix: "pages/" })).objects).toHaveLength(0);
	});

	it("retries deleting a page's files on the next sweep if the first try fails", async () => {
		const { pages } = store();
		const page = await pages.publish({ files: INDEX, ttl: HOUR });

		const { bucket, failing } = flaky("delete");
		const broken = store(bucket);
		await expect(broken.pages.delete(page.id)).rejects.toThrow("delete failed");
		expect((await pages.lookup(page.id)).state).toBe("gone");
		expect(await objectCount(page.id)).toBe(1);

		failing.on = false;
		expect((await pages.sweep()).purged).toBe(1);
		expect(await objectCount(page.id)).toBe(0);
	});
});
