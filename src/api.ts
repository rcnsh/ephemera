import { PageError } from "./domain.ts";
import type { Operations, PublishInput, TtlInput } from "./operations.ts";

const MAX_BODY = 80 * 1024 * 1024;

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

function tooLarge(): PageError {
	return new PageError(413, "Request body is too large");
}

/**
 * The request body, cut off with a 413 once more than `MAX_BODY` bytes have
 * arrived: a chunked body has no content-length to check up front.
 */
function limitedBody(request: Request): ReadableStream<Uint8Array> {
	if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) throw tooLarge();
	let received = 0;
	return (request.body ?? new Response("").body!).pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				received += chunk.byteLength;
				if (received > MAX_BODY) throw tooLarge();
				controller.enqueue(chunk);
			},
		}),
	);
}

/** A JSON body read through `limitedBody`, or null if it isn't JSON. */
async function limitedJson(request: Request): Promise<unknown> {
	try {
		return await new Response(limitedBody(request)).json();
	} catch (error) {
		if (error instanceof PageError) throw error;
		return null;
	}
}

/** A whole body read through `limitedBody`, into one buffer when its length is declared. */
async function limitedBytes(request: Request): Promise<Uint8Array> {
	const declared = Number(request.headers.get("content-length") ?? 0);
	const chunks: Uint8Array[] = [];
	let length = 0;
	let into = declared > 0 ? new Uint8Array(declared) : null;
	for await (const chunk of limitedBody(request)) {
		if (into && length + chunk.byteLength <= into.byteLength) into.set(chunk, length);
		else {
			// Longer than declared, or undeclared: gather the chunks and join them at the end.
			if (into) chunks.push(into.subarray(0, length));
			into = null;
			chunks.push(chunk);
		}
		length += chunk.byteLength;
	}
	if (into) return into.subarray(0, length);
	if (chunks.length === 1) return chunks[0]!;
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) bytes.set(chunk, offset), (offset += chunk.byteLength);
	return bytes;
}

function isZip(request: Request): boolean {
	return /zip|octet-stream/.test(request.headers.get("content-type") ?? "");
}

/** Reads a page from either a JSON body (`files`, `html` or `markdown` inline) or a raw zip body (options in the query string). */
async function readBundle(request: Request, url: URL): Promise<PublishInput> {
	if (isZip(request)) {
		// No password here: query strings end up in logs. Set one with /visibility afterwards.
		const query = (name: string) => url.searchParams.get(name) ?? undefined;
		return { content: { zip: await limitedBytes(request) }, ttl: query("ttl"), label: query("label"), agent: query("agent"), slug: query("slug"), visibility: query("visibility") };
	}
	const body = (await limitedJson(request)) as { files?: unknown; html?: unknown; markdown?: unknown; ttl?: unknown; label?: unknown; agent?: unknown; slug?: unknown; visibility?: unknown; password?: unknown } | null;
	if (typeof body !== "object" || body === null) throw new PageError(400, "Body must be JSON ({ files | html | markdown, ttl, label, agent, slug }) or a zip file");
	const { files, html, markdown, ttl, label, agent, slug, visibility, password } = body;
	return { content: { files, html, markdown }, ttl, label, agent, slug, visibility, password };
}

/** Reads a mockup set from a JSON body, or a zip body with `project` and `name` in the query string. */
async function readMockup(request: Request, url: URL) {
	if (isZip(request)) {
		const { content, agent, visibility } = await readBundle(request, url);
		return { content, agent, visibility, project: url.searchParams.get("project"), name: url.searchParams.get("name") };
	}
	const body = await readJson<{ project: unknown; name: unknown; files: unknown; agent: unknown; visibility: unknown; password: unknown }>(request);
	return { project: body.project, name: body.name, content: { files: body.files }, agent: body.agent, visibility: body.visibility, password: body.password };
}

/** A JSON object body; anything else reads as an empty object, so its fields come out missing. */
async function readJson<T>(request: Request): Promise<Partial<T>> {
	const body: unknown = await limitedJson(request);
	return (typeof body === "object" && body !== null ? body : {}) as Partial<T>;
}

/** PUT /upload/<token>: replaces the files of the page the token is for, once. The caller has checked the token. */
export async function handleUpload(request: Request, ops: Operations, upload: { id: string; latestVersion: number }): Promise<Response> {
	if (request.method !== "PUT" && request.method !== "POST") return json({ error: "Method not allowed; PUT a zip" }, 405);
	return json(await ops.upload(upload.id, upload.latestVersion, (await readBundle(request, new URL(request.url))).content));
}

/**
 * The HTTP API under /api. The caller has already checked the token, and
 * turns thrown `PageError`s into JSON errors.
 *   GET    /api/pages        ?query=&agent=&kind=&project=&limit=&cursor=: live pages, newest first, and usage
 *   POST   /api/pages        publish (JSON or zip)
 *   GET    /api/pages/:id    one page, with its files
 *   PUT    /api/pages/:id    replace its files (JSON or zip)
 *   PATCH  /api/pages/:id    { ttl }: extend, or "permanent"; { label }: rename
 *   DELETE /api/pages/:id    delete now
 *   GET    /api/pages/:id/versions   the versions it keeps
 *   GET    /api/pages/:id/files      ?path=&version=: one file's content
 *   GET    /api/pages/:id/diff       ?from=&to=: files added, removed and changed between versions
 *   GET    /api/pages/:id/zip        ?version=: the files as a zip
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
	const match = /^\/api\/pages(?:\/([^/]+)(?:\/(versions|rollback|files|diff|zip|visibility|share|verdict))?)?\/?$/.exec(url.pathname);
	if (!match) return json({ error: "Not found" }, 404);
	const [, id, sub] = match;
	const query = (name: string) => url.searchParams.get(name) ?? undefined;
	if (id && sub) {
		if (sub === "versions" && request.method === "GET") return json(await ops.versions(id));
		if (sub === "files" && request.method === "GET") return json(await ops.readFile(id, query("path"), query("version")));
		if (sub === "diff" && request.method === "GET") return json(await ops.diff(id, query("from"), query("to")));
		if (sub === "zip" && request.method === "GET") {
			const { filename, body } = await ops.zip(id, query("version"));
			return new Response(body, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${filename}"` } });
		}
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
		if (request.method === "GET") {
			return json(await ops.list({ query: query("query"), agent: query("agent"), kind: query("kind"), project: query("project"), limit: query("limit"), cursor: query("cursor") }));
		}
		if (request.method === "POST") return json(await ops.publish(await readBundle(request, url)), 201);
	} else {
		switch (request.method) {
			case "GET":
				return json(await ops.get(id));
			case "PUT":
				return json(await ops.update(id, (await readBundle(request, url)).content));
			case "PATCH":
				return json(await ops.edit(id, await readJson<{ ttl: TtlInput; label: unknown }>(request)));
			case "DELETE":
				return json(await ops.delete(id));
		}
	}
	return json({ error: "Method not allowed" }, 405);
}
