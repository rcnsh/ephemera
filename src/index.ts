import { handleApi } from "./api.ts";
import { hasToken } from "./auth.ts";
import { cat, rootPage } from "./cat.ts";
import { handleDashboard } from "./dashboard.ts";
import { normalizePath } from "./files.ts";
import { PageError } from "./limits.ts";
import { rewriteLinks } from "./links.ts";
import { handleMcp } from "./mcp.ts";
import { ID_PATTERN, Pages } from "./pages.ts";

/**
 * Every response from the pages host goes out with these. Agent-written HTML
 * runs in a sandbox with an opaque origin, so it can't read cookies or storage
 * for rcn.sh, or act as p.rcn.sh. Don't add allow-same-origin.
 */
const PAGE_HEADERS: Record<string, string> = {
	"content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
	"x-robots-tag": "noindex, nofollow",
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};

function text(body: string, status: number, headers: HeadersInit = {}): Response {
	return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
}

function withPageHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(PAGE_HEADERS)) headers.set(name, value);
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

	let object = await pages.file(page, path);
	if (!object && !rest.endsWith("/") && rest !== "" && (await pages.hasFile(page, `${path}/index.html`))) {
		// A folder without its trailing slash: redirect so relative links inside it resolve.
		return new Response(null, { status: 301, headers: { location: `/${id}/${rest}/${url.search}` } });
	}
	if (!object) return text("Not found\n", 404);

	const headers = new Headers({ "content-type": object.httpMetadata?.contentType ?? "application/octet-stream", etag: object.httpEtag });
	if (request.method === "HEAD") return new Response(null, { headers });
	const response = new Response(object.body, { headers });
	return headers.get("content-type")!.startsWith("text/html") ? rewriteLinks(response, id) : response;
}

async function handlePagesHost(request: Request, env: Env, ctx: ExecutionContext, pages: Pages): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (pathname === "/api" || pathname.startsWith("/api/")) return handleApi(request, env, ctx, pages);
	if (pathname === "/mcp") {
		if (!(await hasToken(request, env.EPHEMERA_TOKEN))) return Response.json({ error: "Missing or wrong bearer token" }, { status: 401 });
		return handleMcp(request, env, ctx, pages);
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
	return servePage(request, pages, id, rest.slice(1));
}

export default {
	async fetch(request, env, ctx) {
		const { hostname } = new URL(request.url);
		const pages = new Pages(env);
		try {
			if (hostname === env.PAGES_HOST) return withPageHeaders(await handlePagesHost(request, env, ctx, pages));
			if (hostname === env.ADMIN_HOST) return await handleDashboard(request, env, ctx, pages);
			return text("Not found\n", 404);
		} catch (error) {
			if (error instanceof PageError) return withPageHeaders(text(`${error.message}\n`, error.status));
			console.error(error);
			const response = text("Something went wrong\n", 500);
			return hostname === env.PAGES_HOST ? withPageHeaders(response) : response;
		}
	},

	async scheduled(_controller, env) {
		const result = await new Pages(env).sweep();
		console.log(`sweep: purged ${result.purged} gone page(s), forgot ${result.forgotten}`);
	},
} satisfies ExportedHandler<Env>;
