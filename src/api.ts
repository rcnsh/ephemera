import { hasToken } from "./auth.ts";
import { decodeInlineFiles, type InlineFile, type PageFile, unzipFiles } from "./files.ts";
import { PageError, parseTtl } from "./limits.ts";
import { rootRelativeWarnings } from "./links.ts";
import type { Page, Pages } from "./pages.ts";

/** What callers see of a page. */
export function pageView(page: Page, host: string) {
	return {
		id: page.id,
		url: `https://${host}/${page.id}/`,
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

export interface PublishInput {
	files: PageFile[];
	ttl?: string | number | null;
	label?: string | null;
	agent?: string | null;
}

export async function publishPage(pages: Pages, host: string, input: PublishInput) {
	const page = await pages.publish({ files: input.files, ttl: parseTtl(input.ttl), label: input.label, agent: input.agent });
	return { ...pageView(page, host), warnings: rootRelativeWarnings(input.files) };
}

export async function updatePage(pages: Pages, host: string, id: string, files: PageFile[], ctx: ExecutionContext) {
	const { page, cleanup } = await pages.update(id, files);
	ctx.waitUntil(cleanup);
	return { ...pageView(page, host), warnings: rootRelativeWarnings(files) };
}

export async function listPages(pages: Pages, host: string) {
	const [list, usage] = await Promise.all([pages.list(), pages.usage()]);
	return { pages: list.map((page) => pageView(page, host)), usage };
}

const MAX_BODY = 40 * 1024 * 1024;

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

/** Reads a bundle from either a JSON body (`files` inline) or a raw zip body (options in the query string). */
async function readBundle(request: Request, url: URL): Promise<PublishInput> {
	if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) throw new PageError(413, "Request body is too large");
	const type = request.headers.get("content-type") ?? "";
	if (/zip|octet-stream/.test(type)) {
		const files = unzipFiles(new Uint8Array(await request.arrayBuffer()));
		const ttl = url.searchParams.get("ttl");
		return { files, ttl: ttl && /^\d+$/.test(ttl) ? Number(ttl) : ttl, label: url.searchParams.get("label"), agent: url.searchParams.get("agent") };
	}
	let body: { files?: InlineFile[]; ttl?: string | number; label?: string; agent?: string };
	try {
		body = await request.json();
	} catch {
		throw new PageError(400, "Body must be JSON ({ files, ttl, label, agent }) or a zip file");
	}
	if (!Array.isArray(body.files)) throw new PageError(400, "files must be an array of { path, content, encoding }");
	return { files: decodeInlineFiles(body.files), ttl: body.ttl, label: body.label, agent: body.agent };
}

/**
 * The HTTP API under /api:
 *   GET    /api/pages        list live pages and usage
 *   POST   /api/pages        publish (JSON or zip)
 *   GET    /api/pages/:id    one page
 *   PUT    /api/pages/:id    replace its files (JSON or zip)
 *   PATCH  /api/pages/:id    { ttl }: extend, or "permanent"
 *   DELETE /api/pages/:id    delete now
 */
export async function handleApi(request: Request, env: Env, ctx: ExecutionContext, pages: Pages): Promise<Response> {
	if (!(await hasToken(request, env.EPHEMERA_TOKEN))) {
		return json({ error: "Missing or wrong bearer token" }, 401);
	}
	const url = new URL(request.url);
	const host = env.PAGES_HOST;
	const match = /^\/api\/pages(?:\/([^/]+))?\/?$/.exec(url.pathname);
	if (!match) return json({ error: "Not found" }, 404);
	const id = match[1];
	try {
		if (!id) {
			if (request.method === "GET") return json(await listPages(pages, host));
			if (request.method === "POST") return json(await publishPage(pages, host, await readBundle(request, url)), 201);
		} else {
			switch (request.method) {
				case "GET":
					return json(pageView(await pages.get(id), host));
				case "PUT":
					return json(await updatePage(pages, host, id, (await readBundle(request, url)).files, ctx));
				case "PATCH": {
					const body = (await request.json().catch(() => ({}))) as { ttl?: string | number };
					return json(pageView(await pages.extend(id, parseTtl(body.ttl)), host));
				}
				case "DELETE":
					await pages.delete(id);
					return json({ id, deleted: true });
			}
		}
		return json({ error: "Method not allowed" }, 405);
	} catch (error) {
		if (error instanceof PageError) return json({ error: error.message }, error.status);
		throw error;
	}
}
