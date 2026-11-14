import { contentType, type PageFile } from "./files.ts";

/**
 * The files of every version of every page, and their thumbnails: R2 holds
 * them under `pages/<id>/<version>/<path>` (thumbnails under
 * `pages/<id>/thumbnail.png` and `pages/<id>/thumbnails/<option>.png`), and
 * nothing outside this module knows that layout.
 *
 * A version's files never change, so `serve` keeps them in the edge cache
 * under their version (see `VersionFilesOptions.cacheOrigin`): R2 is read once
 * per file per data centre rather than on every view. The same goes for the
 * paths a version has no file at, which `serve` and `exists` remember too. Each frame of a mockup
 * set is a sandboxed opaque origin with a cache partition of its own, so
 * browsers can't share files between frames and every frame asks the Worker
 * again.
 *
 * Which versions exist, and which one a page serves, is `Pages`' business:
 * this module stores whatever it's given.
 */

/** A version of a page: `Page` is one. */
export interface VersionRef {
	id: string;
	version: number;
}

export interface VersionFilesOptions {
	/** Keeps background work (filling the cache) alive after the response; `ctx.waitUntil` in the Worker. */
	defer: (work: Promise<unknown>) => void;
	/**
	 * An origin of this Worker's zone (`https://PAGES_HOST`) to key cached files
	 * under, at paths no request reaches. Without it nothing is cached.
	 */
	cacheOrigin?: string;
}

/** A file as served: `body` is null when the caller's ETag already matches. */
export interface ServedFile {
	etag: string;
	contentType: string;
	body: ReadableStream | null;
	/** Whether it came from the edge cache rather than R2. */
	cached: boolean;
	/**
	 * Set when a requested range applies: `body` holds bytes `start` to `end`
	 * (inclusive) of `size`, or, when the range can't be satisfied, is null.
	 */
	range?: { satisfiable: true; start: number; end: number; size: number } | { satisfiable: false; size: number };
}

/** A request's Range header, and its If-Range, which says to ignore the range unless the file still has that ETag. */
export interface RangeRequest {
	range: string;
	ifRange: string | null;
}

/** A single byte range as R2 takes it. */
type ByteRange = { offset: number; length?: number } | { suffix: number };

/**
 * One `bytes=` range, or null for anything else (several ranges, other
 * units, nonsense), which is served as the whole file, as RFC 9110 allows.
 * No file is anywhere near `Number.MAX_SAFE_INTEGER` bytes, so bigger
 * numbers are capped there: an offset past it can't be satisfied, and a
 * longer suffix or end means the rest of the file.
 */
function parseRange(header: string): ByteRange | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;
	const [, first, last] = match as unknown as [string, string, string];
	const cap = (digits: string) => Math.min(Number(digits), Number.MAX_SAFE_INTEGER);
	if (first === "") return last === "" || Number(last) === 0 ? null : { suffix: cap(last) };
	const offset = cap(first);
	if (last === "") return { offset };
	if (Number(last) < Number(first)) return null;
	return { offset, length: cap(last) - offset + 1 };
}

/** Whether a range can only be past the end of any file. */
function beyondAnyFile(range: ByteRange): boolean {
	return "offset" in range && range.offset >= Number.MAX_SAFE_INTEGER;
}

/** The bytes of a file of `size` that `range` asks for, or null if it asks for none of them. */
function resolveRange(range: ByteRange, size: number): { start: number; end: number } | null {
	if ("suffix" in range) return size === 0 ? null : { start: Math.max(0, size - range.suffix), end: size - 1 };
	if (range.offset >= size) return null;
	return { start: range.offset, end: range.length === undefined ? size - 1 : Math.min(size - 1, range.offset + range.length - 1) };
}

/** `bytes 0-3/100` or `bytes *\/100`, as a cached partial or 416 response carries it. */
function parseContentRange(header: string | null): { start: number; end: number; size: number } | { size: number } | null {
	const match = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(header ?? "");
	if (!match) return null;
	const [, start, end, size] = match;
	return start === undefined ? { size: Number(size) } : { start: Number(start), end: Number(end), size: Number(size) };
}

/** Whether an If-Range header still names `etag`. It compares strongly, so a weak tag or a date never does. */
function ifRangeHolds(ifRange: string | null, etag: string): boolean {
	return ifRange === null || (!ifRange.trim().startsWith("W/") && ifRange.trim() === etag);
}

/**
 * How long a data centre keeps a cached file. Views of a page cluster soon
 * after it's published; a short life means a deleted page's copies (which no
 * request can reach) don't linger.
 */
const CACHE_SECONDS = 24 * 60 * 60;

/** Marks a cached answer that a version has no file at a path. */
const MISSING = "x-ephemera-missing";

/** Whether an If-None-Match header names `etag` (weakly, as browsers compare). */
function matches(ifNoneMatch: string | null, etag: string): boolean {
	if (!ifNoneMatch) return false;
	const bare = (tag: string) => tag.trim().replace(/^W\//, "");
	return ifNoneMatch.split(",").some((tag) => tag.trim() === "*" || bare(tag) === bare(etag));
}

function versionPrefix(id: string, version: number): string {
	return `pages/${id}/${version}/`;
}

function thumbnailKey(id: string, option?: string): string {
	return option === undefined ? `pages/${id}/thumbnail.png` : `pages/${id}/thumbnails/${option}.png`;
}

/** What request handlers may do with a page's files: read them, and keep thumbnails. Writing and deleting versions is `Pages`' job. */
export type PageFiles = Pick<VersionFiles, "serve" | "exists" | "read" | "manifest" | "thumbnail" | "saveThumbnail" | "saveThumbnailFailure">;

/** A thumbnail kept for a version: its PNG, or when shooting it last failed. */
export type Thumbnail = { png: R2ObjectBody } | { failedAt: number };

export class VersionFiles {
	private readonly defer: (work: Promise<unknown>) => void;
	private readonly cacheOrigin: string | undefined;

	constructor(
		private readonly bucket: R2Bucket,
		options: VersionFilesOptions,
	) {
		this.defer = options.defer;
		this.cacheOrigin = options.cacheOrigin;
	}

	/**
	 * A file of a version to send, or null if it has none at `path`. Answers
	 * from the edge cache when it can, and fills it from R2 when it can't.
	 * With an `ifNoneMatch` naming the file's ETag, the body is null. With a
	 * `range` that applies, it's the part asked for (see `ServedFile.range`).
	 */
	async serve(ref: VersionRef, path: string, ifNoneMatch: string | null = null, range: RangeRequest | null = null): Promise<ServedFile | null> {
		const wanted = range ? parseRange(range.range) : null;
		const ifRange = range?.ifRange ?? null;
		const cached = await this.cached(ref, path, wanted ? range!.range : null);
		if (cached) {
			const served = await this.fromCache(ref, path, cached, ifNoneMatch, wanted ? ifRange : null);
			if (served !== undefined) return served;
		}
		const key = versionPrefix(ref.id, ref.version) + path;
		if (wanted) {
			const part = await this.rangeFromR2(ref, path, key, wanted, ifNoneMatch, ifRange);
			// undefined: no range after all (If-Range named another version), so read the whole file.
			if (part !== undefined) return part;
		}
		const object = await this.bucket.get(key);
		if (!object) {
			// A version never gains a file, so its absence is cached like a file.
			this.defer(this.cache(ref, path, null));
			return null;
		}
		const file = { etag: object.httpEtag, contentType: object.httpMetadata?.contentType ?? "application/octet-stream", cached: false };
		if (matches(ifNoneMatch, file.etag)) {
			if (this.cacheOrigin) this.defer(this.cache(ref, path, { ...file, body: object.body }));
			else await object.body.cancel();
			return { ...file, body: null };
		}
		this.fillFromR2(ref, path, file);
		return { ...file, body: object.body };
	}

	/**
	 * A cached answer as served, or undefined if the file left the cache
	 * meanwhile. Asked for a range, the cache answers 206 or 416 itself; but
	 * a matching If-None-Match comes first, and an If-Range that doesn't hold
	 * means the whole file, so unless it's a plain 206 the whole file's ETag
	 * decides. A cached 416 carries no ETag at all.
	 */
	private async fromCache(ref: VersionRef, path: string, cached: Response, ifNoneMatch: string | null, ifRange: string | null): Promise<ServedFile | null | undefined> {
		if (cached.headers.has(MISSING)) return null;
		if (cached.status === 206 || cached.status === 416) {
			const etag = cached.headers.get("etag");
			const contentRange = parseContentRange(cached.headers.get("content-range"));
			if (cached.status === 206 && etag && contentRange && "start" in contentRange && !matches(ifNoneMatch, etag) && ifRangeHolds(ifRange, etag)) {
				return { etag, contentType: cached.headers.get("content-type")!, body: cached.body, cached: true, range: { satisfiable: true, ...contentRange } };
			}
			await cached.body?.cancel();
			const whole = await this.cached(ref, path);
			if (!whole) return undefined;
			const served = await this.fromCache(ref, path, whole, ifNoneMatch, null);
			if (cached.status !== 416 || !served?.body || !contentRange || !ifRangeHolds(ifRange, served.etag)) return served;
			await served.body.cancel();
			return { ...served, body: null, range: { satisfiable: false, size: contentRange.size } };
		}
		const etag = cached.headers.get("etag")!;
		const fresh = matches(ifNoneMatch, etag);
		if (fresh) await cached.body?.cancel();
		return { etag, contentType: cached.headers.get("content-type")!, body: fresh ? null : cached.body, cached: true };
	}

	/**
	 * A range of a file read from R2, or undefined to read the whole file
	 * instead: when there's no file, or If-Range says so. Whether the range
	 * can be served is decided here from the file's size: R2 may refuse one
	 * past the end (then it's asked for the size), or may answer it anyway.
	 */
	private async rangeFromR2(
		ref: VersionRef,
		path: string,
		key: string,
		wanted: ByteRange,
		ifNoneMatch: string | null,
		ifRange: string | null,
	): Promise<ServedFile | undefined> {
		/** The answer for a range the file at `key` (of `object`'s size) can't serve. */
		const unsatisfiable = (object: R2Object): ServedFile | undefined => {
			const file = { etag: object.httpEtag, contentType: object.httpMetadata?.contentType ?? "application/octet-stream", cached: false };
			if (matches(ifNoneMatch, file.etag)) return { ...file, body: null };
			if (!ifRangeHolds(ifRange, file.etag)) return undefined;
			this.fillFromR2(ref, path, file);
			return { ...file, body: null, range: { satisfiable: false, size: object.size } };
		};
		let object: R2ObjectBody | null;
		try {
			if (beyondAnyFile(wanted)) throw new Error(`range ${JSON.stringify(wanted)} is past the end of any file`);
			object = await this.bucket.get(key, { range: wanted });
		} catch (error) {
			const head = await this.bucket.head(key);
			if (!head) return undefined;
			if (resolveRange(wanted, head.size)) throw error;
			return unsatisfiable(head);
		}
		if (!object) return undefined;
		const resolved = resolveRange(wanted, object.size);
		if (!resolved) {
			await object.body.cancel();
			return unsatisfiable(object);
		}
		const file = { etag: object.httpEtag, contentType: object.httpMetadata?.contentType ?? "application/octet-stream", cached: false };
		const fresh = matches(ifNoneMatch, file.etag);
		if (fresh || !ifRangeHolds(ifRange, file.etag)) {
			await object.body.cancel();
			if (!fresh) return undefined;
			this.fillFromR2(ref, path, file);
			return { ...file, body: null };
		}
		this.fillFromR2(ref, path, file);
		return { ...file, body: object.body, range: { satisfiable: true, ...resolved, size: object.size } };
	}

	/**
	 * Fills the cache with a file in the background. The cache gets its own
	 * read rather than a tee: a tee would hold whatever a slow client hasn't
	 * taken yet in memory, up to a whole page.
	 */
	private fillFromR2(ref: VersionRef, path: string, file: { etag: string; contentType: string }): void {
		if (!this.cacheOrigin) return;
		this.defer(this.bucket.get(versionPrefix(ref.id, ref.version) + path).then((copy) => (copy ? this.cache(ref, path, { ...file, body: copy.body }) : undefined)));
	}

	/** Whether a version has a file at `path`. */
	async exists(ref: VersionRef, path: string): Promise<boolean> {
		const cached = await this.cached(ref, path);
		if (cached) {
			await cached.body?.cancel();
			return !cached.headers.has(MISSING);
		}
		const found = (await this.bucket.head(versionPrefix(ref.id, ref.version) + path)) !== null;
		// Only absence: caching a file takes its body, which a head doesn't have.
		if (!found) this.defer(this.cache(ref, path, null));
		return found;
	}

	/** The paths and sizes of a version's files. */
	async list(ref: VersionRef): Promise<Map<string, number>> {
		const prefix = versionPrefix(ref.id, ref.version);
		const files = new Map<string, number>();
		let cursor: string | undefined;
		do {
			const listing = await this.bucket.list({ prefix, cursor, limit: 1000 });
			for (const object of listing.objects) files.set(object.key.slice(prefix.length), object.size);
			cursor = listing.truncated ? listing.cursor : undefined;
		} while (cursor);
		return files;
	}

	/** Each file of a version by path, with its size and its R2 ETag (an MD5 of the content, so equal files have equal ETags). */
	async manifest(ref: VersionRef): Promise<Map<string, { size: number; etag: string }>> {
		const prefix = versionPrefix(ref.id, ref.version);
		const files = new Map<string, { size: number; etag: string }>();
		let cursor: string | undefined;
		do {
			const listing = await this.bucket.list({ prefix, cursor, limit: 1000 });
			for (const object of listing.objects) files.set(object.key.slice(prefix.length), { size: object.size, etag: object.etag });
			cursor = listing.truncated ? listing.cursor : undefined;
		} while (cursor);
		return files;
	}

	/** A file of a version straight from R2, without touching the edge cache: for reading files back, not serving them. */
	async read(ref: VersionRef, path: string): Promise<ReadableStream | null> {
		return (await this.bucket.get(versionPrefix(ref.id, ref.version) + path))?.body ?? null;
	}

	/**
	 * Writes a version's `files`, and copies the paths in `copy` over from
	 * version `copy.from`. Waits for every write to settle, even after one
	 * fails, so a `deleteVersion` that follows sees them all.
	 *
	 * Returns `warm`, which puts the new files in the edge cache: whoever
	 * published is usually the first to look, from the same data centre. Call
	 * it only once the version is committed: one that fails is deleted and
	 * never served.
	 */
	async write(ref: VersionRef, files: PageFile[], copy?: { from: number; paths: string[] }): Promise<() => void> {
		const { id, version } = ref;
		const prefix = versionPrefix(id, version);
		const written: { path: string; etag: string; contentType: string; body: Uint8Array }[] = [];
		const results = await Promise.allSettled([
			...files.map(async (file) => {
				const type = contentType(file.path);
				const object = await this.bucket.put(prefix + file.path, file.body, { httpMetadata: { contentType: type } });
				written.push({ path: file.path, etag: object.httpEtag, contentType: type, body: file.body });
			}),
			...(copy?.paths ?? []).map(async (path) => {
				const source = versionPrefix(id, copy!.from) + path;
				const object = await this.bucket.get(source);
				if (!object) throw new Error(`${source} vanished while copying`);
				await this.bucket.put(prefix + path, object.body, { httpMetadata: object.httpMetadata });
			}),
		]);
		const failed = results.find((result) => result.status === "rejected");
		if (failed) throw failed.reason;
		return () => {
			for (const { path, ...file } of written) this.defer(this.cache(ref, path, file));
		};
	}

	/** Deletes a version's files. Its cached copies can't be reached once no row points at it, and age out. */
	deleteVersion(ref: VersionRef): Promise<void> {
		return this.deletePrefix(versionPrefix(ref.id, ref.version));
	}

	/**
	 * The versions a page has files stored for, from one listing of its
	 * folder that doesn't descend into them.
	 */
	async storedVersions(id: string): Promise<number[]> {
		const prefix = `pages/${id}/`;
		const versions: number[] = [];
		let cursor: string | undefined;
		do {
			const listing = await this.bucket.list({ prefix, delimiter: "/", cursor, limit: 1000 });
			for (const folder of listing.delimitedPrefixes) {
				const name = folder.slice(prefix.length, -1);
				if (/^\d+$/.test(name)) versions.push(Number(name));
			}
			cursor = listing.truncated ? listing.cursor : undefined;
		} while (cursor);
		return versions;
	}

	/** When one of a version's files was written (they're all written at once), or null if it has none. */
	async writtenAt(ref: VersionRef): Promise<number | null> {
		const listing = await this.bucket.list({ prefix: versionPrefix(ref.id, ref.version), limit: 1 });
		return listing.objects[0]?.uploaded.getTime() ?? null;
	}

	/** Deletes the thumbnails of a mockup set's options other than `options`: the ones that went. */
	async deleteOptionThumbnails(id: string, options: string[]): Promise<void> {
		const prefix = thumbnailKey(id, "").slice(0, -".png".length);
		const keep = new Set(options.map((option) => thumbnailKey(id, option)));
		const listing = await this.bucket.list({ prefix, limit: 1000 });
		const gone = listing.objects.map((object) => object.key).filter((key) => !keep.has(key));
		if (gone.length) await this.bucket.delete(gone);
	}

	/** Deletes every file of a page, its thumbnails included. */
	deletePage(id: string): Promise<void> {
		return this.deletePrefix(`pages/${id}/`);
	}

	/**
	 * A version's thumbnail, or one of its mockup options' with `option`, if
	 * one was made (or tried and failed) for that version. A page keeps one of
	 * each, so a newer version's replaces it, and it goes with the page.
	 */
	async thumbnail(ref: VersionRef, option?: string): Promise<Thumbnail | null> {
		const object = await this.bucket.get(thumbnailKey(ref.id, option));
		const metadata = object?.customMetadata;
		if (object && metadata?.version === String(ref.version)) {
			if (metadata.failedAt === undefined) return { png: object };
			await object.body.cancel();
			return { failedAt: Number(metadata.failedAt) };
		}
		await object?.body.cancel();
		return null;
	}

	/** Records that shooting a version's thumbnail failed at `at`, in its place, so it isn't retried on every view. */
	async saveThumbnailFailure(ref: VersionRef, at: number, option?: string): Promise<void> {
		await this.bucket.put(thumbnailKey(ref.id, option), new Uint8Array(0), {
			customMetadata: { version: String(ref.version), failedAt: String(at) },
		});
	}

	async saveThumbnail(ref: VersionRef, png: Uint8Array, option?: string): Promise<void> {
		await this.bucket.put(thumbnailKey(ref.id, option), png, {
			httpMetadata: { contentType: "image/png" },
			customMetadata: { version: String(ref.version) },
		});
	}

	/** Where the edge cache keeps a version's file. `_files` can't be a page id, so no request maps here. */
	private cacheKey(ref: VersionRef, path: string): string | null {
		if (!this.cacheOrigin) return null;
		return `${this.cacheOrigin}/_files/${ref.id}/${ref.version}/${path.split("/").map(encodeURIComponent).join("/")}`;
	}

	/** A cached file, or with `range` the part of it that range asks for: the cache answers 206 or 416 itself. */
	private async cached(ref: VersionRef, path: string, range: string | null = null): Promise<Response | undefined> {
		const key = this.cacheKey(ref, path);
		if (!key) return undefined;
		return caches.default.match(range ? new Request(key, { headers: { range } }) : key);
	}

	private cache(ref: VersionRef, path: string, file: { etag: string; contentType: string; body: BodyInit } | null): Promise<void> {
		const key = this.cacheKey(ref, path);
		if (!key) return Promise.resolve();
		const headers = new Headers({ "cache-control": `public, max-age=${CACHE_SECONDS}` });
		if (file) {
			headers.set("etag", file.etag);
			headers.set("content-type", file.contentType);
		} else headers.set(MISSING, "1");
		return caches.default.put(key, new Response(file?.body ?? null, { headers })).catch((error) => console.warn(`caching ${key} failed: ${error}`));
	}

	private async deletePrefix(prefix: string): Promise<void> {
		let cursor: string | undefined;
		do {
			const listing = await this.bucket.list({ prefix, cursor, limit: 1000 });
			if (listing.objects.length) await this.bucket.delete(listing.objects.map((object) => object.key));
			cursor = listing.truncated ? listing.cursor : undefined;
		} while (cursor);
	}
}
