import { handleApi, handleUpload } from "./api.ts";
import { checkUploadToken, hasToken } from "./auth.ts";
import { cat, rootPage } from "./cat.ts";
import { handleDashboard } from "./dashboard.ts";
import { PageError } from "./domain.ts";
import { normalizePath } from "./files.ts";
import { rewriteLinks } from "./links.ts";
import { handleMcp } from "./mcp.ts";
import { Operations } from "./operations.ts";
import { ID_PATTERN, Pages } from "./pages.ts";

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
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function servePage(request: Request, pages: Pages, id: string, rest: string): Promise<Response> {
	const found = await pages.lookup(id);
	if (found.state === "gone") return text("This page has expired.\n", 410);
	if (found.state === "missing") return text("Not found\n", 404);
	const page = found.page;
	const url = new URL(request.url);

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
		return new Response(null, { status: 301, headers: { location: `/${id}/${rest}/${url.search}` } });
	}
	if (!object) return text("Not found\n", 404);

	// no-cache, not no-store: the browser keeps files but asks each time, so an
	// update shows on refresh while unchanged files come back as 304s.
	const headers = new Headers({
		"content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
		etag: object.httpEtag,
		"cache-control": "no-cache",
	});
	if (!("body" in object)) return new Response(null, { status: 304, headers });
	if (request.method === "HEAD") return new Response(null, { headers });
	const response = new Response(object.body, { headers });
	return headers.get("content-type")!.startsWith("text/html") ? rewriteLinks(response, id) : response;
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
	if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed\n", 405);
	if (pathname === "/") return rootPage();
	if (pathname === "/cat.jpg") return cat();

	const match = /^\/([^/]+)(\/.*)?$/.exec(pathname);
	if (!match || !ID_PATTERN.test(match[1]!)) return text("Not found\n", 404);
	const [, id, rest] = match as unknown as [string, string, string | undefined];
	if (rest === undefined) {
		return new Response(null, { status: 301, headers: { location: `/${id}/${new URL(request.url).search}` } });
	}
	try {
		return await servePage(request, pages, id, rest.slice(1));
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
