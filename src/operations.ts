import { hashPassword, uploadToken } from "./auth.ts";
import { LIMITS, PageError, pageUrl, parseTtl, ttlOmitted } from "./domain.ts";
import { type Content, decodeContent, decodeFiles, hasFiles } from "./files.ts";
import { rootRelativeWarnings } from "./links.ts";
import { type MockupOption, VERDICTS, type Verdict } from "./mockups.ts";
import type { Page, Pages, Usage, Version, Visibility } from "./pages.ts";
import { viewerUrl } from "./privacy.ts";

/** What agents see of a page. */
export function pageView(page: Page, host: string) {
	return {
		id: page.id,
		url: pageUrl(host, page.id),
		label: page.label,
		agent: page.agent,
		createdAt: page.createdAt,
		updatedAt: page.updatedAt,
		expiresAt: page.expiresAt,
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

/** What agents see of a page, with a mockup set's options and verdicts. */
function setView(page: Page, host: string, options: MockupOption[] | undefined) {
	return page.kind === "mockup" ? { ...pageView(page, host), options: options ?? [] } : pageView(page, host);
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

/** A TTL as an agent gives it, before `parseTtl`. */
export type TtlInput = string | number | null | undefined;

export interface PublishInput {
	content: Content;
	ttl?: TtlInput;
	label?: string | null;
	agent?: string | null;
	/** Checked by `privacy`. */
	visibility?: unknown;
	password?: unknown;
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
	async publishMockup(input: { project?: unknown; name?: unknown; content: Content; visibility?: unknown; password?: unknown }) {
		if (typeof input.project !== "string" || typeof input.name !== "string") throw new PageError(400, "A mockup set needs a project and a name");
		if (!hasFiles(input.content)) throw new PageError(400, "A mockup set needs files: one top-level folder per option (a/index.html, b/index.html, ...), or a zip of them");
		const files = decodeContent(input.content);
		const page = await this.pages.publish({
			files,
			ttl: "permanent",
			label: input.name,
			mockup: { project: input.project, name: input.name },
			...(await privacy(input.visibility, input.password)),
		});
		return { ...setView(page, this.host, await this.pages.options(page.id)), warnings: rootRelativeWarnings(files) };
	}

	/** Picks, rejects or resets an option of a mockup set. */
	async setVerdict(id: string, option: unknown, verdict: unknown, note: unknown) {
		if (typeof option !== "string") throw new PageError(400, "option must be the name of one of the set's top-level folders");
		if (!VERDICTS.includes(verdict as Verdict)) throw new PageError(400, `verdict must be one of ${VERDICTS.map((v) => `"${v}"`).join(", ")}`);
		if (note !== undefined && note !== null && typeof note !== "string") throw new PageError(400, "note must be a string, or null to clear it");
		const options = await this.pages.setVerdict(id, option, verdict as Verdict, note as string | null | undefined);
		return { id, url: pageUrl(this.host, id), options };
	}

	/** Publishes a page. A `label` titles a Markdown page. */
	async publish(input: PublishInput) {
		const files = decodeContent(input.content, typeof input.label === "string" ? input.label : null);
		const page = await this.pages.publish({
			files,
			ttl: parseTtl(input.ttl),
			label: input.label,
			agent: input.agent,
			...(await privacy(input.visibility, input.password)),
		});
		return { ...pageView(page, this.host), warnings: rootRelativeWarnings(files) };
	}

	/** Replaces a page's files; the URL and expiry stay the same. Markdown is titled by its first heading. */
	async update(id: string, content: Content) {
		const files = decodeContent(content);
		const page = await this.pages.update(id, files);
		return { ...(await this.view(page)), warnings: rootRelativeWarnings(files) };
	}

	/** Adds or replaces inline `files` and deletes the paths in `remove`, keeping the rest. */
	async patch(id: string, input: { files?: unknown; remove?: unknown }) {
		const remove = input.remove ?? [];
		if (!(Array.isArray(remove) && remove.every((path) => typeof path === "string"))) throw new PageError(400, "remove must be an array of paths");
		const files = input.files === undefined || input.files === null ? [] : decodeFiles(input.files);
		const page = await this.pages.patch(id, { files, remove });
		return { ...(await this.view(page)), warnings: rootRelativeWarnings(files) };
	}

	/**
	 * An upload URL that replaces the files of page `id` with a zip, for an
	 * hour. Without `id`, publishes a placeholder page first, so the agent
	 * gets the final URL before uploading.
	 */
	async uploadUrl(input: { id?: string | null; ttl?: TtlInput; label?: string | null; agent?: string | null; visibility?: unknown; password?: unknown }) {
		const page = input.id
			? await this.pages.get(input.id)
			: await this.pages.publish({
					files: [{ path: "index.html", body: new TextEncoder().encode(WAITING) }],
					ttl: parseTtl(input.ttl),
					label: input.label,
					agent: input.agent,
					...(await privacy(input.visibility, input.password)),
				});
		const expiresAt = this.now() + UPLOAD_WINDOW;
		const uploadUrl = `https://${this.host}/upload/${await uploadToken(this.secret, page.id, expiresAt)}`;
		return {
			...pageView(page, this.host),
			uploadUrl,
			uploadExpiresAt: expiresAt,
			command: `(cd <folder> && zip -qr - .) | curl -fsS -X PUT -H "content-type: application/zip" --data-binary @- "${uploadUrl}"`,
		};
	}

	/** Makes a page public or private (optionally with a password), revoking every link handed out so far. */
	async setVisibility(id: string, visibility: unknown, password: unknown) {
		const chosen = await privacy(visibility, password);
		return pageView(await this.pages.setVisibility(id, chosen.visibility, chosen.passwordHash), this.host);
	}

	/** A link that opens a private page without signing in, until it expires (`LIMITS.temporaryTtl` by default). A public page's link is just its URL. */
	async shareLink(id: string, ttl: TtlInput) {
		const page = await this.pages.get(id);
		if (page.visibility === "public") return { id, url: pageUrl(this.host, id), expiresAt: page.expiresAt };
		const ms = ttlOmitted(ttl) ? LIMITS.temporaryTtl : parseTtl(ttl);
		if (ms === "permanent") throw new PageError(400, `A share link lasts at most ${LIMITS.maxTtl / 86_400_000} days`);
		const now = this.now();
		return { id, url: await viewerUrl(this.secret, this.host, page, now, { ttl: ms }), expiresAt: now + ms };
	}

	async setLabel(id: string, label: unknown) {
		if (label !== null && typeof label !== "string") throw new PageError(400, "label must be a string, or null to clear it");
		return pageView(await this.pages.setLabel(id, label), this.host);
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
		return { id, versions: await this.pages.versions(id) };
	}

	async rollback(id: string, version: unknown) {
		if (typeof version !== "number" || !Number.isInteger(version)) throw new PageError(400, "version must be a whole number; list_versions shows the ones a page keeps");
		return this.view(await this.pages.rollback(id, version));
	}

	async get(id: string) {
		return this.view(await this.pages.get(id));
	}

	async list() {
		const { pages, usage, options } = await this.overview();
		return { pages: pages.map((page) => setView(page, this.host, options.get(page.id))), usage };
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
