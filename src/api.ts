import { PageError } from "./domain.ts";
import { type BundleInput, bundleFrom, type InlineFile, unzipFiles } from "./files.ts";
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
		// No password here: query strings end up in logs. Set one with /visibility afterwards.
		const query = (name: string) => url.searchParams.get(name) ?? undefined;
		return { files, ttl: ttl && /^\d+$/.test(ttl) ? Number(ttl) : ttl, label: query("label"), agent: query("agent"), visibility: query("visibility") };
	}
	let body: BundleInput & { ttl?: string | number; label?: string; agent?: string; visibility?: unknown; password?: unknown };
	try {
		body = await request.json();
	} catch {
		throw new PageError(400, "Body must be JSON ({ files | html | markdown, ttl, label, agent }) or a zip file");
	}
	return { files: bundleFrom(body, body.label), ttl: body.ttl, label: body.label, agent: body.agent, visibility: body.visibility, password: body.password };
}

async function readJson<T>(request: Request): Promise<Partial<T>> {
	return (await request.json().catch(() => ({}))) as Partial<T>;
}

/** PUT /upload/<token>: replaces the files of the page the token is for. The caller has checked the token. */
export async function handleUpload(request: Request, ops: Operations, id: string): Promise<Response> {
	if (request.method !== "PUT" && request.method !== "POST") return json({ error: "Method not allowed; PUT a zip" }, 405);
	return json(await ops.update(id, (await readBundle(request, new URL(request.url))).files));
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
 *   POST   /api/pages/:id/files      { files, remove }: change single files
 *   POST   /api/pages/:id/visibility { visibility, password }: make it public or private
 *   POST   /api/pages/:id/share      { ttl }: a link that opens a private page
 *   POST   /api/uploads              { id?, ttl, label, agent }: an upload URL for a zip
 */
export async function handleApi(request: Request, ops: Operations): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === "/api/uploads" && request.method === "POST") {
		return json(await ops.uploadUrl(await readJson<{ id: string; ttl: TtlInput; label: string; agent: string; visibility: unknown; password: unknown }>(request)), 201);
	}
	const match = /^\/api\/pages(?:\/([^/]+)(?:\/(versions|rollback|files|visibility|share))?)?\/?$/.exec(url.pathname);
	if (!match) return json({ error: "Not found" }, 404);
	const [, id, sub] = match;
	if (id && sub) {
		if (sub === "versions" && request.method === "GET") return json(await ops.versions(id));
		if (sub === "rollback" && request.method === "POST") {
			const body = await readJson<{ version: unknown }>(request);
			return json(await ops.rollback(id, body.version));
		}
		if (sub === "visibility" && request.method === "POST") {
			const body = await readJson<{ visibility: unknown; password: unknown }>(request);
			return json(await ops.setVisibility(id, body.visibility, body.password));
		}
		if (sub === "share" && request.method === "POST") return json(await ops.shareLink(id, (await readJson<{ ttl: TtlInput }>(request)).ttl));
		if (sub === "files" && request.method === "POST") {
			const body = await readJson<{ files: InlineFile[]; remove: string[] }>(request);
			if (body.remove !== undefined && !(Array.isArray(body.remove) && body.remove.every((path) => typeof path === "string"))) {
				throw new PageError(400, "remove must be an array of paths");
			}
			return json(await ops.patch(id, body.files ? bundleFrom({ files: body.files }) : [], body.remove ?? []));
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
			case "PATCH":
				return json(await ops.extend(id, (await readJson<{ ttl: TtlInput }>(request)).ttl));
			case "DELETE":
				return json(await ops.delete(id));
		}
	}
	return json({ error: "Method not allowed" }, 405);
}
