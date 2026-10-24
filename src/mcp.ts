import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { bytesText, durationText, LIMITS, PageError } from "./domain.ts";
import { bundleFrom, decodeInlineFiles } from "./files.ts";
import type { Operations } from "./operations.ts";

const fileList = z.array(
	z.object({
		path: z.string().describe('Path inside the page, e.g. "index.html", "css/app.css", "img/chart.png"'),
		content: z.string().describe("File contents: plain text, or base64 when encoding is \"base64\""),
		encoding: z.enum(["utf8", "base64"]).optional().describe('Use "base64" for binary files such as images; defaults to "utf8"'),
	}),
);

/** A page's content: exactly one of these. */
const content = {
	files: fileList
		.min(1)
		.optional()
		.describe(`The page's files. There must be an index.html at the root. At most ${LIMITS.pageFiles} files and ${bytesText(LIMITS.pageBytes)}.`),
	html: z.string().optional().describe("Instead of files: a single HTML document, served as index.html"),
	markdown: z.string().optional().describe("Instead of files: a Markdown document, rendered to a styled index.html"),
};

const ttl = z
	.union([z.string(), z.number()])
	.optional()
	.describe(`How long the page lives: a duration like "30m", "2h", "7d" (${durationText(LIMITS.minTtl)} to ${durationText(LIMITS.maxTtl)}) or a number of seconds. Defaults to ${durationText(LIMITS.defaultTtl)}. "permanent" keeps it until deleted: only use that when the user asks for it.`);

const id = z.string().describe("The page id: the 12 characters in its URL, https://p.rcn.sh/<id>/");

const label = z.string().optional().describe("A short human-readable name for the page, shown in the dashboard and list_pages");

const visibility = z
	.enum(["public", "private"])
	.optional()
	.describe('"public" (the default): anyone with the URL can open it. "private": the owner signs in to open it, or uses the password if it has one; share_link makes links for others.');

const password = z
	.string()
	.optional()
	.describe("Lets people open a private page with this password (8+ characters). Implies private. Only set one when the user asks, and tell them what it is.");

const agent = z.string().optional().describe('Which agent is publishing, e.g. "claude-code" or "codex"');

const PUBLISH_GUIDE = `Publish a temporary web page at https://p.rcn.sh/<id>/ and get its URL back. It's deleted automatically when its ttl runs out (${durationText(LIMITS.defaultTtl)} by default).

Write links between the page's own files as relative paths ("style.css", "img/a.png", "./data.json"), not root-relative ones ("/style.css"): every page lives under its own /<id>/ folder. Root-relative links in HTML attributes are fixed automatically, but ones inside CSS or JavaScript aren't; the response lists any it found as warnings.

Give the content as exactly one of: files, html (one HTML document) or markdown (rendered for you). For a folder already on disk, or large or binary files, use upload_url instead: it gives the URL straight away and takes a zip from curl, so the files don't pass through this call.

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

function server(ops: Operations): McpServer {
	const mcp = new McpServer({ name: "ephemera", version: "1.0.0" });

	mcp.registerTool(
		"publish_page",
		{
			description: PUBLISH_GUIDE,
			inputSchema: z.object({ ...content, ttl, label, agent, visibility, password }),
		},
		(input) => run(async () => ops.publish({ ...input, files: bundleFrom(input, input.label) })),
	);

	mcp.registerTool(
		"update_page",
		{
			description: `Replace all the files of a live page. The URL and expiry stay the same, so an open tab just needs a refresh. The previous files are kept as a version (the last ${LIMITS.keptVersions}) that rollback_page can bring back.`,
			inputSchema: z.object({ id, ...content }),
		},
		(input) => run(async () => ops.update(input.id, bundleFrom(input))),
	);

	mcp.registerTool(
		"patch_page",
		{
			description:
				"Change some files of a live page and keep the rest: files are added or replaced, remove deletes paths. Cheaper than update_page when only a few files change. Adds a version like update_page does.",
			inputSchema: z.object({
				id,
				files: fileList.optional().describe("Files to add or replace"),
				remove: z.array(z.string()).optional().describe('Paths to delete, e.g. ["old.css"]'),
			}),
		},
		(input) => run(async () => ops.patch(input.id, decodeInlineFiles(input.files ?? []), input.remove ?? [])),
	);

	mcp.registerTool(
		"upload_url",
		{
			description: `Get a URL that takes a zip of a page's files from curl, for folders on disk and files too big or binary to send inline. Without id, publishes a placeholder page and returns its final URL too; with id, the upload replaces that page's files. The URL works for an hour, and each upload adds a version. Run the returned command with <folder> replaced; index.html must be at the folder's root.`,
			inputSchema: z.object({
				id: id.optional().describe("An existing page to upload new files for; omit to start a new page"),
				ttl,
				label,
				agent,
				visibility,
				password,
			}),
		},
		(input) => run(() => ops.uploadUrl(input)),
	);

	mcp.registerTool(
		"extend_page",
		{
			description:
				`Give a page more time. A duration adds to its current expiry (at most ${durationText(LIMITS.maxTtl)} from now). "permanent" stops it expiring: only do that when the user asks. A duration on a permanent page makes it temporary again, expiring that long from now.`,
			inputSchema: z.object({ id, ttl: z.union([z.string(), z.number()]).describe('A duration like "2h" or "7d", or "permanent"') }),
		},
		(input) => run(() => ops.extend(input.id, input.ttl)),
	);

	mcp.registerTool(
		"delete_page",
		{
			description: "Delete a page now. Its URL immediately starts answering 410 Gone.",
			inputSchema: z.object({ id }),
			annotations: { destructiveHint: true },
		},
		(input) => run(() => ops.delete(input.id)),
	);

	mcp.registerTool(
		"set_visibility",
		{
			description: "Make a page public or private, and set or clear its password. Either way, every share link handed out so far stops working.",
			inputSchema: z.object({ id, visibility: z.enum(["public", "private"]), password: password.describe("A password for a private page (8+ characters); omit for none") }),
		},
		(input) => run(() => ops.setVisibility(input.id, input.visibility, input.password)),
	);

	mcp.registerTool(
		"share_link",
		{
			description: "A link that opens a private page without signing in or a password, until it expires. For a public page it's just the URL. set_visibility revokes these.",
			inputSchema: z.object({ id, ttl: z.union([z.string(), z.number()]).optional().describe('How long the link works: "2h", "7d" (up to 30 days); defaults to a day') }),
		},
		(input) => run(() => ops.shareLink(input.id, input.ttl)),
	);

	mcp.registerTool(
		"list_versions",
		{
			description: `List the versions a page keeps (the last ${LIMITS.keptVersions}, newest first), and which one it's serving.`,
			inputSchema: z.object({ id }),
			annotations: { readOnlyHint: true },
		},
		(input) => run(() => ops.versions(input.id)),
	);

	mcp.registerTool(
		"rollback_page",
		{
			description: "Serve one of a page's kept versions again, e.g. to undo an update. The URL and expiry stay the same; a later update_page still adds a new version on top.",
			inputSchema: z.object({ id, version: z.number().int().describe("A version number from list_versions") }),
		},
		(input) => run(() => ops.rollback(input.id, input.version)),
	);

	mcp.registerTool(
		"list_pages",
		{
			description: "List live pages (soonest to expire first) with their URLs, labels and expiry times, plus storage usage.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		() => run(() => ops.list()),
	);

	return mcp;
}

/** The MCP server at /mcp. The caller has already checked the token. */
export function handleMcp(request: Request, env: Env, ctx: ExecutionContext, ops: Operations): Promise<Response> {
	const handler = createMcpHandler(() => server(ops), {
		route: "/mcp",
		allowedHostnames: [env.PAGES_HOST],
		corsOptions: false,
		responseMode: "json",
	});
	return handler(request, env, ctx);
}
