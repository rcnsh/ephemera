import { contentType, type PageFile } from "./files.ts";

/**
 * The files of every version of every page, and their thumbnails: R2 holds
 * them under `pages/<id>/<version>/<path>` (thumbnails under
 * `pages/<id>/thumbnail.png` and `pages/<id>/thumbnails/<option>.png`), and
 * nothing outside this module knows that layout.
 *
 * A version's files never change, so `serve` keeps them in the edge cache
 * under their version (see `VersionFilesOptions.cacheOrigin`): R2 is read once
 * per file per data centre rather than on every view. Each frame of a mockup
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
export type PageFiles = Pick<VersionFiles, "serve" | "exists" | "read" | "manifest" | "thumbnail" | "saveThumbnail">;

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
	 * With an `ifNoneMatch` naming the file's ETag, the body is null.
	 */
	async serve(ref: VersionRef, path: string, ifNoneMatch: string | null = null): Promise<ServedFile | null> {
		const cached = await this.cached(ref, path);
		if (cached) {
			if (cached.headers.has(MISSING)) return null;
			const etag = cached.headers.get("etag")!;
			const fresh = matches(ifNoneMatch, etag);
			if (fresh) await cached.body?.cancel();
			return { etag, contentType: cached.headers.get("content-type")!, body: fresh ? null : cached.body, cached: true };
		}
		const object = await this.bucket.get(versionPrefix(ref.id, ref.version) + path);
		if (!object) {
			// Only a missing index is worth remembering: it's how a mockup set
			// without one of its own is shown, on every view.
			if (path === "index.html") this.defer(this.cache(ref, path, null));
			return null;
		}
		const file = { etag: object.httpEtag, contentType: object.httpMetadata?.contentType ?? "application/octet-stream", cached: false };
		if (matches(ifNoneMatch, file.etag)) {
			if (this.cacheOrigin) this.defer(this.cache(ref, path, { ...file, body: object.body }));
			else await object.body.cancel();
			return { ...file, body: null };
		}
		// The cache gets its own read rather than a tee: a tee would hold
		// whatever a slow client hasn't taken yet in memory, up to a whole page.
		if (this.cacheOrigin) {
			this.defer(this.bucket.get(versionPrefix(ref.id, ref.version) + path).then((copy) => (copy ? this.cache(ref, path, { ...file, body: copy.body }) : undefined)));
		}
		return { ...file, body: object.body };
	}

	/** Whether a version has a file at `path`. */
	async exists(ref: VersionRef, path: string): Promise<boolean> {
		const cached = await this.cached(ref, path);
		if (cached) {
			await cached.body?.cancel();
			return !cached.headers.has(MISSING);
		}
		return (await this.bucket.head(versionPrefix(ref.id, ref.version) + path)) !== null;
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

	/** Deletes every file of a page, its thumbnails included. */
	deletePage(id: string): Promise<void> {
		return this.deletePrefix(`pages/${id}/`);
	}

	/**
	 * A version's thumbnail, or one of its mockup options' with `option`, if
	 * one was made for that version. A page keeps one of each, so a newer
	 * version's replaces it, and it goes with the page.
	 */
	async thumbnail(ref: VersionRef, option?: string): Promise<R2ObjectBody | null> {
		const object = await this.bucket.get(thumbnailKey(ref.id, option));
		if (object && object.customMetadata?.version === String(ref.version)) return object;
		await object?.body.cancel();
		return null;
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

	private async cached(ref: VersionRef, path: string): Promise<Response | undefined> {
		const key = this.cacheKey(ref, path);
		return key ? caches.default.match(key) : undefined;
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
