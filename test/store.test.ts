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

	it("deletes the old version's files in the background after an update", async () => {
		const { pages, settle } = store();
		const page = await pages.publish({ files: INDEX, ttl: HOUR });
		const updated = await pages.update(page.id, [file("index.html", "v2"), file("a.txt")]);
		expect(updated.version).toBe(2);
		await settle();
		expect(await objectCount(page.id)).toBe(2);
	});

	it("normalizes paths itself, whoever calls it", async () => {
		const { pages } = store();
		const page = await pages.publish({ files: [file("./index.html"), file("/css/a.css")], ttl: HOUR });
		expect(await pages.hasFile(page, "index.html")).toBe(true);
		expect(await pages.hasFile(page, "css/a.css")).toBe(true);
		expect(await status(pages.publish({ files: [file("index.html"), file("../x")], ttl: HOUR }))).toBe(400);
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
