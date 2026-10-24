import { pageUrl, parseTtl } from "./domain.ts";
import type { PageFile } from "./files.ts";
import { rootRelativeWarnings } from "./links.ts";
import type { Page, Pages } from "./pages.ts";

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
	};
}

/** A TTL as an agent gives it, before `parseTtl`. */
export type TtlInput = string | number | null | undefined;

export interface PublishInput {
	files: PageFile[];
	ttl?: TtlInput;
	label?: string | null;
	agent?: string | null;
}

/**
 * What an agent can do with pages, whichever way it calls in (HTTP API or
 * MCP). Takes input as agents send it and returns what they should see back;
 * failures are thrown as `PageError`s.
 */
export class Operations {
	constructor(
		private readonly pages: Pages,
		private readonly host: string,
	) {}

	async publish(input: PublishInput) {
		const page = await this.pages.publish({ files: input.files, ttl: parseTtl(input.ttl), label: input.label, agent: input.agent });
		return { ...pageView(page, this.host), warnings: rootRelativeWarnings(input.files) };
	}

	/** Replaces a page's files; the URL and expiry stay the same. */
	async update(id: string, files: PageFile[]) {
		const page = await this.pages.update(id, files);
		return { ...pageView(page, this.host), warnings: rootRelativeWarnings(files) };
	}

	async extend(id: string, ttl: TtlInput) {
		return pageView(await this.pages.extend(id, parseTtl(ttl)), this.host);
	}

	async delete(id: string) {
		await this.pages.delete(id);
		return { id, deleted: true };
	}

	async get(id: string) {
		return pageView(await this.pages.get(id), this.host);
	}

	async list() {
		const [list, usage] = await Promise.all([this.pages.list(), this.pages.usage()]);
		return { pages: list.map((page) => pageView(page, this.host)), usage };
	}
}
