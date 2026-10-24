import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { listPages, pageView, publishPage, updatePage } from "./api.ts";
import { decodeInlineFiles } from "./files.ts";
import { PageError, parseTtl } from "./limits.ts";
import type { Pages } from "./pages.ts";

const files = z
	.array(
		z.object({
			path: z.string().describe('Path inside the page, e.g. "index.html", "css/app.css", "img/chart.png"'),
			content: z.string().describe("File contents: plain text, or base64 when encoding is \"base64\""),
			encoding: z.enum(["utf8", "base64"]).optional().describe('Use "base64" for binary files such as images; defaults to "utf8"'),
		}),
	)
	.min(1)
	.describe("The page's files. There must be an index.html at the root. At most 200 files and 25 MB.");

const ttl = z
	.union([z.string(), z.number()])
	.optional()
	.describe('How long the page lives: a duration like "30m", "2h", "7d" (5 minutes to 30 days) or a number of seconds. Defaults to "24h". "permanent" keeps it until deleted: only use that when the user asks for it.');

const id = z.string().describe("The page id: the 12 characters in its URL, https://p.rcn.sh/<id>/");

const PUBLISH_GUIDE = `Publish a temporary web page at https://p.rcn.sh/<id>/ and get its URL back. It's deleted automatically when its ttl runs out (24 hours by default).

Write links between the page's own files as relative paths ("style.css", "img/a.png", "./data.json"), not root-relative ones ("/style.css"): every page lives under its own /<id>/ folder. Root-relative links in HTML attributes are fixed automatically, but ones inside CSS or JavaScript aren't; the response lists any it found as warnings.

Pages are sandboxed: scripts, forms, popups, fetch and CDN imports work, but localStorage, sessionStorage, IndexedDB and cookies don't. External resources (CDNs, images, APIs) load normally.`;

function text(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** Runs a tool body, turning page errors into tool errors the agent can read. */
async function run(body: () => Promise<unknown>) {
	try {
		return text(await body());
	} catch (error) {
		if (error instanceof PageError) return { content: [{ type: "text" as const, text: error.message }], isError: true };
		throw error;
	}
}

function server(pages: Pages, host: string, ctx: ExecutionContext): McpServer {
	const mcp = new McpServer({ name: "ephemera", version: "1.0.0" });

	mcp.registerTool(
		"publish_page",
		{
			description: PUBLISH_GUIDE,
			inputSchema: z.object({
				files,
				ttl,
				label: z.string().optional().describe("A short human-readable name for the page, shown in the dashboard and list_pages"),
				agent: z.string().optional().describe('Which agent is publishing, e.g. "claude-code" or "codex"'),
			}),
		},
		(input) => run(() => publishPage(pages, host, { ...input, files: decodeInlineFiles(input.files) })),
	);

	mcp.registerTool(
		"update_page",
		{
			description: "Replace all the files of a live page. The URL and expiry stay the same, so an open tab just needs a refresh.",
			inputSchema: z.object({ id, files }),
		},
		(input) => run(() => updatePage(pages, host, input.id, decodeInlineFiles(input.files), ctx)),
	);

	mcp.registerTool(
		"extend_page",
		{
			description:
				'Give a page more time. A duration adds to its current expiry (at most 30 days from now). "permanent" stops it expiring: only do that when the user asks. A duration on a permanent page makes it temporary again, expiring that long from now.',
			inputSchema: z.object({ id, ttl: z.union([z.string(), z.number()]).describe('A duration like "2h" or "7d", or "permanent"') }),
		},
		(input) => run(async () => pageView(await pages.extend(input.id, parseTtl(input.ttl)), host)),
	);

	mcp.registerTool(
		"delete_page",
		{
			description: "Delete a page now. Its URL immediately starts answering 410 Gone.",
			inputSchema: z.object({ id }),
			annotations: { destructiveHint: true },
		},
		(input) =>
			run(async () => {
				await pages.delete(input.id);
				return { id: input.id, deleted: true };
			}),
	);

	mcp.registerTool(
		"list_pages",
		{
			description: "List live pages (soonest to expire first) with their URLs, labels and expiry times, plus storage usage.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		() => run(() => listPages(pages, host)),
	);

	return mcp;
}

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext, pages: Pages): Promise<Response> {
	const handler = createMcpHandler(() => server(pages, env.PAGES_HOST, ctx), {
		route: "/mcp",
		allowedHostnames: [env.PAGES_HOST],
		corsOptions: false,
		responseMode: "json",
	});
	return handler(request, env, ctx);
}
