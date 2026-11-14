import { PageError, parseTtl, ttlOmitted } from "./domain.ts";
import type { Operations, PublishInput, TtlInput } from "./operations.ts";

const MAX_BODY = 80 * 1024 * 1024;

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

function isZip(request: Request): boolean {
	return /zip|octet-stream/.test(request.headers.get("content-type") ?? "");
}

/** Reads a page from either a JSON body (`files`, `html` or `markdown` inline) or a raw zip body (options in the query string). */
async function readBundle(request: Request, url: URL): Promise<PublishInput> {
	if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) throw new PageError(413, "Request body is too large");
	if (isZip(request)) {
		// No password here: query strings end up in logs. Set one with /visibility afterwards.
		const query = (name: string) => url.searchParams.get(name) ?? undefined;
		return { content: { zip: new Uint8Array(await request.arrayBuffer()) }, ttl: query("ttl"), label: query("label"), agent: query("agent"), visibility: query("visibility") };
	}
	const body = (await request.json().catch(() => null)) as { files?: unknown; html?: unknown; markdown?: unknown; ttl?: unknown; label?: unknown; agent?: unknown; visibility?: unknown; password?: unknown } | null;
	if (typeof body !== "object" || body === null) throw new PageError(400, "Body must be JSON ({ files | html | markdown, ttl, label, agent }) or a zip file");
	const { files, html, markdown, ttl, label, agent, visibility, password } = body;
	return { content: { files, html, markdown }, ttl, label, agent, visibility, password };
}

/** Reads a mockup set from a JSON body, or a zip body with `project` and `name` in the query string. */
async function readMockup(request: Request, url: URL) {
	if (isZip(request)) {
		const { content, visibility } = await readBundle(request, url);
		return { content, visibility, project: url.searchParams.get("project"), name: url.searchParams.get("name") };
	}
	const body = await readJson<{ project: unknown; name: unknown; files: unknown; visibility: unknown; password: unknown }>(request);
	return { project: body.project, name: body.name, content: { files: body.files }, visibility: body.visibility, password: body.password };
}

/** A JSON object body; anything else reads as an empty object, so its fields come out missing. */
async function readJson<T>(request: Request): Promise<Partial<T>> {
	const body: unknown = await request.json().catch(() => null);
	return (typeof body === "object" && body !== null ? body : {}) as Partial<T>;
}

/** PUT /upload/<token>: replaces the files of the page the token is for. The caller has checked the token. */
export async function handleUpload(request: Request, ops: Operations, id: string): Promise<Response> {
	if (request.method !== "PUT" && request.method !== "POST") return json({ error: "Method not allowed; PUT a zip" }, 405);
	return json(await ops.update(id, (await readBundle(request, new URL(request.url))).content));
}

/**
 * The HTTP API under /api. The caller has already checked the token, and
 * turns thrown `PageError`s into JSON errors.
 *   GET    /api/pages        list live pages and usage
 *   POST   /api/pages        publish (JSON or zip)
 *   GET    /api/pages/:id    one page
 *   PUT    /api/pages/:id    replace its files (JSON or zip)
 *   PATCH  /api/pages/:id    { ttl }: extend, or "permanent"; { label }: rename
 *   DELETE /api/pages/:id    delete now
 *   GET    /api/pages/:id/versions   the versions it keeps
 *   POST   /api/pages/:id/rollback   { version }: serve that version again
 *   POST   /api/pages/:id/files      { files, remove }: change single files
 *   POST   /api/pages/:id/visibility { visibility, password }: make it public or private
 *   POST   /api/pages/:id/share      { ttl }: a link that opens a private page
 *   POST   /api/pages/:id/verdict    { option, verdict, note }: a verdict on a mockup option
 *   POST   /api/uploads              { id?, ttl, label, agent }: an upload URL for a zip
 *   POST   /api/mockups              publish a mockup set (JSON, or zip with ?project=&name=)
 */
export async function handleApi(request: Request, ops: Operations): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === "/api/uploads" && request.method === "POST") {
		return json(await ops.uploadUrl(await readJson<{ id: unknown; ttl: unknown; label: unknown; agent: unknown; visibility: unknown; password: unknown }>(request)), 201);
	}
	if (url.pathname === "/api/mockups" && request.method === "POST") return json(await ops.publishMockup(await readMockup(request, url)), 201);
	const match = /^\/api\/pages(?:\/([^/]+)(?:\/(versions|rollback|files|visibility|share|verdict))?)?\/?$/.exec(url.pathname);
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
		if (sub === "verdict" && request.method === "POST") {
			const body = await readJson<{ option: unknown; verdict: unknown; note: unknown }>(request);
			return json(await ops.setVerdict(id, body.option, body.verdict, body.note));
		}
		if (sub === "share" && request.method === "POST") return json(await ops.shareLink(id, (await readJson<{ ttl: TtlInput }>(request)).ttl));
		if (sub === "files" && request.method === "POST") return json(await ops.patch(id, await readJson<{ files: unknown; remove: unknown }>(request)));
	} else if (!id) {
		if (request.method === "GET") return json(await ops.list());
		if (request.method === "POST") return json(await ops.publish(await readBundle(request, url)), 201);
	} else {
		switch (request.method) {
			case "GET":
				return json(await ops.get(id));
			case "PUT":
				return json(await ops.update(id, (await readBundle(request, url)).content));
			case "PATCH": {
				const body = await readJson<{ ttl: TtlInput; label: unknown }>(request);
				// A null or empty ttl next to a label means "just rename"; on its own it's an error from extend.
				const ttlGiven = !ttlOmitted(body.ttl);
				if (!ttlGiven && !("label" in body)) return json(await ops.extend(id, body.ttl));
				// Check the ttl before renaming, so a bad one changes nothing.
				if (ttlGiven) parseTtl(body.ttl);
				if ("label" in body) await ops.setLabel(id, body.label);
				if (ttlGiven) return json(await ops.extend(id, body.ttl));
				return json(await ops.get(id));
			}
			case "DELETE":
				return json(await ops.delete(id));
		}
	}
	return json({ error: "Method not allowed" }, 405);
}
