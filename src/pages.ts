import { checkBundle, contentType, normalizePath, type PageFile, type PageKind, validateBundle } from "./files.ts";
import { bytesText, LIMITS, PageError, type Ttl } from "./domain.ts";
import { type MockupOption, mockupOptions, slugify, type Verdict } from "./mockups.ts";

/**
 * The page store. D1 holds one row per page and one per version it keeps;
 * R2 holds the files under `pages/<id>/<version>/<path>`. Updating a page
 * adds a version and keeps the last `LIMITS.keptVersions`; rolling back
 * points the page at an older one. A page is live until it's deleted or its
 * `expires_at` passes (NULL means permanent). After that it's "gone": the
 * Worker answers 410 for `LIMITS.goneGrace`, the sweep purges its files, and
 * once the grace period is over the row is dropped and the id answers 404.
 * Mockup sets are pages too (`kind` 'mockup'), with a row per option in
 * `verdicts`. The table is created by the migrations in /migrations.
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
	visibility: Visibility;
	password_hash: string | null;
	share_epoch: number;
	kind: PageKind;
	project: string | null;
}

interface VerdictRow {
	page_id: string;
	option: string;
	verdict: Verdict;
	note: string | null;
	updated_at: number;
}

function toOption(row: VerdictRow): MockupOption {
	return { name: row.option, verdict: row.verdict, note: row.note, updatedAt: row.updated_at };
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

/** Public pages are served to anyone with the URL; private ones need a pass (see `viewPass`). */
export type Visibility = "public" | "private";

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
	visibility: Visibility;
	/** Set on private pages that can be unlocked with a password. */
	passwordHash: string | null;
	/** Signs view passes; bumped to revoke them. */
	shareEpoch: number;
	kind: PageKind;
	/** Groups mockup sets; a slug. Null for plain pages. */
	project: string | null;
}

export interface Usage {
	/** Plain pages only: mockup sets don't count towards the page limits. */
	temporaryPages: number;
	permanentPages: number;
	mockups: number;
	/** Every kept version of every live page. */
	bytes: number;
}

export type Lookup = { state: "live"; page: Page } | { state: "gone" } | { state: "missing" };

const LIVE = "deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";
const GONE_AT = "COALESCE(deleted_at, expires_at)";
/** Bytes stored for live pages, all their kept versions included. Takes `now`. */
const STORED_BYTES = `SELECT COALESCE(SUM(versions.size), 0) FROM versions JOIN pages ON pages.id = versions.page_id WHERE ${LIVE}`;

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** A page id, for use inside other patterns: 12 random characters, or a mockup set's `<project>-<name>-<6 random>`. */
export const ID_SOURCE = "[a-z2-7]{12}|[a-z0-9]+(?:-[a-z0-9]+)*-[a-z2-7]{6}";
export const ID_PATTERN = new RegExp(`^(?=.{1,47}$)(?:${ID_SOURCE})$`);

function randomChars(length: number): string {
	// 32 divides 256 evenly, so masking keeps every character equally likely.
	return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => ID_ALPHABET[byte & 31]).join("");
}

/** A mockup set's id: its project and name as one slug, then 6 random characters. */
function mockupId(project: string, name: string): string {
	const slug = slugify(`${project}-${name}`);
	if (!slug) throw new PageError(400, "A mockup set's project and name need some letters or digits");
	return `${slug}-${randomChars(6)}`;
}

/** Options as a JSON array, to go through `json_each` in SQL. */
function optionsJson(paths: string[]): string {
	return JSON.stringify(mockupOptions(paths));
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
		visibility: row.visibility,
		passwordHash: row.password_hash,
		shareEpoch: row.share_epoch,
		kind: row.kind,
		project: row.project,
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
					COUNT(CASE WHEN kind = 'page' AND expires_at IS NOT NULL THEN 1 END) AS temporary,
					COUNT(CASE WHEN kind = 'page' AND expires_at IS NULL THEN 1 END) AS permanent,
					COUNT(CASE WHEN kind = 'mockup' THEN 1 END) AS mockups,
					(${STORED_BYTES}) AS bytes
				FROM pages WHERE ${LIVE}`,
			)
			.bind(now, now)
			.first<{ temporary: number; permanent: number; mockups: number; bytes: number }>();
		return { temporaryPages: row!.temporary, permanentPages: row!.permanent, mockups: row!.mockups, bytes: row!.bytes };
	}

	/** Live pages, soonest to expire first, permanent ones last. */
	async list(): Promise<Page[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM pages WHERE ${LIVE} ORDER BY expires_at IS NULL, expires_at, created_at`)
			.bind(this.now())
			.all<PageRow>();
		return results.map(toPage);
	}

	/** Checks there's room for `extraBytes` more, and for one more page of `kind` (null for one that doesn't count, like a mockup set). */
	private async checkRoom(kind: "temporary" | "permanent" | null, extraBytes: number): Promise<void> {
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
			sql += ` AND (SELECT COUNT(*) FROM pages WHERE ${LIVE} AND kind = 'page' AND expires_at ${permanent}) < ?`;
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

	/** The paths and sizes of the files of a version of a page. */
	private async listFiles(id: string, version: number): Promise<Map<string, number>> {
		const prefix = `pages/${id}/${version}/`;
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

	/**
	 * Files go to R2 before the row goes to D1, and are deleted again if either
	 * step fails, so nothing is left behind. With `mockup`, publishes a mockup
	 * set: its id comes from the project and name, and it doesn't count
	 * towards the page limits.
	 */
	async publish(input: {
		files: PageFile[];
		ttl: Ttl;
		label?: string | null;
		agent?: string | null;
		visibility?: Visibility;
		passwordHash?: string | null;
		mockup?: { project: string; name: string };
	}): Promise<Page> {
		const kind: PageKind = input.mockup ? "mockup" : "page";
		const { files, size } = validateBundle(input.files, kind);
		const lifetime = kind === "mockup" ? null : input.ttl === "permanent" ? "permanent" : "temporary";
		await this.checkRoom(lifetime, size);
		const now = this.now();
		const row: PageRow = {
			id: input.mockup ? mockupId(input.mockup.project, input.mockup.name) : randomChars(12),
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
			visibility: input.visibility ?? "public",
			password_hash: input.passwordHash ?? null,
			share_epoch: 0,
			kind,
			project: input.mockup ? slugify(input.mockup.project) || null : null,
		};
		try {
			await this.writeFiles(row.id, row.version, files);
			const room = this.roomFor(lifetime, size);
			const [result] = await this.db.batch([
				this.db
					.prepare(
						`INSERT INTO pages (id, label, agent, created_at, updated_at, expires_at, version, latest_version, size, file_count, visibility, password_hash, kind, project)
						SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${room.sql}`,
					)
					.bind(
						row.id,
						row.label,
						row.agent,
						row.created_at,
						row.updated_at,
						row.expires_at,
						row.version,
						row.latest_version,
						row.size,
						row.file_count,
						row.visibility,
						row.password_hash,
						row.kind,
						row.project,
						...room.params,
					),
				this.addVersion(row.id, row.version, now, size, files.length),
				...(kind === "mockup" ? this.syncOptions(row.id, row.version, now, files.map((file) => file.path)) : []),
			]);
			if (result!.meta.changes !== 1) {
				// Another publish took the room while the files were uploading.
				await this.checkRoom(lifetime, size);
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
	 * Brings a mockup set's verdicts in step with the options of the version
	 * given by its `paths`: new options start pending, and the verdicts of
	 * options that went go too. Like `addVersion`, it only applies if the page
	 * is serving `version` by then.
	 */
	private syncOptions(id: string, version: number, now: number, paths: string[]): D1PreparedStatement[] {
		const options = optionsJson(paths);
		const serving = "EXISTS (SELECT 1 FROM pages WHERE id = ? AND version = ?)";
		return [
			this.db
				.prepare(`DELETE FROM verdicts WHERE page_id = ? AND option NOT IN (SELECT value FROM json_each(?)) AND ${serving}`)
				.bind(id, options, id, version),
			this.db
				.prepare(`INSERT OR IGNORE INTO verdicts (page_id, option, verdict, updated_at) SELECT ?, value, 'pending', ? FROM json_each(?) WHERE ${serving}`)
				.bind(id, now, options, id, version),
		];
	}

	/**
	 * Adds a version and serves it, in one step: its files are written
	 * alongside the old ones, then the row is pointed at it. Versions beyond
	 * the last `LIMITS.keptVersions` are deleted in the background.
	 */
	async update(id: string, input: PageFile[]): Promise<Page> {
		const page = await this.get(id);
		const { files, size } = validateBundle(input, page.kind);
		return this.addVersionOf(page, size, files.map((file) => file.path), (version) => this.writeFiles(id, version, files));
	}

	/**
	 * Like `update`, but only for the files that change: `files` are added or
	 * replaced, `remove` deleted, and the rest copied over unchanged. A path in
	 * `remove` ending in "/" removes that whole folder.
	 */
	async patch(id: string, changes: { files: PageFile[]; remove: string[] }): Promise<Page> {
		const page = await this.get(id);
		const put = changes.files.map((file) => ({ path: normalizePath(file.path), body: file.body }));
		const putPaths = new Set(put.map((file) => file.path));
		const existing = await this.listFiles(id, page.version);
		const remove = new Set<string>();
		for (const raw of changes.remove) {
			if (raw.trim().endsWith("/")) {
				const folder = normalizePath(raw.trim().replace(/\/+$/, ""));
				const inside = [...existing.keys()].filter((path) => path.startsWith(`${folder}/`));
				if (!inside.length) throw new PageError(404, `Page ${id} has no folder "${folder}/" to remove`);
				for (const path of inside) remove.add(path);
			} else {
				const path = normalizePath(raw);
				if (!existing.has(path)) throw new PageError(404, `Page ${id} has no file "${path}" to remove`);
				remove.add(path);
			}
		}
		for (const path of remove) {
			if (putPaths.has(path)) throw new PageError(400, `"${path}" is both written and removed`);
		}
		const carried = [...existing.keys()].filter((path) => !remove.has(path) && !putPaths.has(path));
		const paths = [...carried, ...putPaths];
		const size = checkBundle(
			paths,
			carried.reduce((total, path) => total + existing.get(path)!, 0) + put.reduce((total, file) => total + file.body.byteLength, 0),
			page.kind,
		);
		return this.addVersionOf(page, size, paths, (version) => this.writeFiles(id, version, put, carried, page));
	}

	/** Writes a new version of `page` with `write`, then serves it. `paths` are the files it will have. */
	private async addVersionOf(page: Page, size: number, paths: string[], write: (version: number) => Promise<void>): Promise<Page> {
		const fileCount = paths.length;
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
			...(page.kind === "mockup" ? this.syncOptions(id, version, now, paths) : []),
		]);
		if (result!.meta.changes !== 1) {
			await this.deletePrefix(`pages/${id}/${version}/`);
			throw new PageError(409, `Page ${id} changed while it was being updated; try again`);
		}
		this.defer(this.prune(id));
		return { ...page, version, latestVersion: version, size, fileCount, updatedAt: now };
	}

	/** The versions every live page keeps, newest first, by page id. */
	async allVersions(): Promise<Map<string, Version[]>> {
		const now = this.now();
		const { results } = await this.db
			.prepare(
				`SELECT versions.page_id, versions.version, versions.created_at, versions.size, versions.file_count, pages.version AS current
				FROM versions JOIN pages ON pages.id = versions.page_id WHERE ${LIVE} ORDER BY versions.version DESC`,
			)
			.bind(now)
			.all<VersionRow & { page_id: string; current: number }>();
		const byPage = new Map<string, Version[]>();
		for (const row of results) {
			const list = byPage.get(row.page_id) ?? [];
			list.push({ version: row.version, createdAt: row.created_at, size: row.size, fileCount: row.file_count, current: row.version === row.current });
			byPage.set(row.page_id, list);
		}
		return byPage;
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
		const options = page.kind === "mockup" ? this.syncOptions(id, version, now, [...(await this.listFiles(id, version)).keys()]) : [];
		const [result] = await this.db.batch([
			this.db
				.prepare(
					`UPDATE pages SET version = ?, size = ?, file_count = ?, updated_at = ?
					WHERE id = ? AND version = ? AND ${LIVE} AND EXISTS (SELECT 1 FROM versions WHERE page_id = ? AND version = ?)`,
				)
				.bind(version, target.size, target.file_count, now, id, page.version, now, id, version),
			...options,
		]);
		if (result!.meta.changes !== 1) throw new PageError(409, `Page ${id} changed while it was being rolled back; try again`);
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
		// Mockup sets don't count towards the page limits either way.
		if (page.kind === "mockup") kind = null;
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

	/**
	 * Makes a page public or private, and sets or clears its password (only
	 * private pages have one). Either way, every pass handed out so far stops
	 * working.
	 */
	async setVisibility(id: string, visibility: Visibility, passwordHash: string | null): Promise<Page> {
		const page = await this.get(id);
		const hash = visibility === "private" ? passwordHash : null;
		const now = this.now();
		const result = await this.db
			.prepare(`UPDATE pages SET visibility = ?, password_hash = ?, share_epoch = share_epoch + 1, updated_at = ? WHERE id = ? AND ${LIVE}`)
			.bind(visibility, hash, now, id, now)
			.run();
		if (result.meta.changes !== 1) throw new PageError(410, `Page ${id} has expired or been deleted`);
		return { ...page, visibility, passwordHash: hash, shareEpoch: page.shareEpoch + 1, updatedAt: now };
	}

	async setLabel(id: string, label: string | null): Promise<Page> {
		const page = await this.get(id);
		const now = this.now();
		const cleaned = clean(label, 200);
		const result = await this.db.prepare(`UPDATE pages SET label = ?, updated_at = ? WHERE id = ? AND ${LIVE}`).bind(cleaned, now, id, now).run();
		if (result.meta.changes !== 1) throw new PageError(410, `Page ${id} has expired or been deleted`);
		return { ...page, label: cleaned, updatedAt: now };
	}

	/** The page's thumbnail, if one was made for the version it's serving. It lives with the files, so it goes when they do. */
	async thumbnail(page: Page): Promise<R2ObjectBody | null> {
		const object = await this.storage.BUCKET.get(`pages/${page.id}/thumbnail.png`);
		if (object && object.customMetadata?.version === String(page.version)) return object;
		await object?.body.cancel();
		return null;
	}

	async saveThumbnail(page: Page, png: Uint8Array): Promise<void> {
		await this.storage.BUCKET.put(`pages/${page.id}/thumbnail.png`, png, {
			httpMetadata: { contentType: "image/png" },
			customMetadata: { version: String(page.version) },
		});
	}

	/** The thumbnail of one option of a mockup set, if one was made for the version it's serving. */
	async optionThumbnail(page: Page, option: string): Promise<R2ObjectBody | null> {
		const object = await this.storage.BUCKET.get(`pages/${page.id}/thumbnails/${option}.png`);
		if (object && object.customMetadata?.version === String(page.version)) return object;
		await object?.body.cancel();
		return null;
	}

	async saveOptionThumbnail(page: Page, option: string, png: Uint8Array): Promise<void> {
		await this.storage.BUCKET.put(`pages/${page.id}/thumbnails/${option}.png`, png, {
			httpMetadata: { contentType: "image/png" },
			customMetadata: { version: String(page.version) },
		});
	}

	/** The options of a mockup set, by name, with their verdicts. */
	async options(id: string): Promise<MockupOption[]> {
		const { results } = await this.db.prepare("SELECT * FROM verdicts WHERE page_id = ? ORDER BY option").bind(id).all<VerdictRow>();
		return results.map(toOption);
	}

	/** The options of every live mockup set, by page id. */
	async allOptions(): Promise<Map<string, MockupOption[]>> {
		const { results } = await this.db
			.prepare(`SELECT verdicts.* FROM verdicts JOIN pages ON pages.id = verdicts.page_id WHERE ${LIVE} ORDER BY verdicts.option`)
			.bind(this.now())
			.all<VerdictRow>();
		const byPage = new Map<string, MockupOption[]>();
		for (const row of results) byPage.set(row.page_id, [...(byPage.get(row.page_id) ?? []), toOption(row)]);
		return byPage;
	}

	/**
	 * Picks, rejects or resets one option of a mockup set. `note` replaces the
	 * option's note (null or "" clears it); undefined keeps it.
	 */
	async setVerdict(id: string, option: string, verdict: Verdict, note?: string | null): Promise<MockupOption[]> {
		const page = await this.get(id);
		if (page.kind !== "mockup") throw new PageError(400, `Page ${id} isn't a mockup set; only mockup sets have verdicts`);
		const now = this.now();
		const result = await this.db
			.prepare(`UPDATE verdicts SET verdict = ?, note = CASE WHEN ? THEN ? ELSE note END, updated_at = ? WHERE page_id = ? AND option = ?`)
			.bind(verdict, note !== undefined ? 1 : 0, clean(note, 200), now, id, option)
			.run();
		const options = await this.options(id);
		if (result.meta.changes !== 1) {
			throw new PageError(404, `Mockup set ${id} has no option "${option}"; its options are ${options.map((o) => `"${o.name}"`).join(", ")}`);
		}
		return options;
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
			this.db.prepare("DELETE FROM verdicts WHERE page_id NOT IN (SELECT id FROM pages)"),
		]);
		return { purged: results.length, forgotten: forgotten!.meta.changes };
	}
}
