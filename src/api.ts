import { PageError } from "./domain.ts";
import { decodeInlineFiles, type InlineFile, unzipFiles } from "./files.ts";
import type { Operations, PublishInput, TtlInput } from "./operations.ts";

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
 * The HTTP API under /api. The caller has already checked the token, and
 * turns thrown `PageError`s into JSON errors.
 *   GET    /api/pages        list live pages and usage
 *   POST   /api/pages        publish (JSON or zip)
 *   GET    /api/pages/:id    one page
 *   PUT    /api/pages/:id    replace its files (JSON or zip)
 *   PATCH  /api/pages/:id    { ttl }: extend, or "permanent"
 *   DELETE /api/pages/:id    delete now
 *   GET    /api/pages/:id/versions   the versions it keeps
 *   POST   /api/pages/:id/rollback   { version }: serve that version again
 */
export async function handleApi(request: Request, ops: Operations): Promise<Response> {
	const url = new URL(request.url);
	const match = /^\/api\/pages(?:\/([^/]+)(?:\/(versions|rollback))?)?\/?$/.exec(url.pathname);
	if (!match) return json({ error: "Not found" }, 404);
	const [, id, sub] = match;
	if (id && sub) {
		if (sub === "versions" && request.method === "GET") return json(await ops.versions(id));
		if (sub === "rollback" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as { version?: unknown };
			return json(await ops.rollback(id, body.version));
		}
	} else if (!id) {
		if (request.method === "GET") return json(await ops.list());
		if (request.method === "POST") return json(await ops.publish(await readBundle(request, url)), 201);
	} else {
		switch (request.method) {
			case "GET":
				return json(await ops.get(id));
			case "PUT":
				return json(await ops.update(id, (await readBundle(request, url)).files));
			case "PATCH": {
				const body = (await request.json().catch(() => ({}))) as { ttl?: TtlInput };
				return json(await ops.extend(id, body.ttl));
			}
			case "DELETE":
				return json(await ops.delete(id));
		}
	}
	return json({ error: "Method not allowed" }, 405);
}
