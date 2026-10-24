import { hashPassword, uploadToken } from "./auth.ts";
import { LIMITS, PageError, pageUrl, parseTtl } from "./domain.ts";
import type { PageFile } from "./files.ts";
import { rootRelativeWarnings } from "./links.ts";
import type { Page, Pages, Visibility } from "./pages.ts";
import { passFor, passUrl } from "./privacy.ts";

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
	};
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
	files: PageFile[];
	ttl?: TtlInput;
	label?: string | null;
	agent?: string | null;
	/** Checked by `privacy`. */
	visibility?: unknown;
	password?: unknown;
}

/**
 * What an agent can do with pages, whichever way it calls in (HTTP API or
 * MCP). Takes input as agents send it and returns what they should see back;
 * failures are thrown as `PageError`s.
 */
const UPLOAD_WINDOW = 60 * 60 * 1000;

/** What a page shows until its first upload arrives. */
const WAITING = `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="3">
<title>Waiting for upload</title>
<p style="font: 16px system-ui, sans-serif; margin: 2rem; color: #888">Waiting for the files to be uploaded…</p>
`;

export class Operations {
	constructor(
		private readonly pages: Pages,
		private readonly host: string,
		/** Signs upload URLs. */
		private readonly secret: string,
		private readonly now: () => number = Date.now,
	) {}

	async publish(input: PublishInput) {
		const page = await this.pages.publish({
			files: input.files,
			ttl: parseTtl(input.ttl),
			label: input.label,
			agent: input.agent,
			...(await privacy(input.visibility, input.password)),
		});
		return { ...pageView(page, this.host), warnings: rootRelativeWarnings(input.files) };
	}

	/** Replaces a page's files; the URL and expiry stay the same. */
	async update(id: string, files: PageFile[]) {
		const page = await this.pages.update(id, files);
		return { ...pageView(page, this.host), warnings: rootRelativeWarnings(files) };
	}

	/** Adds, replaces and removes single files, keeping the rest. */
	async patch(id: string, files: PageFile[], remove: string[]) {
		const page = await this.pages.patch(id, { files, remove });
		return { ...pageView(page, this.host), warnings: rootRelativeWarnings(files) };
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

	/** A link that opens a private page without signing in, until it expires (a day by default). A public page's link is just its URL. */
	async shareLink(id: string, ttl: TtlInput) {
		const page = await this.pages.get(id);
		if (page.visibility === "public") return { id, url: pageUrl(this.host, id), expiresAt: page.expiresAt };
		const ms = parseTtl(ttl);
		if (ms === "permanent") throw new PageError(400, `A share link lasts at most ${LIMITS.maxTtl / 86_400_000} days`);
		const now = this.now();
		return { id, url: passUrl(this.host, id, await passFor(this.secret, page, now, ms)), expiresAt: now + ms };
	}

	async extend(id: string, ttl: TtlInput) {
		return pageView(await this.pages.extend(id, parseTtl(ttl)), this.host);
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
		return pageView(await this.pages.rollback(id, version), this.host);
	}

	async get(id: string) {
		return pageView(await this.pages.get(id), this.host);
	}

	async list() {
		const [list, usage] = await Promise.all([this.pages.list(), this.pages.usage()]);
		return { pages: list.map((page) => pageView(page, this.host)), usage };
	}
}
