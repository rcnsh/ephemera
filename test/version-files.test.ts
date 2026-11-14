import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { PageFile } from "../src/files.ts";
import { type Thumbnail, VersionFiles } from "../src/version-files.ts";

afterEach(() => reset());

const ORIGIN = "https://pages.example.com";

function file(path: string, content = "x"): PageFile {
	return { path, body: new TextEncoder().encode(content) };
}

/** The edge cache outlives `reset()`, so every test gets page ids of its own. */
function newId(): string {
	return `t${crypto.randomUUID().replaceAll("-", "").slice(0, 11)}`;
}

/** Files over `bucket`, collecting background work (cache fills) for `settle`. */
function files(options: { bucket?: R2Bucket; cache?: boolean } = {}) {
	const deferred: Promise<unknown>[] = [];
	const store = new VersionFiles(options.bucket ?? env.BUCKET, { defer: (work) => deferred.push(work), cacheOrigin: options.cache === false ? undefined : ORIGIN });
	return { store, settle: () => Promise.all(deferred) };
}

/** A bucket that fails every read, so anything served through it came from the cache. */
const unreadable = new Proxy(env.BUCKET, {
	get(target, name) {
		if (name === "get" || name === "head" || name === "list") return () => Promise.reject(new Error("R2 was read"));
		const value = Reflect.get(target, name);
		return typeof value === "function" ? value.bind(target) : value;
	},
});

async function text(served: { body: ReadableStream | null } | null): Promise<string> {
	return new Response(served!.body).text();
}

describe("serving a version's files", () => {
	it("serves what was written, then from the edge cache once it's warm", async () => {
		const id = newId();
		const { store, settle } = files();
		const warm = await store.write({ id, version: 1 }, [file("index.html", "<h1>v1</h1>"), file("a b/c.css", "p{}")]);
		warm();
		await settle();

		const fromCache = files({ bucket: unreadable }).store;
		const index = await fromCache.serve({ id, version: 1 }, "index.html");
		expect(index).toMatchObject({ contentType: "text/html; charset=utf-8", cached: true });
		expect(await text(index)).toBe("<h1>v1</h1>");
		expect(await text(await fromCache.serve({ id, version: 1 }, "a b/c.css"))).toBe("p{}");
		await expect(fromCache.serve({ id, version: 2 }, "index.html")).rejects.toThrow("R2 was read");
	});

	it("fills the cache from R2 on a miss", async () => {
		const id = newId();
		const { store, settle } = files();
		await store.write({ id, version: 1 }, [file("index.html", "hello")]); // not warmed
		const missed = await store.serve({ id, version: 1 }, "index.html");
		expect(missed?.cached).toBe(false);
		expect(await text(missed)).toBe("hello");
		await settle();
		const hit = await files({ bucket: unreadable }).store.serve({ id, version: 1 }, "index.html");
		expect(hit?.cached).toBe(true);
		expect(await text(hit)).toBe("hello");
	});

	it("answers a matching ETag without a body, from R2 or the cache", async () => {
		const id = newId();
		const { store, settle } = files();
		await store.write({ id, version: 1 }, [file("index.html", "hello")]);
		const { etag } = (await store.serve({ id, version: 1 }, "index.html"))!;
		expect(await store.serve({ id, version: 1 }, "index.html", etag)).toMatchObject({ etag, body: null, cached: false });
		await settle();
		expect(await store.serve({ id, version: 1 }, "index.html", `"other", W/${etag}`)).toMatchObject({ etag, body: null, cached: true });
		expect((await store.serve({ id, version: 1 }, "index.html", '"other"'))?.body).not.toBeNull();
	});

	it("remembers that a version has no file at a path, from serve or exists", async () => {
		const id = newId();
		const { store, settle } = files();
		await store.write({ id, version: 1 }, [file("a/index.html")]);
		expect(await store.serve({ id, version: 1 }, "index.html")).toBeNull();
		expect(await store.serve({ id, version: 1 }, "nope.css")).toBeNull();
		expect(await store.exists({ id, version: 1 }, "docs/index.html")).toBe(false);
		await settle();
		const fromCache = files({ bucket: unreadable }).store;
		expect(await fromCache.serve({ id, version: 1 }, "index.html")).toBeNull();
		expect(await fromCache.exists({ id, version: 1 }, "index.html")).toBe(false);
		expect(await fromCache.serve({ id, version: 1 }, "nope.css")).toBeNull();
		expect(await fromCache.exists({ id, version: 1 }, "docs/index.html")).toBe(false);
		// Another version's absence isn't this one's.
		await expect(fromCache.serve({ id, version: 2 }, "nope.css")).rejects.toThrow("R2 was read");
	});

	it("caches nothing without a cache origin", async () => {
		const id = newId();
		const { store, settle } = files({ cache: false });
		(await store.write({ id, version: 1 }, [file("index.html")]))();
		await store.serve({ id, version: 1 }, "index.html");
		await settle();
		expect((await store.serve({ id, version: 1 }, "index.html"))?.cached).toBe(false);
	});
});

describe("storing versions", () => {
	it("says which files a version has, from the cache when it can", async () => {
		const id = newId();
		const { store, settle } = files();
		(await store.write({ id, version: 1 }, [file("index.html"), file("docs/index.html")]))();
		await settle();
		expect(await store.exists({ id, version: 1 }, "docs/index.html")).toBe(true);
		expect(await store.exists({ id, version: 1 }, "other/index.html")).toBe(false);
		expect(await store.exists({ id, version: 2 }, "index.html")).toBe(false);
		expect(await files({ bucket: unreadable }).store.exists({ id, version: 1 }, "docs/index.html")).toBe(true);
		await settle(); // the absences it cached
	});

	it("copies files over from another version, and lists them with their sizes", async () => {
		const id = newId();
		const { store } = files();
		await store.write({ id, version: 1 }, [file("index.html", "12345"), file("a.css", "123")]);
		await store.write({ id, version: 2 }, [file("index.html", "1")], { from: 1, paths: ["a.css"] });
		expect(Object.fromEntries(await store.list({ id, version: 2 }))).toEqual({ "index.html": 1, "a.css": 3 });
		await expect(store.write({ id, version: 3 }, [], { from: 1, paths: ["gone.css"] })).rejects.toThrow(/vanished/);
	});

	it("deletes one version, or a whole page with its thumbnails", async () => {
		const id = newId();
		const other = newId();
		const { store } = files();
		await store.write({ id, version: 1 }, [file("index.html")]);
		await store.write({ id, version: 2 }, [file("index.html"), file("a.css")]);
		await store.write({ id: other, version: 1 }, [file("index.html")]);
		await store.saveThumbnail({ id, version: 2 }, new Uint8Array([1]));
		await store.deleteVersion({ id, version: 1 });
		expect((await store.list({ id, version: 1 })).size).toBe(0);
		expect((await store.list({ id, version: 2 })).size).toBe(2);
		await store.deletePage(id);
		expect((await store.list({ id, version: 2 })).size).toBe(0);
		expect(await store.thumbnail({ id, version: 2 })).toBeNull();
		expect((await store.list({ id: other, version: 1 })).size).toBe(1);
	});
});

describe("thumbnails", () => {
	it("keeps one per page and per option, for the version it was made of", async () => {
		const id = newId();
		const { store } = files();
		const png = async (thumbnail: Promise<Thumbnail | null>) => new Uint8Array(await ((await thumbnail) as { png: R2ObjectBody }).png.arrayBuffer());
		await store.saveThumbnail({ id, version: 1 }, new Uint8Array([1]));
		await store.saveThumbnail({ id, version: 1 }, new Uint8Array([2]), "a");
		expect(await png(store.thumbnail({ id, version: 1 }))).toEqual(new Uint8Array([1]));
		expect(await png(store.thumbnail({ id, version: 1 }, "a"))).toEqual(new Uint8Array([2]));
		expect(await store.thumbnail({ id, version: 1 }, "b")).toBeNull();
		expect(await store.thumbnail({ id, version: 2 })).toBeNull();
		await store.saveThumbnail({ id, version: 2 }, new Uint8Array([3]));
		expect(await store.thumbnail({ id, version: 1 })).toBeNull();
	});

	it("remembers a failed shot, for its version only", async () => {
		const id = newId();
		const { store } = files();
		await store.saveThumbnailFailure({ id, version: 1 }, 1234, "a");
		expect(await store.thumbnail({ id, version: 1 }, "a")).toEqual({ failedAt: 1234 });
		expect(await store.thumbnail({ id, version: 2 }, "a")).toBeNull();
		expect(await store.thumbnail({ id, version: 1 })).toBeNull();
	});

	it("deletes the thumbnails of options a set no longer has", async () => {
		const id = newId();
		const { store } = files();
		for (const option of ["a", "b", "c d"]) await store.saveThumbnail({ id, version: 1 }, new Uint8Array([1]), option);
		await store.saveThumbnail({ id, version: 1 }, new Uint8Array([1]));
		await store.deleteOptionThumbnails(id, ["c d"]);
		expect((await env.BUCKET.list({ prefix: `pages/${id}/` })).objects.map((object) => object.key).sort()).toEqual([`pages/${id}/thumbnail.png`, `pages/${id}/thumbnails/c d.png`]);
	});

	it("lists the versions a page has stored, and when one was written", async () => {
		const id = newId();
		const { store } = files();
		await store.write({ id, version: 1 }, [file("index.html"), file("a/b.css")]);
		await store.write({ id, version: 12 }, [file("index.html")]);
		await store.saveThumbnail({ id, version: 1 }, new Uint8Array([1]), "a");
		expect((await store.storedVersions(id)).sort((a, b) => a - b)).toEqual([1, 12]);
		expect(Math.abs((await store.writtenAt({ id, version: 12 }))! - Date.now())).toBeLessThan(60_000);
		expect(await store.writtenAt({ id, version: 2 })).toBeNull();
	});
});
