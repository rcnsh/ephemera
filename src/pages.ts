import { checkBundle, contentType, normalizePath, type PageFile, validateBundle } from "./files.ts";
import { bytesText, LIMITS, PageError, type Ttl } from "./domain.ts";

/**
 * The page store. D1 holds one row per page and one per version it keeps;
 * R2 holds the files under `pages/<id>/<version>/<path>`. Updating a page
 * adds a version and keeps the last `LIMITS.keptVersions`; rolling back
 * points the page at an older one. A page is live until it's deleted or its
 * `expires_at` passes (NULL means permanent). After that it's "gone": the
 * Worker answers 410 for `LIMITS.goneGrace`, the sweep purges its files, and
 * once the grace period is over the row is dropped and the id answers 404.
 * The table is created by the migrations in /migrations.
 */

interface Storage {
	DB: D1Database;
	BUCKET: R2Bucket;
}

interface PageRow {
	id: string;
	label: string | null;
	agent: string | null;
	created_at: number;
	updated_at: number;
	expires_at: number | null;
	deleted_at: number | null;
	version: number;
	latest_version: number;
	size: number;
	file_count: number;
}

interface VersionRow {
	version: number;
	created_at: number;
	size: number;
	file_count: number;
}

export interface Version {
	version: number;
	createdAt: number;
	size: number;
	fileCount: number;
	/** The version the page is serving. */
	current: boolean;
}

export interface Page {
	id: string;
	label: string | null;
	agent: string | null;
	createdAt: number;
	updatedAt: number;
	/** Null for permanent pages. */
	expiresAt: number | null;
	permanent: boolean;
	/** Of the version being served. */
	size: number;
	fileCount: number;
	version: number;
	latestVersion: number;
}

export interface Usage {
	temporaryPages: number;
	permanentPages: number;
	/** Every kept version of every live page. */
	bytes: number;
}

export type Lookup = { state: "live"; page: Page } | { state: "gone" } | { state: "missing" };

const LIVE = "deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";
const GONE_AT = "COALESCE(deleted_at, expires_at)";
/** Bytes stored for live pages, all their kept versions included. Takes `now`. */
const STORED_BYTES = `SELECT COALESCE(SUM(versions.size), 0) FROM versions JOIN pages ON pages.id = versions.page_id WHERE ${LIVE}`;

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
export const ID_PATTERN = /^[a-z2-7]{12}$/;

function newId(): string {
	// 32 divides 256 evenly, so masking keeps every character equally likely.
	return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => ID_ALPHABET[byte & 31]).join("");
}

function toPage(row: PageRow): Page {
	return {
		id: row.id,
		label: row.label,
		agent: row.agent,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		expiresAt: row.expires_at,
		permanent: row.expires_at === null,
		size: row.size,
		fileCount: row.file_count,
		version: row.version,
		latestVersion: row.latest_version,
	};
}

function clean(text: string | undefined | null, max: number): string | null {
	const value = text?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
	return value || null;
}

export interface PagesOptions {
	/** Keeps background work (deleting replaced files) alive after the response; `ctx.waitUntil` in the Worker. */
	defer: (work: Promise<unknown>) => void;
	now?: () => number;
}

export class Pages {
	private readonly defer: (work: Promise<unknown>) => void;
	private readonly now: () => number;

	constructor(
		private readonly storage: Storage,
		options: PagesOptions,
	) {
		this.defer = options.defer;
		this.now = options.now ?? Date.now;
	}

	private get db() {
		return this.storage.DB;
	}

	async lookup(id: string): Promise<Lookup> {
		if (!ID_PATTERN.test(id)) return { state: "missing" };
		const row = await this.db.prepare("SELECT * FROM pages WHERE id = ?").bind(id).first<PageRow>();
		if (!row) return { state: "missing" };
		const goneAt = row.deleted_at ?? row.expires_at;
		const now = this.now();
		if (goneAt === null || goneAt > now) return { state: "live", page: toPage(row) };
		return now - goneAt < LIMITS.goneGrace ? { state: "gone" } : { state: "missing" };
	}

	/** Like `lookup`, but for operations that need a live page. */
	async get(id: string): Promise<Page> {
		const found = await this.lookup(id);
		if (found.state === "live") return found.page;
		if (found.state === "gone") throw new PageError(410, `Page ${id} has expired or been deleted`);
		throw new PageError(404, `No page with id "${id}"`);
	}

	/** A file of the page. With `conditional` request headers, a file the caller already has comes back without a body. */
	async file(page: Page, path: string, conditional?: Headers): Promise<R2ObjectBody | R2Object | null> {
		return this.storage.BUCKET.get(`pages/${page.id}/${page.version}/${path}`, conditional ? { onlyIf: conditional } : {});
	}

	async hasFile(page: Page, path: string): Promise<boolean> {
		return (await this.storage.BUCKET.head(`pages/${page.id}/${page.version}/${path}`)) !== null;
	}

	async usage(): Promise<Usage> {
		const now = this.now();
		const row = await this.db
			.prepare(
				`SELECT
					COUNT(CASE WHEN expires_at IS NOT NULL THEN 1 END) AS temporary,
					COUNT(CASE WHEN expires_at IS NULL THEN 1 END) AS permanent,
					(${STORED_BYTES}) AS bytes
				FROM pages WHERE ${LIVE}`,
			)
			.bind(now, now)
			.first<{ temporary: number; permanent: number; bytes: number }>();
		return { temporaryPages: row!.temporary, permanentPages: row!.permanent, bytes: row!.bytes };
	}

	/** Live pages, soonest to expire first, permanent ones last. */
	async list(): Promise<Page[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM pages WHERE ${LIVE} ORDER BY expires_at IS NULL, expires_at, created_at`)
			.bind(this.now())
			.all<PageRow>();
		return results.map(toPage);
	}

	private async checkRoom(kind: "temporary" | "permanent", extraBytes: number): Promise<void> {
		const usage = await this.usage();
		if (kind === "temporary" && usage.temporaryPages >= LIMITS.temporaryPages) {
			throw new PageError(409, `There are already ${LIMITS.temporaryPages} temporary pages; delete some first`);
		}
		if (kind === "permanent" && usage.permanentPages >= LIMITS.permanentPages) {
			throw new PageError(409, `There are already ${LIMITS.permanentPages} permanent pages; delete some or make them temporary first`);
		}
		if (usage.bytes + extraBytes > LIMITS.totalBytes) {
			throw new PageError(507, `Publishing this would go over the ${bytesText(LIMITS.totalBytes)} storage limit; delete some pages first`);
		}
	}

	/**
	 * `checkRoom` as a SQL condition, for the statement that takes the room.
	 * D1 runs one statement at a time, so two requests racing for the last
	 * slot can't both get it.
	 */
	private roomFor(kind: "temporary" | "permanent" | null, extraBytes: number): { sql: string; params: unknown[] } {
		const now = this.now();
		const params: unknown[] = [];
		let sql = `(${STORED_BYTES}) + ? <= ?`;
		params.push(now, extraBytes, LIMITS.totalBytes);
		if (kind) {
			const permanent = kind === "permanent" ? "IS NULL" : "IS NOT NULL";
			sql += ` AND (SELECT COUNT(*) FROM pages WHERE ${LIVE} AND expires_at ${permanent}) < ?`;
			params.push(now, kind === "permanent" ? LIMITS.permanentPages : LIMITS.temporaryPages);
		}
		return { sql, params };
	}

	/**
	 * Writes `files`, and copies the `carried` paths over from the version `from`.
	 * Waits for every write to settle, even after one fails, so a cleanup that
	 * follows sees them all.
	 */
	private async writeFiles(id: string, version: number, files: PageFile[], carried: string[] = [], from?: Page): Promise<void> {
		const key = (path: string) => `pages/${id}/${version}/${path}`;
		const results = await Promise.allSettled([
			...files.map((file) => this.storage.BUCKET.put(key(file.path), file.body, { httpMetadata: { contentType: contentType(file.path) } })),
			...carried.map(async (path) => {
				const object = await this.file(from!, path);
				if (!object || !("body" in object)) throw new Error(`pages/${id}/${from!.version}/${path} vanished while copying`);
				await this.storage.BUCKET.put(key(path), object.body, { httpMetadata: object.httpMetadata });
			}),
		]);
		const failed = results.find((result) => result.status === "rejected");
		if (failed) throw failed.reason;
	}

	/** The paths and sizes of the files a page is serving. */
	private async listFiles(page: Page): Promise<Map<string, number>> {
		const prefix = `pages/${page.id}/${page.version}/`;
		const files = new Map<string, number>();
		let cursor: string | undefined;
		do {
			const listing = await this.storage.BUCKET.list({ prefix, cursor, limit: 1000 });
			for (const object of listing.objects) files.set(object.key.slice(prefix.length), object.size);
			cursor = listing.truncated ? listing.cursor : undefined;
		} while (cursor);
		return files;
	}

	private async deletePrefix(prefix: string): Promise<void> {
		let cursor: string | undefined;
		do {
			const listing = await this.storage.BUCKET.list({ prefix, cursor, limit: 1000 });
			if (listing.objects.length) await this.storage.BUCKET.delete(listing.objects.map((object) => object.key));
			cursor = listing.truncated ? listing.cursor : undefined;
		} while (cursor);
	}

	/** Files go to R2 before the row goes to D1, and are deleted again if either step fails, so nothing is left behind. */
	async publish(input: { files: PageFile[]; ttl: Ttl; label?: string | null; agent?: string | null }): Promise<Page> {
		const { files, size } = validateBundle(input.files);
		await this.checkRoom(input.ttl === "permanent" ? "permanent" : "temporary", size);
		const now = this.now();
		const row: PageRow = {
			id: newId(),
			label: clean(input.label, 200),
			agent: clean(input.agent, 100),
			created_at: now,
			updated_at: now,
			expires_at: input.ttl === "permanent" ? null : now + input.ttl,
			deleted_at: null,
			version: 1,
			latest_version: 1,
			size,
			file_count: files.length,
		};
		try {
			await this.writeFiles(row.id, row.version, files);
			const room = this.roomFor(input.ttl === "permanent" ? "permanent" : "temporary", size);
			const [result] = await this.db.batch([
				this.db
					.prepare(
						`INSERT INTO pages (id, label, agent, created_at, updated_at, expires_at, version, latest_version, size, file_count)
						SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${room.sql}`,
					)
					.bind(row.id, row.label, row.agent, row.created_at, row.updated_at, row.expires_at, row.version, row.latest_version, row.size, row.file_count, ...room.params),
				this.addVersion(row.id, row.version, now, size, files.length),
			]);
			if (result!.meta.changes !== 1) {
				// Another publish took the room while the files were uploading.
				await this.checkRoom(input.ttl === "permanent" ? "permanent" : "temporary", size);
				throw new PageError(409, "Out of room; try again");
			}
		} catch (error) {
			await this.deletePrefix(`pages/${row.id}/`);
			throw error;
		}
		return toPage(row);
	}

	/** Records a version, if the page row it belongs to exists by then (it's batched after the write that creates or moves it). */
	private addVersion(id: string, version: number, now: number, size: number, fileCount: number): D1PreparedStatement {
		return this.db
			.prepare(
				`INSERT INTO versions (page_id, version, created_at, size, file_count)
				SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pages WHERE id = ? AND version = ?)`,
			)
			.bind(id, version, now, size, fileCount, id, version);
	}

	/**
	 * Adds a version and serves it, in one step: its files are written
	 * alongside the old ones, then the row is pointed at it. Versions beyond
	 * the last `LIMITS.keptVersions` are deleted in the background.
	 */
	async update(id: string, input: PageFile[]): Promise<Page> {
		const { files, size } = validateBundle(input);
		const page = await this.get(id);
		return this.addVersionOf(page, size, files.length, (version) => this.writeFiles(id, version, files));
	}

	/**
	 * Like `update`, but only for the files that change: `files` are added or
	 * replaced, `remove` deleted, and the rest copied over unchanged.
	 */
	async patch(id: string, changes: { files: PageFile[]; remove: string[] }): Promise<Page> {
		const page = await this.get(id);
		const put = changes.files.map((file) => ({ path: normalizePath(file.path), body: file.body }));
		const putPaths = new Set(put.map((file) => file.path));
		const remove = new Set(changes.remove.map(normalizePath));
		const existing = await this.listFiles(page);
		for (const path of remove) {
			if (!existing.has(path)) throw new PageError(404, `Page ${id} has no file "${path}" to remove`);
			if (putPaths.has(path)) throw new PageError(400, `"${path}" is both written and removed`);
		}
		const carried = [...existing.keys()].filter((path) => !remove.has(path) && !putPaths.has(path));
		const size = checkBundle(
			[...carried, ...put.map((file) => file.path)],
			carried.reduce((total, path) => total + existing.get(path)!, 0) + put.reduce((total, file) => total + file.body.byteLength, 0),
		);
		return this.addVersionOf(page, size, carried.length + put.length, (version) => this.writeFiles(id, version, put, carried, page));
	}

	/** Writes a new version of `page` with `write`, then serves it. */
	private async addVersionOf(page: Page, size: number, fileCount: number, write: (version: number) => Promise<void>): Promise<Page> {
		const id = page.id;
		const usage = await this.usage();
		if (usage.bytes + size > LIMITS.totalBytes) {
			throw new PageError(507, `This update would go over the ${bytesText(LIMITS.totalBytes)} storage limit; delete some pages first`);
		}
		const version = page.latestVersion + 1;
		try {
			await write(version);
		} catch (error) {
			await this.deletePrefix(`pages/${id}/${version}/`);
			throw error;
		}
		const now = this.now();
		const room = this.roomFor(null, size);
		const [result] = await this.db.batch([
			this.db
				.prepare(
					`UPDATE pages SET version = ?, latest_version = ?, size = ?, file_count = ?, updated_at = ?
					WHERE id = ? AND latest_version = ? AND ${LIVE} AND ${room.sql}`,
				)
				.bind(version, version, size, fileCount, now, id, page.latestVersion, now, ...room.params),
			this.addVersion(id, version, now, size, fileCount),
		]);
		if (result!.meta.changes !== 1) {
			await this.deletePrefix(`pages/${id}/${version}/`);
			throw new PageError(409, `Page ${id} changed while it was being updated; try again`);
		}
		this.defer(this.prune(id));
		return { ...page, version, latestVersion: version, size, fileCount, updatedAt: now };
	}

	/** The versions a live page keeps, newest first. */
	async versions(id: string): Promise<Version[]> {
		const page = await this.get(id);
		const { results } = await this.db
			.prepare("SELECT version, created_at, size, file_count FROM versions WHERE page_id = ? ORDER BY version DESC")
			.bind(id)
			.all<VersionRow>();
		return results.map((row) => ({
			version: row.version,
			createdAt: row.created_at,
			size: row.size,
			fileCount: row.file_count,
			current: row.version === page.version,
		}));
	}

	/** Serves an older (or newer) kept version again. Later updates still get new numbers. */
	async rollback(id: string, version: number): Promise<Page> {
		const page = await this.get(id);
		if (version === page.version) return page;
		const target = await this.db
			.prepare("SELECT version, created_at, size, file_count FROM versions WHERE page_id = ? AND version = ?")
			.bind(id, version)
			.first<VersionRow>();
		if (!target) throw new PageError(404, `Page ${id} has no version ${version}; list_versions shows the ones it keeps`);
		const now = this.now();
		const result = await this.db
			.prepare(
				`UPDATE pages SET version = ?, size = ?, file_count = ?, updated_at = ?
				WHERE id = ? AND version = ? AND ${LIVE} AND EXISTS (SELECT 1 FROM versions WHERE page_id = ? AND version = ?)`,
			)
			.bind(version, target.size, target.file_count, now, id, page.version, now, id, version)
			.run();
		if (result.meta.changes !== 1) throw new PageError(409, `Page ${id} changed while it was being rolled back; try again`);
		return { ...page, version, size: target.size, fileCount: target.file_count, updatedAt: now };
	}

	/**
	 * Deletes the versions past the newest `LIMITS.keptVersions`, never the one
	 * being served. The row goes first, so a rollback can't pick a version whose
	 * files are half gone; files left by a failure here go when the page does.
	 */
	private async prune(id: string): Promise<void> {
		const { results } = await this.db
			.prepare(
				`SELECT version FROM versions WHERE page_id = ?
				AND version NOT IN (SELECT version FROM versions WHERE page_id = ? ORDER BY version DESC LIMIT ?)`,
			)
			.bind(id, id, LIMITS.keptVersions)
			.all<{ version: number }>();
		for (const { version } of results) {
			const deleted = await this.db
				.prepare("DELETE FROM versions WHERE page_id = ? AND version = ? AND version != (SELECT version FROM pages WHERE id = ?)")
				.bind(id, version, id)
				.run();
			if (deleted.meta.changes === 1) await this.deletePrefix(`pages/${id}/${version}/`);
		}
	}

	/**
	 * `"permanent"` makes the page permanent. A duration adds to the current
	 * expiry (never past 30 days from now); on a permanent page it makes the
	 * page temporary again, expiring that long from now.
	 */
	async extend(id: string, by: Ttl): Promise<Page> {
		const page = await this.get(id);
		const now = this.now();
		let expiresAt: number | null;
		let kind: "temporary" | "permanent" | null = null;
		if (by === "permanent") {
			if (page.permanent) return page;
			kind = "permanent";
			expiresAt = null;
		} else if (page.permanent) {
			kind = "temporary";
			expiresAt = now + by;
		} else {
			expiresAt = Math.min(page.expiresAt! + by, now + LIMITS.maxTtl);
		}
		if (kind) await this.checkRoom(kind, 0);
		const room = kind ? this.roomFor(kind, 0) : { sql: "1", params: [] };
		const result = await this.db
			.prepare(`UPDATE pages SET expires_at = ?, updated_at = ? WHERE id = ? AND ${LIVE} AND ${room.sql}`)
			.bind(expiresAt, now, id, now, ...room.params)
			.run();
		if (result.meta.changes !== 1) {
			// Either another request took the last slot, or the page expired or was deleted since the lookup.
			if (kind) await this.checkRoom(kind, 0);
			throw new PageError(410, `Page ${id} has expired or been deleted`);
		}
		return { ...page, expiresAt, permanent: expiresAt === null, updatedAt: now };
	}

	/** Makes a permanent page temporary with a fresh default TTL. */
	async makeTemporary(id: string): Promise<Page> {
		const page = await this.get(id);
		return page.permanent ? this.extend(id, LIMITS.defaultTtl) : page;
	}

	/** The page is gone as soon as the row says so; if deleting its files fails, the sweep tries again. */
	async delete(id: string): Promise<void> {
		await this.get(id);
		await this.db.prepare("UPDATE pages SET deleted_at = ? WHERE id = ?").bind(this.now(), id).run();
		await this.purge(id);
	}

	private async purge(id: string): Promise<void> {
		await this.deletePrefix(`pages/${id}/`);
		await this.db.prepare("UPDATE pages SET purged = 1 WHERE id = ?").bind(id).run();
	}

	/** Purges the files of pages that have gone, and forgets pages gone longer than the grace period. */
	async sweep(): Promise<{ purged: number; forgotten: number }> {
		const now = this.now();
		const { results } = await this.db
			.prepare(`SELECT id FROM pages WHERE purged = 0 AND ${GONE_AT} <= ? LIMIT 200`)
			.bind(now)
			.all<{ id: string }>();
		for (const { id } of results) await this.purge(id);
		const [, forgotten] = await this.db.batch([
			this.db
				.prepare(`DELETE FROM versions WHERE page_id IN (SELECT id FROM pages WHERE purged = 1 AND ${GONE_AT} <= ?)`)
				.bind(now - LIMITS.goneGrace),
			this.db.prepare(`DELETE FROM pages WHERE purged = 1 AND ${GONE_AT} <= ?`).bind(now - LIMITS.goneGrace),
		]);
		return { purged: results.length, forgotten: forgotten!.meta.changes };
	}
}
