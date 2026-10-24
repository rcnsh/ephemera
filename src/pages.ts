import { contentType, type PageFile, validateBundle } from "./files.ts";
import { LIMITS, PageError, type Ttl } from "./limits.ts";

/**
 * The page store. D1 holds one row per page; R2 holds its files under
 * `pages/<id>/<version>/<path>`. A page is live until it's deleted or its
 * `expires_at` passes (NULL means permanent). After that it's "gone": the
 * Worker answers 410 for `LIMITS.goneGrace`, the sweep purges its files, and
 * once the grace period is over the row is dropped and the id answers 404.
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
	size: number;
	file_count: number;
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
	size: number;
	fileCount: number;
	version: number;
}

export interface Usage {
	temporaryPages: number;
	permanentPages: number;
	bytes: number;
}

export type Lookup = { state: "live"; page: Page } | { state: "gone" } | { state: "missing" };

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS pages (
		id TEXT PRIMARY KEY,
		label TEXT,
		agent TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		expires_at INTEGER,
		deleted_at INTEGER,
		purged INTEGER NOT NULL DEFAULT 0,
		version INTEGER NOT NULL,
		size INTEGER NOT NULL,
		file_count INTEGER NOT NULL
	)`,
	"CREATE INDEX IF NOT EXISTS pages_expires_at ON pages (expires_at)",
];

const LIVE = "deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";
const GONE_AT = "COALESCE(deleted_at, expires_at)";

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
	};
}

function clean(text: string | undefined | null, max: number): string | null {
	const value = text?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
	return value || null;
}

export class Pages {
	private schemaReady: Promise<unknown> | undefined;

	constructor(
		private readonly storage: Storage,
		private readonly now: () => number = Date.now,
	) {}

	private get db() {
		return this.storage.DB;
	}

	/** Creates the table if needed, once per request (the store is built per request). */
	private async ready(): Promise<void> {
		this.schemaReady ??= this.db.batch(SCHEMA.map((sql) => this.db.prepare(sql)));
		await this.schemaReady;
	}

	async lookup(id: string): Promise<Lookup> {
		if (!ID_PATTERN.test(id)) return { state: "missing" };
		await this.ready();
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

	async file(page: Page, path: string): Promise<R2ObjectBody | null> {
		return this.storage.BUCKET.get(`pages/${page.id}/${page.version}/${path}`);
	}

	async hasFile(page: Page, path: string): Promise<boolean> {
		return (await this.storage.BUCKET.head(`pages/${page.id}/${page.version}/${path}`)) !== null;
	}

	async usage(): Promise<Usage> {
		await this.ready();
		const row = await this.db
			.prepare(
				`SELECT
					COUNT(CASE WHEN expires_at IS NOT NULL THEN 1 END) AS temporary,
					COUNT(CASE WHEN expires_at IS NULL THEN 1 END) AS permanent,
					COALESCE(SUM(size), 0) AS bytes
				FROM pages WHERE ${LIVE}`,
			)
			.bind(this.now())
			.first<{ temporary: number; permanent: number; bytes: number }>();
		return { temporaryPages: row!.temporary, permanentPages: row!.permanent, bytes: row!.bytes };
	}

	/** Live pages, soonest to expire first, permanent ones last. */
	async list(): Promise<Page[]> {
		await this.ready();
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
			throw new PageError(507, "Publishing this would go over the 2 GB storage limit; delete some pages first");
		}
	}

	private async writeFiles(id: string, version: number, files: PageFile[]): Promise<void> {
		await Promise.all(
			files.map((file) =>
				this.storage.BUCKET.put(`pages/${id}/${version}/${file.path}`, file.body, {
					httpMetadata: { contentType: contentType(file.path) },
				}),
			),
		);
	}

	private async deletePrefix(prefix: string): Promise<void> {
		let cursor: string | undefined;
		do {
			const listing = await this.storage.BUCKET.list({ prefix, cursor, limit: 1000 });
			if (listing.objects.length) await this.storage.BUCKET.delete(listing.objects.map((object) => object.key));
			cursor = listing.truncated ? listing.cursor : undefined;
		} while (cursor);
	}

	async publish(input: { files: PageFile[]; ttl: Ttl; label?: string | null; agent?: string | null }): Promise<Page> {
		const size = validateBundle(input.files);
		await this.ready();
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
			size,
			file_count: input.files.length,
		};
		await this.writeFiles(row.id, row.version, input.files);
		await this.db
			.prepare(
				`INSERT INTO pages (id, label, agent, created_at, updated_at, expires_at, version, size, file_count)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(row.id, row.label, row.agent, row.created_at, row.updated_at, row.expires_at, row.version, row.size, row.file_count)
			.run();
		return toPage(row);
	}

	/**
	 * Swaps a page's files in one step: the new version is written alongside
	 * the old, the row is pointed at it, then the old version is deleted.
	 * The returned promise for that cleanup can be handed to `waitUntil`.
	 */
	async update(id: string, files: PageFile[]): Promise<{ page: Page; cleanup: Promise<void> }> {
		const size = validateBundle(files);
		const page = await this.get(id);
		const usage = await this.usage();
		if (usage.bytes - page.size + size > LIMITS.totalBytes) {
			throw new PageError(507, "This update would go over the 2 GB storage limit; delete some pages first");
		}
		const version = page.version + 1;
		await this.writeFiles(id, version, files);
		const now = this.now();
		const result = await this.db
			.prepare(`UPDATE pages SET version = ?, size = ?, file_count = ?, updated_at = ? WHERE id = ? AND version = ? AND ${LIVE}`)
			.bind(version, size, files.length, now, id, page.version, now)
			.run();
		if (result.meta.changes !== 1) {
			await this.deletePrefix(`pages/${id}/${version}/`);
			throw new PageError(409, `Page ${id} changed while it was being updated; try again`);
		}
		return {
			page: { ...page, version, size, fileCount: files.length, updatedAt: now },
			cleanup: this.deletePrefix(`pages/${id}/${page.version}/`),
		};
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
		if (by === "permanent") {
			if (page.permanent) return page;
			await this.checkRoom("permanent", 0);
			expiresAt = null;
		} else if (page.permanent) {
			await this.checkRoom("temporary", 0);
			expiresAt = now + by;
		} else {
			expiresAt = Math.min(page.expiresAt! + by, now + LIMITS.maxTtl);
		}
		await this.db.prepare("UPDATE pages SET expires_at = ?, updated_at = ? WHERE id = ?").bind(expiresAt, now, id).run();
		return { ...page, expiresAt, permanent: expiresAt === null, updatedAt: now };
	}

	/** Makes a permanent page temporary with a fresh default TTL. */
	async makeTemporary(id: string): Promise<Page> {
		const page = await this.get(id);
		return page.permanent ? this.extend(id, LIMITS.defaultTtl) : page;
	}

	async delete(id: string): Promise<void> {
		await this.get(id);
		const now = this.now();
		await this.db.prepare("UPDATE pages SET deleted_at = ?, purged = 1 WHERE id = ?").bind(now, id).run();
		await this.deletePrefix(`pages/${id}/`);
	}

	/** Purges the files of pages that have gone, and forgets pages gone longer than the grace period. */
	async sweep(): Promise<{ purged: number; forgotten: number }> {
		await this.ready();
		const now = this.now();
		const { results } = await this.db
			.prepare(`SELECT id FROM pages WHERE purged = 0 AND ${GONE_AT} <= ? LIMIT 200`)
			.bind(now)
			.all<{ id: string }>();
		for (const { id } of results) {
			await this.deletePrefix(`pages/${id}/`);
			await this.db.prepare("UPDATE pages SET purged = 1 WHERE id = ?").bind(id).run();
		}
		const forgotten = await this.db
			.prepare(`DELETE FROM pages WHERE purged = 1 AND ${GONE_AT} <= ?`)
			.bind(now - LIMITS.goneGrace)
			.run();
		return { purged: results.length, forgotten: forgotten.meta.changes };
	}
}
