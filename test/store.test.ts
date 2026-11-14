import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS, PageError } from "../src/domain.ts";
import type { PageFile } from "../src/files.ts";
import { Pages } from "../src/pages.ts";
import { objectCount } from "./helpers.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	await reset();
});

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
		expect(await pages.sweep()).toEqual({ purged: 1, forgotten: 0, orphans: 0 });
		expect(await objectCount(page.id)).toBe(0);
		expect((await pages.lookup(page.id)).state).toBe("gone");

		clock.now = START + HOUR + LIMITS.goneGrace;
		expect(await pages.sweep()).toEqual({ purged: 0, forgotten: 1, orphans: 0 });
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
		expect(await pages.files.exists(page, "index.html")).toBe(true);
		expect(await pages.files.exists(page, "css/a.css")).toBe(true);
		expect(await status(pages.publish({ files: [file("index.html"), file("../x")], ttl: HOUR }))).toBe(400);
	});
});

describe("versions", () => {
	async function text(pages: Pages, id: string): Promise<string> {
		const served = await pages.files.serve(await pages.get(id), "index.html");
		return new Response(served!.body).text();
	}

	it("lets one of two updates at once win, without the other touching its files", async () => {
		const { pages } = store();
		const page = await pages.publish({ files: [file("index.html", "v1")], ttl: HOUR });
		const results = await Promise.allSettled([pages.update(page.id, [file("index.html", "a")]), pages.update(page.id, [file("index.html", "b")])]);
		const won = results.filter((result) => result.status === "fulfilled");
		expect(won).toHaveLength(1);
		expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({ status: 409 });
		const served = await text(pages, page.id);
		expect(["a", "b"]).toContain(served);
		expect(await pages.update(page.id, [file("index.html", "c")])).toMatchObject({ version: 3 });
		expect(await text(pages, page.id)).toBe("c");
	});

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

	it("revokes passes on a rollback, so a link handed out while the old version was live stops working", async () => {
		const { pages } = store();
		const page = await pages.publish({ files: [file("index.html", "v1")], ttl: HOUR });
		await pages.update(page.id, [file("index.html", "v2")]);
		const before = (await pages.get(page.id)).shareEpoch;
		expect((await pages.rollback(page.id, 1)).shareEpoch).toBe(before + 1);
		expect((await pages.get(page.id)).shareEpoch).toBe(before + 1);
		// Rolling back to the version already served changes nothing.
		expect((await pages.rollback(page.id, 1)).shareEpoch).toBe(before + 1);
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

	it("sweeps away version folders no version row points at, once they're old enough not to be a write in progress", async () => {
		const { pages, clock, settle } = store();
		clock.now = Date.now();
		const page = await pages.publish({ files: INDEX, ttl: "permanent" });
		for (let i = 0; i < LIMITS.keptVersions + 1; i++) await pages.update(page.id, INDEX);
		await settle();
		// Version 1 was pruned; pretend deleting its files failed, and that a write of version 9 died.
		await env.BUCKET.put(`pages/${page.id}/1/index.html`, "old");
		await env.BUCKET.put(`pages/${page.id}/9/index.html`, "dead");
		const stored = async () => (await env.BUCKET.list({ prefix: `pages/${page.id}/`, delimiter: "/" })).delimitedPrefixes.length;
		expect(await stored()).toBe(LIMITS.keptVersions + 2);

		expect((await pages.sweep()).orphans).toBe(0);
		clock.now = Date.now() + 2 * HOUR;
		expect((await pages.sweep()).orphans).toBe(2);
		expect(await stored()).toBe(LIMITS.keptVersions);
		expect(await (await env.BUCKET.get(`pages/${page.id}/${LIMITS.keptVersions + 2}/index.html`))!.text()).toBe("<h1>hi</h1>");
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

describe("storage failures", () => {
	it("leaves no files behind when a publish fails part way", async () => {
		const { bucket } = flaky("put", 1);
		const { pages } = store(bucket);
		await expect(pages.publish({ files: [...INDEX, file("a.txt")], ttl: HOUR })).rejects.toThrow("put failed");
		expect((await env.BUCKET.list({ prefix: "pages/" })).objects).toHaveLength(0);
		expect(await pageRows()).toBe(0);
	});

	it("leaves a failed publish to the sweep when cleaning up after it fails too", async () => {
		const puts = flaky("put", 1);
		const deletes = flaky("delete");
		// One bucket failing both: the second put, and every delete.
		const bucket = new Proxy(env.BUCKET, {
			get(target, name) {
				if (name === "put") return Reflect.get(puts.bucket, "put");
				if (name === "delete") return Reflect.get(deletes.bucket, "delete");
				const value = Reflect.get(target, name);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const { pages, clock } = store(bucket);
		await expect(pages.publish({ files: [...INDEX, file("a.txt")], ttl: HOUR })).rejects.toThrow("put failed");
		expect((await env.BUCKET.list({ prefix: "pages/" })).objects).toHaveLength(1);
		expect(await pages.list()).toEqual([]);

		const healthy = store();
		healthy.clock.now = clock.now + 1000;
		expect((await healthy.pages.sweep()).purged).toBe(1);
		expect((await env.BUCKET.list({ prefix: "pages/" })).objects).toHaveLength(0);
		healthy.clock.now = START + LIMITS.goneGrace + 1;
		expect((await healthy.pages.sweep()).forgotten).toBe(1);
		expect(await pageRows()).toBe(0);
	});

	it("sweeps up after a publish that died between reserving its id and committing, once it's clearly abandoned", async () => {
		const { pages, clock } = store();
		// A database whose commit never comes back, as if the Worker died there.
		let reached: () => void;
		const atCommit = new Promise<void>((resolve) => (reached = resolve));
		const db = new Proxy(env.DB, {
			get(target, name) {
				if (name === "batch") {
					return () => {
						reached();
						return new Promise(() => {});
					};
				}
				const value = Reflect.get(target, name);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const dying = new Pages({ DB: db, BUCKET: env.BUCKET }, { now: () => START, defer: () => {} });
		void dying.publish({ files: INDEX, ttl: HOUR });
		await atCommit;
		expect(await pageRows()).toBe(1);
		expect((await env.BUCKET.list({ prefix: "pages/" })).objects).toHaveLength(1);

		// Still in progress, as far as the sweep can tell.
		clock.now = START + 30 * 60_000;
		expect((await pages.sweep()).purged).toBe(0);
		expect((await env.BUCKET.list({ prefix: "pages/" })).objects).toHaveLength(1);

		clock.now = START + 2 * HOUR;
		expect((await pages.sweep()).purged).toBe(1);
		expect((await env.BUCKET.list({ prefix: "pages/" })).objects).toHaveLength(0);
		// Once is enough: later sweeps leave it alone until it's forgotten.
		clock.now += 10 * 60_000;
		expect((await pages.sweep()).purged).toBe(0);
		clock.now = START + LIMITS.goneGrace + 1;
		expect((await pages.sweep()).forgotten).toBe(1);
		expect(await pageRows()).toBe(0);
	});

	it("never takes a live page for an abandoned reservation", async () => {
		const { pages, clock } = store();
		const page = await pages.publish({ files: INDEX, ttl: "permanent" });
		clock.now = START + 2 * HOUR;
		expect((await pages.sweep()).purged).toBe(0);
		expect(await objectCount(page.id)).toBe(1);
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

async function pageRows(): Promise<number> {
	return (await env.DB.prepare("SELECT COUNT(*) AS n FROM pages").first<{ n: number }>())!.n;
}

/** Makes the next `times` ids drawn come out the same: every random character is "a". */
function repeatIds(times: number) {
	const spy = vi.spyOn(crypto, "getRandomValues");
	for (let i = 0; i < times; i++) {
		spy.mockImplementationOnce(<T extends ArrayBufferView | null>(array: T): T => {
			(array as unknown as Uint8Array).fill(0);
			return array;
		});
	}
}

describe("page ids", () => {
	async function body(pages: Pages, page: { id: string; version: number }, path: string): Promise<string> {
		return new Response((await pages.files.serve(page, path))!.body).text();
	}

	it("gives a mockup set 10 random characters after its slug", async () => {
		const { pages } = store();
		const set = await pages.publish({ files: [file("a/index.html")], ttl: "permanent", mockup: { project: "Web", name: "Nav" } });
		expect(set.id).toMatch(/^web-nav-[a-z2-7]{10}$/);
	});

	it("never touches another set's files when a mockup id comes up twice", async () => {
		const { pages } = store();
		const mockup = { project: "web", name: "nav" };
		repeatIds(2);
		const first = await pages.publish({ files: [file("a/index.html", "first")], ttl: "permanent", mockup });
		expect(first.id).toBe("web-nav-aaaaaaaaaa");
		const second = await pages.publish({ files: [file("b/index.html", "second")], ttl: "permanent", mockup });
		expect(second.id).not.toBe(first.id);

		expect(await objectCount(first.id)).toBe(1);
		expect(await body(pages, first, "a/index.html")).toBe("first");
		expect((await pages.options(first.id)).map((option) => option.name)).toEqual(["a"]);
		expect(await body(pages, second, "b/index.html")).toBe("second");
		expect((await pages.options(second.id)).map((option) => option.name)).toEqual(["b"]);
	});

	it("does the same for plain pages", async () => {
		const { pages } = store();
		repeatIds(2);
		const first = await pages.publish({ files: [file("index.html", "first")], ttl: HOUR });
		const second = await pages.publish({ files: [file("index.html", "second")], ttl: HOUR });
		expect(second.id).not.toBe(first.id);
		expect(await body(pages, first, "index.html")).toBe("first");
		expect(await body(pages, second, "index.html")).toBe("second");
	});

	it("gives up after a few clashes, leaving the page that has the id alone", async () => {
		const { pages } = store();
		const mockup = { project: "web", name: "nav" };
		repeatIds(1);
		const first = await pages.publish({ files: [file("a/index.html", "first")], ttl: "permanent", mockup });
		repeatIds(20);
		expect(await status(pages.publish({ files: [file("b/index.html", "second")], ttl: "permanent", mockup }))).toBe(503);
		expect(await pageRows()).toBe(1);
		expect(await objectCount(first.id)).toBe(1);
		expect(await body(pages, first, "a/index.html")).toBe("first");
	});

	it("keeps a reserved id out of sight, and out of the sweep's way, while its files are written", async () => {
		const seen: { live: number; state: string; swept: number }[] = [];
		const { pages } = store();
		const watching = new Proxy(env.BUCKET, {
			get(target, name) {
				if (name === "put") {
					return async (key: string, ...rest: unknown[]) => {
						const id = key.split("/")[1]!;
						seen.push({ live: (await pages.list()).length, state: (await pages.lookup(id)).state, swept: (await pages.sweep()).purged });
						return (target.put as (...args: unknown[]) => unknown).call(target, key, ...rest);
					};
				}
				const value = Reflect.get(target, name);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const page = await store(watching).pages.publish({ files: INDEX, ttl: HOUR });
		expect(seen).toEqual([{ live: 0, state: "gone", swept: 0 }]);
		expect((await pages.lookup(page.id)).state).toBe("live");
		expect(await objectCount(page.id)).toBe(1);
		expect((await pages.usage()).temporaryPages).toBe(1);
	});
});
