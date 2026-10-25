import { handleApi, handleUpload } from "./api.ts";
import { checkUploadToken, checkViewPass, hasToken, PASS_PATTERN } from "./auth.ts";
import { cat, rootPage } from "./cat.ts";
import { handleDashboard } from "./dashboard.ts";
import { PageError } from "./domain.ts";
import { normalizePath } from "./files.ts";
import { rewriteLinks } from "./links.ts";
import { favicon } from "./logo.ts";
import { handleMcp } from "./mcp.ts";
import { Operations } from "./operations.ts";
import { ID_PATTERN, Pages } from "./pages.ts";
import { gate, unlock } from "./privacy.ts";

/**
 * Every response from the pages host goes out with these. Agent-written HTML
 * runs in a sandbox with an opaque origin, so it can't read cookies or storage
 * for rcn.sh, or act as p.rcn.sh. Don't add allow-same-origin.
 *
 * That opaque origin is `null`, so a page fetching or importing its own files
 * makes a cross-origin request; the wildcard lets it read the answer. No
 * credentials are involved, so it exposes nothing a plain GET doesn't.
 */
const PAGE_HEADERS: Record<string, string> = {
	"content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
	"access-control-allow-origin": "*",
	"x-robots-tag": "noindex, nofollow",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};

function text(body: string, status: number, headers: HeadersInit = {}): Response {
	return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
}

function withPageHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(PAGE_HEADERS)) headers.set(name, value);
	// Page files say how they may be cached; anything else isn't.
	if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
	headers.delete("set-cookie");
	// A body we compressed ourselves must go out as is.
	const encodeBody = headers.has("content-encoding") ? "manual" : "automatic";
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers, encodeBody });
}

async function servePage(request: Request, env: Env, pages: Pages, id: string, subpath: string): Promise<Response> {
	const found = await pages.lookup(id);
	if (found.state === "gone") return text("This page has expired.\n", 410);
	if (found.state === "missing") return text("Not found\n", 404);
	const page = found.page;
	const url = new URL(request.url);

	// A private page needs a pass as its first path segment: /<id>/~<pass>/<rest>.
	let pass: string | null = null;
	let rest = subpath;
	const [first = "", ...after] = subpath.split("/");
	if (PASS_PATTERN.test(first)) {
		// A pass on a page that has since been made public: drop it.
		if (page.visibility === "public") return new Response(null, { status: 301, headers: { location: `/${id}/${after.join("/")}${url.search}` } });
		if (!(await checkViewPass(env.EPHEMERA_TOKEN, id, page.shareEpoch, first))) {
			return gate(env, page, after.join("/"), "This link has expired or been revoked.");
		}
		if (after.length === 0) return new Response(null, { status: 301, headers: { location: `/${id}/${first}/${url.search}` } });
		pass = first;
		rest = after.join("/");
	} else if (page.visibility === "private") {
		return gate(env, page, subpath);
	}
	const base = pass ? `/${id}/${pass}` : `/${id}`;

	let path: string;
	try {
		const decoded = decodeURIComponent(rest);
		path = normalizePath(rest === "" || rest.endsWith("/") ? `${decoded}index.html` : decoded);
	} catch {
		return text("Not found\n", 404);
	}

	const object = await pages.file(page, path, request.headers);
	if (!object && !rest.endsWith("/") && rest !== "" && (await pages.hasFile(page, `${path}/index.html`))) {
		// A folder without its trailing slash: redirect so relative links inside it resolve.
		return new Response(null, { status: 301, headers: { location: `${base}/${rest}/${url.search}` } });
	}
	if (!object) return text("Not found\n", 404);

	// no-cache, not no-store: the browser keeps files but asks each time, so an
	// update shows on refresh while unchanged files come back as 304s.
	// no-transform stops Cloudflare editing pages (injected scripts, Rocket
	// Loader), which would also strip the ETag; so we compress text ourselves.
	const headers = new Headers({
		"content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
		etag: object.httpEtag,
		"cache-control": pass ? "private, no-cache, no-transform" : "no-cache, no-transform",
	});
	if (!("body" in object)) return new Response(null, { status: 304, headers });
	if (request.method === "HEAD") return new Response(null, { headers });
	const response = new Response(object.body, { headers });
	return gzip(request, headers.get("content-type")!.startsWith("text/html") ? rewriteLinks(response, id, pass) : response);
}

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|wasm|manifest\+json)|image\/svg\+xml)/;

function gzip(request: Request, response: Response): Response {
	if (!response.body || !COMPRESSIBLE.test(response.headers.get("content-type") ?? "")) return response;
	const headers = new Headers(response.headers);
	headers.append("vary", "accept-encoding");
	if (!/\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")) return new Response(response.body, { headers });
	headers.set("content-encoding", "gzip");
	return new Response(response.body.pipeThrough(new CompressionStream("gzip")), { headers, encodeBody: "manual" });
}

/** Routes for agents: they need the token (or an upload URL), and get errors back as JSON. */
async function handleAgent(request: Request, env: Env, ctx: ExecutionContext, pages: Pages, pathname: string): Promise<Response> {
	const ops = new Operations(pages, env.PAGES_HOST, env.EPHEMERA_TOKEN);
	try {
		if (pathname.startsWith("/upload/")) {
			const id = await checkUploadToken(env.EPHEMERA_TOKEN, pathname.slice("/upload/".length));
			if (!id) return Response.json({ error: "This upload URL is wrong or has expired; ask for a new one" }, { status: 403 });
			return await handleUpload(request, ops, id);
		}
		if (!(await hasToken(request, env.EPHEMERA_TOKEN))) return Response.json({ error: "Missing or wrong bearer token" }, { status: 401 });
		return pathname === "/mcp" ? await handleMcp(request, env, ctx, ops) : await handleApi(request, ops);
	} catch (error) {
		if (error instanceof PageError) return Response.json({ error: error.message }, { status: error.status });
		throw error;
	}
}

async function handlePagesHost(request: Request, env: Env, ctx: ExecutionContext, pages: Pages): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (pathname === "/api" || pathname.startsWith("/api/") || pathname === "/mcp" || pathname.startsWith("/upload/")) {
		return handleAgent(request, env, ctx, pages, pathname);
	}
	const unlocking = /^\/([a-z2-7]{12})\/_unlock$/.exec(pathname);
	if (unlocking && request.method === "POST") return unlock(request, env, pages, unlocking[1]!);
	if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed\n", 405);
	if (pathname === "/") return rootPage();
	if (pathname === "/cat.jpg") return cat();
	if (pathname === "/favicon.svg") return favicon();

	const match = /^\/([^/]+)(\/.*)?$/.exec(pathname);
	if (!match || !ID_PATTERN.test(match[1]!)) return text("Not found\n", 404);
	const [, id, rest] = match as unknown as [string, string, string | undefined];
	if (rest === undefined) {
		return new Response(null, { status: 301, headers: { location: `/${id}/${new URL(request.url).search}` } });
	}
	try {
		return await servePage(request, env, pages, id, rest.slice(1));
	} catch (error) {
		if (error instanceof PageError) return text(`${error.message}\n`, error.status);
		throw error;
	}
}

export default {
	async fetch(request, env, ctx) {
		const { hostname } = new URL(request.url);
		const pages = new Pages(env, { defer: (work) => ctx.waitUntil(work) });
		try {
			if (hostname === env.PAGES_HOST) return withPageHeaders(await handlePagesHost(request, env, ctx, pages));
			if (hostname === env.ADMIN_HOST) return await handleDashboard(request, env, ctx, pages);
			return text("Not found\n", 404);
		} catch (error) {
			// Each host's handler answers PageErrors in its own format; anything left is a bug.
			console.error(error);
			const response = text("Something went wrong\n", 500);
			return hostname === env.PAGES_HOST ? withPageHeaders(response) : response;
		}
	},

	async scheduled(_controller, env, ctx) {
		const result = await new Pages(env, { defer: (work) => ctx.waitUntil(work) }).sweep();
		console.log(`sweep: purged ${result.purged} gone page(s), forgot ${result.forgotten}`);
	},
} satisfies ExportedHandler<Env>;
