import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { VersionFiles } from "../src/version-files.ts";
import { api, call, publish } from "./helpers.ts";

afterEach(() => reset());

/** 100 bytes, 0 to 99, so a range's body says which bytes it holds. */
const BYTES = Uint8Array.from({ length: 100 }, (_, i) => i);
const VIDEO = { path: "clip.mp4", content: btoa(String.fromCharCode(...BYTES)), encoding: "base64" as const };

function bytes(from: number, to: number): number[] {
	return [...BYTES.slice(from, to + 1)];
}

async function body(response: Response): Promise<number[]> {
	return [...new Uint8Array(await response.arrayBuffer())];
}

function get(url: string, headers: Record<string, string> = {}, method = "GET"): Promise<Response> {
	return call(url, { method, headers });
}

describe("byte ranges over HTTP", () => {
	async function video(): Promise<string> {
		const page = await publish({ files: [{ path: "index.html", content: "<video src=clip.mp4>" }, VIDEO, { path: "app.css", content: "p{color:red}" }] });
		return `${page.url}clip.mp4`;
	}

	it("serves a part of a file with 206 and Content-Range", async () => {
		const url = await video();
		const response = await get(url, { range: "bytes=0-3" });
		expect(response.status).toBe(206);
		expect(response.headers.get("content-range")).toBe("bytes 0-3/100");
		expect(response.headers.get("content-length")).toBe("4");
		expect(response.headers.get("accept-ranges")).toBe("bytes");
		expect(response.headers.get("content-type")).toBe("video/mp4");
		expect(response.headers.get("etag")).toBeTruthy();
		expect(await body(response)).toEqual(bytes(0, 3));

		const tail = await get(url, { range: "bytes=-10" });
		expect(tail.headers.get("content-range")).toBe("bytes 90-99/100");
		expect(await body(tail)).toEqual(bytes(90, 99));
		const open = await get(url, { range: "bytes=95-" });
		expect(open.headers.get("content-range")).toBe("bytes 95-99/100");
		expect(await body(open)).toEqual(bytes(95, 99));
		const past = await get(url, { range: "bytes=98-500" });
		expect(past.headers.get("content-range")).toBe("bytes 98-99/100");
	});

	it("says it takes ranges on a whole file, and answers HEAD without a body", async () => {
		const url = await video();
		const whole = await get(url);
		expect(whole.status).toBe(200);
		expect(whole.headers.get("accept-ranges")).toBe("bytes");
		expect(await body(whole)).toEqual(bytes(0, 99));
		const head = await get(url, {}, "HEAD");
		expect(head.status).toBe(200);
		expect(head.headers.get("accept-ranges")).toBe("bytes");
		expect(await head.text()).toBe("");
	});

	it("answers 416 for an absurd offset, never a garbled 206", async () => {
		const url = await video();
		const response = await get(url, { range: "bytes=99999999999999999999999-" });
		expect(response.status).toBe(416);
		expect(response.headers.get("content-range")).toBe("bytes */100");
	});

	it("answers 416 for a range past the end", async () => {
		const response = await get(await video(), { range: "bytes=100-" });
		expect(response.status).toBe(416);
		expect(response.headers.get("content-range")).toBe("bytes */100");
	});

	it("serves the whole file for a range it doesn't take", async () => {
		const url = await video();
		for (const range of ["bytes=0-1,4-5", "items=0-3", "bytes=5-2", "bytes=-0", "bytes=x-"]) {
			const response = await get(url, { range });
			expect(response.status, range).toBe(200);
			expect(await body(response)).toEqual(bytes(0, 99));
		}
	});

	it("honours If-Range and If-None-Match", async () => {
		const url = await video();
		const etag = (await get(url)).headers.get("etag")!;
		expect((await get(url, { range: "bytes=0-3", "if-range": etag })).status).toBe(206);
		const changed = await get(url, { range: "bytes=0-3", "if-range": '"something else"' });
		expect(changed.status).toBe(200);
		expect(await body(changed)).toEqual(bytes(0, 99));
		expect((await get(url, { range: "bytes=0-3", "if-range": "Wed, 21 Oct 2015 07:28:00 GMT" })).status).toBe(200);
		expect((await get(url, { range: "bytes=200-", "if-range": '"something else"' })).status).toBe(200);
		expect((await get(url, { range: "bytes=0-3", "if-none-match": etag })).status).toBe(304);
		expect((await get(url, { range: "bytes=200-", "if-none-match": etag })).status).toBe(304);
	});

	it("leaves gzipped files whole", async () => {
		const page = await publish({ files: [{ path: "index.html", content: "<h1>hi</h1>" }, { path: "app.css", content: "p{color:red}" }] });
		const response = await get(`${page.url}app.css`, { range: "bytes=0-3", "accept-encoding": "gzip" });
		expect(response.status).toBe(200);
		expect(response.headers.get("accept-ranges")).toBeNull();
		expect(response.headers.get("content-range")).toBeNull();
	});

	it("works on private pages, through a pass", async () => {
		const page = await publish({ files: [{ path: "index.html", content: "<video src=clip.mp4>" }, VIDEO], visibility: "private" });
		const link = (await (await api(`/pages/${page.id}/share`, { method: "POST", body: "{}" })).json()) as { url: string };
		const response = await get(`${link.url}clip.mp4`, { range: "bytes=10-19" });
		expect(response.status).toBe(206);
		expect(response.headers.get("content-range")).toBe("bytes 10-19/100");
		expect(await body(response)).toEqual(bytes(10, 19));
	});
});

describe("byte ranges from R2 and the edge cache", () => {
	const ORIGIN = "https://pages.example.com";

	function newId(): string {
		return `t${crypto.randomUUID().replaceAll("-", "").slice(0, 11)}`;
	}

	/** A bucket that fails every read, so anything served through it came from the cache. */
	const unreadable = new Proxy(env.BUCKET, {
		get(target, name) {
			if (name === "get" || name === "head" || name === "list") return () => Promise.reject(new Error("R2 was read"));
			const value = Reflect.get(target, name);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	/** A version with clip.mp4, and stores that serve it from R2 only, and from the warmed cache only. */
	async function stores() {
		const id = newId();
		const deferred: Promise<unknown>[] = [];
		const writer = new VersionFiles(env.BUCKET, { defer: (work) => deferred.push(work), cacheOrigin: ORIGIN });
		(await writer.write({ id, version: 1 }, [{ path: "clip.mp4", body: BYTES }]))();
		await Promise.all(deferred);
		return {
			ref: { id, version: 1 },
			r2: new VersionFiles(env.BUCKET, { defer: () => {} }),
			cache: new VersionFiles(unreadable, { defer: () => {}, cacheOrigin: ORIGIN }),
		};
	}

	it("serve a range from either", async () => {
		const { ref, r2, cache } = await stores();
		for (const [store, cached] of [[r2, false], [cache, true]] as const) {
			const served = await store.serve(ref, "clip.mp4", null, { range: "bytes=10-19", ifRange: null });
			expect(served).toMatchObject({ cached, range: { satisfiable: true, start: 10, end: 19, size: 100 } });
			expect(await body(new Response(served!.body))).toEqual(bytes(10, 19));
		}
	});

	it("serve what there is of a range that runs past the end, from either", async () => {
		const { ref, r2, cache } = await stores();
		for (const store of [r2, cache]) {
			for (const [range, start] of [["bytes=-500", 0], ["bytes=98-500", 98]] as const) {
				const served = await store.serve(ref, "clip.mp4", null, { range, ifRange: null });
				// A range covering the whole file may come back as the whole file (the cache does that), which is a fine answer too.
				if (start > 0 || served?.range) expect(served?.range, range).toEqual({ satisfiable: true, start, end: 99, size: 100 });
				expect(await body(new Response(served!.body))).toEqual(bytes(start, 99));
			}
		}
	});

	it("say when a range can't be served, from either", async () => {
		const { ref, r2, cache } = await stores();
		for (const store of [r2, cache]) {
			const served = await store.serve(ref, "clip.mp4", null, { range: "bytes=100-", ifRange: null });
			expect(served).toMatchObject({ body: null, range: { satisfiable: false, size: 100 } });
		}
	});

	it("say an absurd offset can't be served, from either", async () => {
		const { ref, r2, cache } = await stores();
		for (const store of [r2, cache]) {
			const served = await store.serve(ref, "clip.mp4", null, { range: "bytes=99999999999999999999999-", ifRange: null });
			expect(served).toMatchObject({ body: null, range: { satisfiable: false, size: 100 } });
		}
	});

	it("say a range can't be served even when R2 answers one past the end with the whole file", async () => {
		const { ref } = await stores();
		// R2's docs don't promise to refuse an offset past the end, so suppose it doesn't.
		const lenient = new Proxy(env.BUCKET, {
			get(target, name) {
				if (name === "get") return (key: string) => target.get(key);
				const value = Reflect.get(target, name);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const served = await new VersionFiles(lenient, { defer: () => {} }).serve(ref, "clip.mp4", null, { range: "bytes=150-", ifRange: null });
		expect(served).toMatchObject({ body: null, range: { satisfiable: false, size: 100 } });
	});

	it("serve the whole file when If-Range names another version of it, from either", async () => {
		const { ref, r2, cache } = await stores();
		for (const store of [r2, cache]) {
			const served = await store.serve(ref, "clip.mp4", null, { range: "bytes=10-19", ifRange: '"old"' });
			expect(served?.range).toBeUndefined();
			expect(await body(new Response(served!.body))).toEqual(bytes(0, 99));
		}
	});

	it("answer a matching ETag without a body before looking at the range, from either", async () => {
		const { ref, r2, cache } = await stores();
		const { etag } = (await r2.serve(ref, "clip.mp4"))!;
		for (const store of [r2, cache]) {
			for (const range of ["bytes=10-19", "bytes=100-"]) {
				const served = await store.serve(ref, "clip.mp4", etag, { range, ifRange: null });
				expect(served, range).toMatchObject({ etag, body: null });
				expect(served?.range, range).toBeUndefined();
			}
		}
	});
});
