import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { hashPassword, uploadToken } from "./auth.ts";
import { bytesText, isoTime, LIMITS, PageError, pageUrl, parseTtl, ttlOmitted } from "./domain.ts";
import { type Content, contentType, decodeContent, decodeFiles, hasFiles, normalizePath, type PageKind } from "./files.ts";
import { rootRelativeWarnings } from "./links.ts";
import { type MockupOption, slugify, VERDICTS, type Verdict } from "./mockups.ts";
import type { Page, Pages, Usage, Version, VerdictCounts, Visibility } from "./pages.ts";
import { viewerUrl } from "./privacy.ts";

/** What agents see of a page. Times are ISO 8601 strings (see `isoTime`). */
export function pageView(page: Page, host: string) {
	return {
		id: page.id,
		url: pageUrl(host, page.id),
		label: page.label,
		agent: page.agent,
		createdAt: isoTime(page.createdAt),
		updatedAt: isoTime(page.updatedAt),
		expiresAt: isoTime(page.expiresAt),
		permanent: page.permanent,
		size: page.size,
		fileCount: page.fileCount,
		version: page.version,
		visibility: page.visibility,
		hasPassword: page.passwordHash !== null,
		kind: page.kind,
		project: page.project,
	};
}

/** What agents see of a mockup set's options. */
function optionsView(options: MockupOption[]) {
	return options.map((option) => ({ ...option, updatedAt: isoTime(option.updatedAt) }));
}

function versionView(version: Version) {
	return { ...version, createdAt: isoTime(version.createdAt) };
}

/** What agents see of a page, with a mockup set's options and verdicts. */
function setView(page: Page, host: string, options: MockupOption[] | undefined) {
	return page.kind === "mockup" ? { ...pageView(page, host), options: optionsView(options ?? []) } : pageView(page, host);
}

/** One row of `list_pages`: just enough to pick a page out and go on to get_page. */
function rowView(page: Page & { verdicts: VerdictCounts | null }, host: string) {
	return {
		id: page.id,
		url: pageUrl(host, page.id),
		label: page.label,
		kind: page.kind,
		updatedAt: isoTime(page.updatedAt),
		expiresAt: isoTime(page.expiresAt),
		...(page.verdicts ? { verdicts: page.verdicts } : {}),
	};
}

/** Search input as callers send it, unchecked. */
export interface ListInput {
	query?: unknown;
	agent?: unknown;
	kind?: unknown;
	project?: unknown;
	limit?: unknown;
	cursor?: unknown;
}

/** How many rows `list` returns when not told, and at most. */
export const LIST_LIMITS = { default: 20, max: 100 } as const;

/** The largest file `readFile` returns. Bigger ones would swamp an agent's context; the zip route gets them. */
export const READ_LIMIT = 256 * 1024;

/** File types that are text when they decode as UTF-8. */
const TEXTUAL = /^(text\/|application\/(json|javascript|xml)|image\/svg\+xml)/;

/** Already-compressed files go into a zip stored rather than deflated again. */
const STORE_IN_ZIP = /^(image\/(png|jpeg|gif|webp|avif)|font\/woff2?|audio\/|video\/|application\/(pdf|wasm))/;

function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw new PageError(400, `${name} must be a string`);
	return value;
}

/** A version number as callers send it: a number, a numeric string from a query string, or nothing. */
function optionalVersion(value: unknown, name = "version"): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const number = typeof value === "string" ? Number(value) : value;
	if (typeof number !== "number" || !Number.isInteger(number)) throw new PageError(400, `${name} must be a whole number; list_versions shows the ones a page keeps`);
	return number;
}

function encodeCursor(updatedAt: number, id: string): string {
	return btoa(`${updatedAt}.${id}`).replace(/=+$/, "");
}

function decodeCursor(cursor: string): { updatedAt: number; id: string } {
	let decoded: string;
	try {
		decoded = atob(cursor);
	} catch {
		decoded = "";
	}
	const match = /^(\d+)\.([a-z0-9-]{1,47})$/.exec(decoded);
	if (!match) throw new PageError(400, "cursor isn't one list_pages returned; give the nextCursor from the previous call, or omit it to start from the newest page");
	return { updatedAt: Number(match[1]), id: match[2]! };
}

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/**
 * Checks a visibility and password as agents give them. A password alone
 * implies private; a public page can't have one.
 */
async function privacy(visibility: unknown, password: unknown): Promise<{ visibility: Visibility; passwordHash: string | null }> {
	if (password !== undefined && password !== null && typeof password !== "string") throw new PageError(400, "password must be a string");
	const chosen = visibility ?? (password ? "private" : "public");
	if (chosen !== "public" && chosen !== "private") throw new PageError(400, 'visibility must be "public" or "private"');
	if (password) {
		if (chosen === "public") throw new PageError(400, "Only private pages can have a password");
		if (password.length < 8 || password.length > 200) throw new PageError(400, "A password must be 8 to 200 characters");
	}
	return { visibility: chosen, passwordHash: password ? await hashPassword(password) : null };
}

/** A TTL as an agent gives it, unchecked until `parseTtl`. */
export type TtlInput = unknown;

/** A page as callers send it: every field is checked here, whatever its type. */
export interface PublishInput {
	content: Content;
	ttl?: TtlInput;
	label?: unknown;
	agent?: unknown;
	/** Words for the page's id, which becomes `<slug>-<random>`. */
	slug?: unknown;
	/** Checked by `privacy`. */
	visibility?: unknown;
	password?: unknown;
}

/** A short text field as callers send it: a string, or null or missing for none. */
function optionalText(value: unknown, name: string): string | null | undefined {
	if (value !== undefined && value !== null && typeof value !== "string") throw new PageError(400, `${name} must be a string`);
	return value;
}

const UPLOAD_WINDOW = 60 * 60 * 1000;

/** What a page shows until its first upload arrives. */
const WAITING = `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="3">
<title>Waiting for upload</title>
<p style="font: 16px system-ui, sans-serif; margin: 2rem; color: #888">Waiting for the files to be uploaded…</p>
`;

/** Everything live, as the owner sees it on the dashboard: whole `Page`s, password hashes included, so never for agents. */
export interface Overview {
	pages: Page[];
	usage: Usage;
	/** Mockup sets' options, by page id. */
	options: Map<string, MockupOption[]>;
	/** Kept versions, by page id. */
	versions: Map<string, Version[]>;
}

/**
 * What can be done with pages, whichever way it's asked for: the HTTP API,
 * MCP, or the dashboard. Each of those is transport only, so a rule added
 * here holds for all three. Takes input as callers send it and returns what
 * agents should see back; failures are thrown as `PageError`s.
 */
export class Operations {
	constructor(
		private readonly pages: Pages,
		private readonly host: string,
		/** Signs upload URLs. */
		private readonly secret: string,
		private readonly now: () => number = Date.now,
	) {}

	/** Publishes a permanent mockup set, its id made from `project` and `name`. Its content is inline files or a zip. */
	async publishMockup(input: { project?: unknown; name?: unknown; content: Content; agent?: unknown; visibility?: unknown; password?: unknown }) {
		if (typeof input.project !== "string" || typeof input.name !== "string") throw new PageError(400, "A mockup set needs a project and a name");
		if (!hasFiles(input.content)) throw new PageError(400, "A mockup set needs files: one top-level folder per option (a/index.html, b/index.html, ...), or a zip of them");
		const files = decodeContent(input.content, null, "mockup");
		const page = await this.pages.publish({
			files,
			ttl: "permanent",
			label: input.name,
			agent: optionalString(input.agent, "agent"),
			mockup: { project: input.project, name: input.name },
			...(await privacy(input.visibility, input.password)),
		});
		return { ...setView(page, this.host, await this.pages.options(page.id)), warnings: rootRelativeWarnings(files) };
	}

	/** Picks, rejects or resets an option of a mockup set. Without a verdict, changes just the note. */
	async setVerdict(id: string, option: unknown, verdict: unknown, note: unknown) {
		if (typeof option !== "string") throw new PageError(400, "option must be the name of one of the set's top-level folders");
		if (verdict === undefined || verdict === null) {
			if (note === undefined) throw new PageError(400, `Give a verdict (${VERDICTS.map((v) => `"${v}"`).join(", ")}), a note, or both`);
		} else if (!VERDICTS.includes(verdict as Verdict)) throw new PageError(400, `verdict must be one of ${VERDICTS.map((v) => `"${v}"`).join(", ")}`);
		if (note !== undefined && note !== null && typeof note !== "string") throw new PageError(400, "note must be a string, or null to clear it");
		const options = await this.pages.setVerdict(id, option, (verdict ?? undefined) as Verdict | undefined, note as string | null | undefined);
		return { id, url: pageUrl(this.host, id), options: optionsView(options) };
	}

	/** Publishes a page. A `label` titles a Markdown page. */
	async publish(input: PublishInput) {
		const label = optionalText(input.label, "label");
		const agent = optionalText(input.agent, "agent");
		const ttl = parseTtl(input.ttl);
		const slugText = optionalString(input.slug, "slug");
		const slug = slugText === undefined ? undefined : slugify(slugText);
		if (slug === "") throw new PageError(400, 'slug needs some letters or digits, e.g. "q3-report"');
		const files = decodeContent(input.content, label);
		const page = await this.pages.publish({
			files,
			ttl,
			label,
			agent,
			slug,
			...(await privacy(input.visibility, input.password)),
		});
		return { ...pageView(page, this.host), warnings: rootRelativeWarnings(files) };
	}

	/** Replaces a page's files; the URL and expiry stay the same. Markdown is titled by its first heading. */
	async update(id: string, content: Content) {
		return this.replace(id, content);
	}

	/**
	 * `update`, through an upload URL minted when the page's latest version was
	 * `latestVersion`. Refused once any update has happened since, the first
	 * upload through the URL included, so each URL works once.
	 */
	async upload(id: string, latestVersion: number, content: Content) {
		try {
			return await this.replace(id, content, latestVersion);
		} catch (error) {
			if (error instanceof PageError && error.status === 409) throw new PageError(403, "This upload URL has already been used, or the page has changed since; ask for a new one");
			throw error;
		}
	}

	private async replace(id: string, content: Content, ifLatest?: number) {
		const files = content.zip ? await this.unzipFor(id, content) : decodeContent(content);
		const page = await this.pages.update(id, files, { ifLatest });
		return { ...(await this.view(page)), warnings: rootRelativeWarnings(files) };
	}

	/** Adds or replaces inline `files` and deletes the paths in `remove`, keeping the rest. */
	async patch(id: string, input: { files?: unknown; remove?: unknown }) {
		const remove = input.remove ?? [];
		if (!(Array.isArray(remove) && remove.every((path) => typeof path === "string"))) throw new PageError(400, "remove must be an array of paths");
		const files = input.files === undefined || input.files === null ? [] : decodeFiles(input.files);
		if (!files.length && !remove.length) throw new PageError(400, "Nothing to change: give files to add or replace, or paths to remove");
		const page = await this.pages.patch(id, { files, remove });
		return { ...(await this.view(page)), warnings: rootRelativeWarnings(files) };
	}

	/**
	 * An upload URL that replaces the files of page `id` with a zip, once,
	 * within an hour. Without `id`, publishes a placeholder page first, so the agent
	 * gets the final URL before uploading. The placeholder expires with the
	 * URL; its first new version, however it arrives, gives the page the
	 * `ttl` asked for (see `Pages.publish`).
	 */
	async uploadUrl(input: { id?: unknown; ttl?: TtlInput; label?: unknown; agent?: unknown; visibility?: unknown; password?: unknown }) {
		const id = optionalText(input.id, "id");
		const page = id
			? await this.pages.get(id)
			: await this.pages.publish({
					files: [{ path: "index.html", body: new TextEncoder().encode(WAITING) }],
					ttl: UPLOAD_WINDOW,
					pendingTtl: parseTtl(input.ttl),
					label: optionalText(input.label, "label"),
					agent: optionalText(input.agent, "agent"),
					...(await privacy(input.visibility, input.password)),
				});
		// A placeholder and its upload URL expire together.
		const expiresAt = id ? this.now() + UPLOAD_WINDOW : page.expiresAt!;
		const uploadUrl = `https://${this.host}/upload/${await uploadToken(this.secret, page.id, page.latestVersion, expiresAt)}`;
		return {
			...pageView(page, this.host),
			uploadUrl,
			uploadExpiresAt: isoTime(expiresAt),
			// Dotfiles (.env, .git) stay out: they're rarely part of a page and often secret.
			command: `(cd <folder> && zip -qr - . -x '.*' '*/.*') | curl -fsS -X PUT -H "content-type: application/zip" --data-binary @- "${uploadUrl}"`,
		};
	}

	/** Decodes a zip that replaces page `id`'s files, as a mockup set's when it is one, knowing its options. */
	private async unzipFor(id: string, content: Content) {
		const page = await this.pages.get(id);
		if (page.kind !== "mockup") return decodeContent(content);
		return decodeContent(content, null, "mockup", (await this.pages.options(id)).filter((option) => option.path).map((option) => option.name));
	}

	/**
	 * Makes a page public or private, revoking every link handed out so far. A
	 * private page keeps its password when `password` is undefined; null or ""
	 * clears it, and a string replaces it. A public page has none.
	 */
	async setVisibility(id: string, visibility: unknown, password: unknown) {
		const chosen = await privacy(visibility, password);
		const hash = password === undefined && chosen.visibility === "private" ? undefined : chosen.passwordHash;
		return pageView(await this.pages.setVisibility(id, chosen.visibility, hash), this.host);
	}

	/** A link that opens a private page without signing in, until it expires (`LIMITS.temporaryTtl` by default). A public page's link is just its URL. */
	async shareLink(id: string, ttl: TtlInput) {
		const page = await this.pages.get(id);
		if (page.visibility === "public") return { id, url: pageUrl(this.host, id), expiresAt: isoTime(page.expiresAt) };
		const ms = ttlOmitted(ttl) ? LIMITS.temporaryTtl : parseTtl(ttl);
		if (ms === "permanent") throw new PageError(400, `A share link lasts at most ${LIMITS.maxTtl / 86_400_000} days`);
		const now = this.now();
		return { id, url: await viewerUrl(this.secret, this.host, page, now, { ttl: ms }), expiresAt: isoTime(now + ms) };
	}

	async setLabel(id: string, label: unknown) {
		if (label !== null && typeof label !== "string") throw new PageError(400, "label must be a string, or null to clear it");
		return pageView(await this.pages.setLabel(id, label), this.host);
	}

	/**
	 * Renames a page and changes its expiry, either or both. A label that's
	 * given (null clears it) renames; a ttl that's given extends, or with
	 * "permanent" stops it expiring. Both are checked before either is
	 * written, so a bad one changes nothing.
	 */
	async edit(id: string, changes: { label?: unknown; ttl?: TtlInput }) {
		const renaming = "label" in changes;
		const extending = !ttlOmitted(changes.ttl);
		if (!renaming) return this.extend(id, changes.ttl);
		if (changes.label !== null && typeof changes.label !== "string") throw new PageError(400, "label must be a string, or null to clear it");
		if (extending) parseTtl(changes.ttl);
		await this.pages.setLabel(id, changes.label);
		return extending ? this.extend(id, changes.ttl) : this.get(id);
	}

	async extend(id: string, ttl: TtlInput) {
		if (ttlOmitted(ttl)) throw new PageError(400, 'ttl is required: a duration like "2h" or "7d", or "permanent"');
		return pageView(await this.pages.extend(id, parseTtl(ttl)), this.host);
	}

	/** Makes a permanent page temporary, expiring `LIMITS.temporaryTtl` from now. A temporary page stays as it is. */
	async makeTemporary(id: string) {
		const page = await this.pages.get(id);
		return pageView(page.permanent ? await this.pages.extend(id, LIMITS.temporaryTtl) : page, this.host);
	}

	async delete(id: string) {
		await this.pages.delete(id);
		return { id, deleted: true };
	}

	async versions(id: string) {
		return { id, versions: (await this.pages.versions(id)).map(versionView) };
	}

	/**
	 * A kept version of a live page: `version`, or the one it serves. Throws
	 * with the versions it does keep, so the caller can pick one.
	 */
	private async keptVersion(id: string, version: number | undefined): Promise<{ page: Page; versions: Version[]; version: number }> {
		const page = await this.pages.get(id);
		const versions = await this.pages.versions(id);
		const chosen = version ?? page.version;
		if (!versions.some((kept) => kept.version === chosen)) {
			throw new PageError(404, `Page ${id} has no version ${chosen}; it keeps ${versions.map((kept) => kept.version).join(", ")}`);
		}
		return { page, versions, version: chosen };
	}

	/**
	 * One file of a page, from the version it serves or a kept `version`:
	 * text as text, anything else as base64. Files over `READ_LIMIT` are
	 * refused, pointing at the zip route.
	 */
	async readFile(id: string, path: unknown, version?: unknown) {
		if (typeof path !== "string" || !path.trim()) throw new PageError(400, 'path is required: a file\'s path inside the page, e.g. "index.html"; get_page lists them');
		const kept = await this.keptVersion(id, optionalVersion(version));
		const ref = { id, version: kept.version };
		const wanted = normalizePath(path);
		const manifest = await this.pages.files.manifest(ref);
		const file = manifest.get(wanted);
		if (!file) {
			const paths = [...manifest.keys()].sort();
			const shown = paths.slice(0, 20).map((p) => `"${p}"`).join(", ");
			throw new PageError(404, `Version ${kept.version} of page ${id} has no file "${wanted}"; its files are ${shown}${paths.length > 20 ? `, and ${paths.length - 20} more (get_page lists them all)` : ""}`);
		}
		if (file.size > READ_LIMIT) {
			throw new PageError(413, `"${wanted}" is ${bytesText(file.size)}, more than the ${bytesText(READ_LIMIT)} read_file returns. Download the version as a zip instead: GET https://${this.host}/api/pages/${id}/zip?version=${kept.version} with the bearer token`);
		}
		const body = await this.pages.files.read(ref, wanted);
		if (!body) throw new PageError(409, `"${wanted}" vanished while it was being read; try again`);
		const bytes = new Uint8Array(await new Response(body).arrayBuffer());
		const type = contentType(wanted);
		let text: string | null = null;
		if (TEXTUAL.test(type)) {
			try {
				text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
			} catch {
				text = null;
			}
		}
		return {
			id,
			version: kept.version,
			path: wanted,
			size: file.size,
			contentType: type,
			encoding: text === null ? "base64" : "utf8",
			content: text ?? base64(bytes),
		};
	}

	/**
	 * Which files differ between two kept versions, by comparing stored
	 * ETags rather than reading the files. `to` defaults to the version
	 * being served, and `from` to the kept version just before `to`.
	 */
	async diff(id: string, from?: unknown, to?: unknown) {
		const target = await this.keptVersion(id, optionalVersion(to, "to"));
		let base = optionalVersion(from, "from");
		if (base === undefined) {
			const older = target.versions.filter((kept) => kept.version < target.version);
			if (!older.length) throw new PageError(400, `Page ${id} keeps no version older than ${target.version} to compare it with; give from, one of ${target.versions.map((kept) => kept.version).join(", ")}`);
			base = Math.max(...older.map((kept) => kept.version));
		} else if (!target.versions.some((kept) => kept.version === base)) {
			throw new PageError(404, `Page ${id} has no version ${base}; it keeps ${target.versions.map((kept) => kept.version).join(", ")}`);
		}
		const [before, after] = await Promise.all([this.pages.files.manifest({ id, version: base }), this.pages.files.manifest({ id, version: target.version })]);
		const added: string[] = [];
		const changed: string[] = [];
		let unchanged = 0;
		for (const [path, file] of after) {
			const old = before.get(path);
			if (!old) added.push(path);
			else if (old.etag !== file.etag || old.size !== file.size) changed.push(path);
			else unchanged += 1;
		}
		const removed = [...before.keys()].filter((path) => !after.has(path));
		return { id, from: base, to: target.version, added: added.sort(), removed: removed.sort(), changed: changed.sort(), unchanged };
	}

	/**
	 * A kept version (or the one being served) as a zip, streamed: files are
	 * read from R2 one at a time and written out as they're compressed, so a
	 * 50 MB page never sits in memory whole.
	 */
	async zip(id: string, version?: unknown): Promise<{ filename: string; body: ReadableStream<Uint8Array> }> {
		const kept = await this.keptVersion(id, optionalVersion(version));
		const ref = { id, version: kept.version };
		const paths = [...(await this.pages.files.manifest(ref)).keys()].sort();
		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		const writer = writable.getWriter();
		const fail = (error: unknown) => writer.abort(error).catch(() => {});
		const archive = new Zip((error, chunk, final) => {
			if (error) return void fail(error);
			writer.write(chunk).catch(() => {});
			if (final) writer.close().catch(() => {});
		});
		const files = this.pages.files;
		void (async () => {
			for (const path of paths) {
				const entry = STORE_IN_ZIP.test(contentType(path)) ? new ZipPassThrough(path) : new ZipDeflate(path, { level: 6 });
				archive.add(entry);
				const body = await files.read(ref, path);
				if (!body) throw new Error(`${path} vanished while zipping`);
				const reader = body.getReader();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					entry.push(value);
					// Wait for the client to take what's written before reading more.
					await writer.ready;
				}
				entry.push(new Uint8Array(0), true);
			}
			archive.end();
		})().catch(fail);
		return { filename: `${id}-v${kept.version}.zip`, body: readable };
	}

	async rollback(id: string, version: unknown) {
		if (typeof version !== "number" || !Number.isInteger(version)) throw new PageError(400, "version must be a whole number; list_versions shows the ones a page keeps");
		return this.view(await this.pages.rollback(id, version));
	}

	/** A page with its files' paths and sizes, and a mockup set's options. */
	async get(id: string) {
		const page = await this.pages.get(id);
		const [view, manifest] = await Promise.all([this.view(page), this.pages.files.manifest(page)]);
		const files = [...manifest].map(([path, file]) => ({ path, size: file.size })).sort((a, b) => (a.path < b.path ? -1 : 1));
		return { ...view, files };
	}

	/**
	 * Live pages as compact rows, newest-updated first, a page of results at
	 * a time: `nextCursor` (null on the last page) continues the list.
	 * `query` matches a substring of the label or id; `agent`, `kind` and
	 * `project` narrow it.
	 */
	async list(input: ListInput = {}) {
		const text = optionalString(input.query, "query");
		if (text !== undefined && text.length > 200) throw new PageError(400, "query must be 200 characters or fewer");
		const agent = optionalString(input.agent, "agent");
		const kind = optionalString(input.kind, "kind");
		if (kind !== undefined && kind !== "page" && kind !== "mockup") throw new PageError(400, 'kind must be "page" or "mockup"');
		const project = optionalString(input.project, "project");
		// Projects are stored as slugs. One that slugifies to nothing would otherwise drop the filter and match every page.
		if (project !== undefined && project !== "" && !slugify(project)) throw new PageError(400, "project needs at least one letter or digit");
		const cursor = optionalString(input.cursor, "cursor");
		const limitInput = typeof input.limit === "string" && input.limit !== "" ? Number(input.limit) : (input.limit ?? undefined);
		if (limitInput !== undefined && (typeof limitInput !== "number" || !Number.isInteger(limitInput) || limitInput < 1 || limitInput > LIST_LIMITS.max)) {
			throw new PageError(400, `limit must be a whole number from 1 to ${LIST_LIMITS.max}`);
		}
		const limit = (limitInput as number | undefined) ?? LIST_LIMITS.default;
		const [found, usage] = await Promise.all([
			this.pages.search({
				text,
				agent,
				kind: kind as PageKind | undefined,
				project: project === undefined ? undefined : slugify(project),
				limit,
				after: cursor === undefined ? undefined : decodeCursor(cursor),
			}),
			this.pages.usage(),
		]);
		const last = found.pages.at(-1);
		return {
			pages: found.pages.map((page) => rowView(page, this.host)),
			nextCursor: found.more && last ? encodeCursor(last.updatedAt, last.id) : null,
			usage,
		};
	}

	/** Every live page with its options, versions and the usage, read at once. For the dashboard only (see `Overview`). */
	async overview(): Promise<Overview> {
		const [pages, usage, options, versions] = await Promise.all([this.pages.list(), this.pages.usage(), this.pages.allOptions(), this.pages.allVersions()]);
		return { pages, usage, options, versions };
	}

	private async view(page: Page) {
		return setView(page, this.host, page.kind === "mockup" ? await this.pages.options(page.id) : undefined);
	}
}
