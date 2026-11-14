import { reset } from "cloudflare:test";
import { unzipSync, strFromU8 } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGES, api, call, mcp, mcpTool, publish, zip } from "./helpers.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	await reset();
});

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function send(path: string, body: unknown, method = "POST"): Promise<Response> {
	return api(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function getJson(path: string): Promise<any> {
	const response = await api(path);
	return { status: response.status, body: await response.json() };
}

/** Moves the clock on, so pages published one after another get distinct updated times. */
function tick(): void {
	const now = Date.now() + 1000;
	vi.spyOn(Date, "now").mockReturnValue(now);
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
const PNG_BASE64 = btoa(String.fromCharCode(...PNG));

describe("get_page", () => {
	it("returns the page with its files and ISO times, the same over MCP and HTTP", async () => {
		const published = await mcpTool("publish_page", {
			files: [
				{ path: "index.html", content: "<h1>hi</h1>" },
				{ path: "css/app.css", content: "body{}" },
			],
			ttl: "1h",
			label: "report",
		});
		const id = published.data.id;
		expect(published.data.createdAt).toMatch(ISO);
		expect(published.data.expiresAt).toMatch(ISO);

		const got = await mcpTool("get_page", { id });
		expect(got.data).toMatchObject({ id, label: "report", version: 1, kind: "page" });
		expect(got.data.files).toEqual([
			{ path: "css/app.css", size: 6 },
			{ path: "index.html", size: 11 },
		]);
		expect((await getJson(`/pages/${id}`)).body).toEqual(got.data);
	});

	it("includes a mockup set's options with verdicts and notes", async () => {
		const set = await mcpTool("publish_mockup", { project: "app", name: "grid", files: [{ path: "a/index.html", content: "a" }, { path: "b/index.html", content: "b" }] });
		await mcpTool("set_verdict", { id: set.data.id, option: "a", verdict: "picked", note: "cleaner" });
		const got = await mcpTool("get_page", { id: set.data.id });
		expect(got.data.options).toEqual([
			{ name: "a", path: "a/", verdict: "picked", note: "cleaner", updatedAt: expect.stringMatching(ISO) },
			{ name: "b", path: "b/", verdict: "pending", note: null, updatedAt: expect.stringMatching(ISO) },
		]);
	});

	it("points a missing id at list_pages", async () => {
		const result = await mcpTool("get_page", { id: "aaaaaaaaaaaa" });
		expect(result.isError).toBe(true);
		expect(result.data).toMatch(/list_pages/);
		expect((await api("/pages/aaaaaaaaaaaa")).status).toBe(404);
	});
});

describe("read_file", () => {
	it("reads text as text and binary as base64, from any kept version", async () => {
		const page = await publish({
			files: [
				{ path: "index.html", content: "<p>v1 ✓</p>" },
				{ path: "img/dot.png", content: PNG_BASE64, encoding: "base64" },
			],
		});
		await send(`/pages/${page.id}/files`, { files: [{ path: "index.html", content: "<p>v2</p>" }] });

		const text = await mcpTool("read_file", { id: page.id, path: "index.html" });
		expect(text.data).toEqual({ id: page.id, version: 2, path: "index.html", size: 9, contentType: "text/html; charset=utf-8", encoding: "utf8", content: "<p>v2</p>" });
		const old = await mcpTool("read_file", { id: page.id, path: "index.html", version: 1 });
		expect(old.data.content).toBe("<p>v1 ✓</p>");
		const image = await mcpTool("read_file", { id: page.id, path: "./img/dot.png" });
		expect(image.data).toMatchObject({ path: "img/dot.png", encoding: "base64", content: PNG_BASE64, size: PNG.length });

		const http = await getJson(`/pages/${page.id}/files?path=index.html&version=1`);
		expect(http.body).toEqual(old.data);
	});

	it("explains what to do for a missing file, an unkept version or a file too big to return", async () => {
		const page = await publish({ files: [{ path: "index.html", content: "x" }, { path: "big.txt", content: "a".repeat(300 * 1024) }] });

		const missing = await mcpTool("read_file", { id: page.id, path: "nope.css" });
		expect(missing.isError).toBe(true);
		expect(missing.data).toMatch(/"big.txt", "index.html"/);

		const version = await mcpTool("read_file", { id: page.id, path: "index.html", version: 7 });
		expect(version.data).toMatch(/no version 7; it keeps 1/);

		const big = await mcpTool("read_file", { id: page.id, path: "big.txt" });
		expect(big.data).toMatch(/300 KB, more than the 256 KB/);
		expect(big.data).toContain(`/api/pages/${page.id}/zip?version=1`);

		expect((await api(`/pages/${page.id}/files?path=big.txt`)).status).toBe(413);
		expect((await api(`/pages/${page.id}/files`)).status).toBe(400);
		expect((await api(`/pages/${page.id}/files?path=index.html&version=x`)).status).toBe(400);
	});
});

describe("list_pages", () => {
	async function seed() {
		const ids: Record<string, string> = {};
		for (const [label, agent] of [
			["Q3 report", "claude-code"],
			["Q4 report", "codex"],
			["scratch", "claude-code"],
		] as const) {
			tick();
			ids[label] = (await publish({ label, agent })).id;
		}
		tick();
		const set = await mcpTool("publish_mockup", { project: "My App", name: "grid", agent: "claude-code", files: [{ path: "a/index.html", content: "a" }, { path: "b/index.html", content: "b" }] });
		ids.grid = set.data.id;
		await mcpTool("set_verdict", { id: ids.grid, option: "b", verdict: "rejected" });
		return ids;
	}

	it("returns compact rows, newest-updated first, with verdict counts for mockup sets", async () => {
		const ids = await seed();
		const listed = await mcpTool("list_pages");
		expect(listed.data.pages.map((p: { id: string }) => p.id)).toEqual([ids.grid, ids.scratch, ids["Q4 report"], ids["Q3 report"]]);
		expect(listed.data.pages[0]).toEqual({
			id: ids.grid,
			url: `${PAGES}/${ids.grid}/`,
			label: "grid",
			kind: "mockup",
			updatedAt: expect.stringMatching(ISO),
			expiresAt: null,
			verdicts: { pending: 1, picked: 0, rejected: 1 },
		});
		expect(Object.keys(listed.data.pages[1])).toEqual(["id", "url", "label", "kind", "updatedAt", "expiresAt"]);
		expect(listed.data.nextCursor).toBeNull();
		expect(listed.data.usage).toMatchObject({ permanentPages: 3, mockups: 1 });
		// Compact JSON: no indentation.
		expect(listed.raw).not.toContain("\n");
	});

	it("filters by query, agent, kind and project, the same over MCP and HTTP", async () => {
		const ids = await seed();
		const ids_ = async (args: Record<string, unknown>) => (await mcpTool("list_pages", args)).data.pages.map((p: { id: string }) => p.id);
		expect(await ids_({ query: "REPORT" })).toEqual([ids["Q4 report"], ids["Q3 report"]]);
		expect(await ids_({ query: ids.scratch.slice(2, 8) })).toEqual([ids.scratch]);
		expect(await ids_({ query: "%" })).toEqual([]);
		expect(await ids_({ agent: "claude-code", kind: "page" })).toEqual([ids.scratch, ids["Q3 report"]]);
		expect(await ids_({ kind: "mockup" })).toEqual([ids.grid]);
		expect(await ids_({ project: "my app" })).toEqual([ids.grid]);
		expect(await ids_({ project: "other" })).toEqual([]);

		const http = await getJson("/pages?query=report&agent=codex");
		expect(http.body.pages.map((p: { id: string }) => p.id)).toEqual([ids["Q4 report"]]);
	});

	it("pages through with limit and cursor, missing nothing and repeating nothing", async () => {
		const ids = await seed();
		const first = await mcpTool("list_pages", { limit: 3 });
		expect(first.data.pages).toHaveLength(3);
		expect(first.data.nextCursor).toEqual(expect.any(String));
		const second = await mcpTool("list_pages", { limit: 3, cursor: first.data.nextCursor });
		expect(second.data.nextCursor).toBeNull();
		const all = [...first.data.pages, ...second.data.pages].map((p: { id: string }) => p.id);
		expect(all).toEqual([ids.grid, ids.scratch, ids["Q4 report"], ids["Q3 report"]]);

		const http = await getJson(`/pages?limit=3&cursor=${encodeURIComponent(first.data.nextCursor)}`);
		expect(http.body.pages.map((p: { id: string }) => p.id)).toEqual([ids["Q3 report"]]);
	});

	it("explains bad parameters", async () => {
		expect((await mcpTool("list_pages", { cursor: "nonsense" })).data).toMatch(/nextCursor/);
		for (const query of ["cursor=nonsense", "limit=0", "limit=101", "limit=two", "kind=site"]) {
			expect((await api(`/pages?${query}`)).status, query).toBe(400);
		}
	});
});

describe("rename_page", () => {
	it("renames a page or mockup set over MCP, as PATCH does over HTTP", async () => {
		const page = await publish({ label: "old", ttl: "1h" });
		const renamed = await mcpTool("rename_page", { id: page.id, label: "new" });
		expect(renamed.data).toMatchObject({ id: page.id, label: "new", expiresAt: page.expiresAt });
		expect((await mcpTool("rename_page", { id: page.id, label: "" })).data.label).toBeNull();

		const set = await mcpTool("publish_mockup", { project: "p", name: "n", files: [{ path: "a/index.html", content: "a" }] });
		expect((await mcpTool("rename_page", { id: set.data.id, label: "Better name" })).data).toMatchObject({ label: "Better name", options: [expect.objectContaining({ name: "a" })] });

		// Over HTTP, a bad ttl next to a label changes nothing.
		expect((await send(`/pages/${page.id}`, { label: "nope", ttl: "1y" }, "PATCH")).status).toBe(400);
		expect((await getJson(`/pages/${page.id}`)).body.label).toBeNull();
	});
});

describe("tool annotations", () => {
	it("states every hint on every tool", async () => {
		const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
		const write = (destructiveHint: boolean, idempotentHint: boolean) => ({ readOnlyHint: false, destructiveHint, idempotentHint, openWorldHint: false });
		const expected: Record<string, object> = {
			publish_page: write(false, false),
			publish_mockup: write(false, false),
			set_verdict: write(false, true),
			update_page: write(false, false),
			patch_page: write(false, false),
			upload_url: write(false, false),
			extend_page: write(false, false),
			delete_page: write(true, true),
			set_visibility: write(true, false),
			share_link: write(false, false),
			list_versions: read,
			diff_versions: read,
			rollback_page: write(false, true),
			list_pages: read,
			get_page: read,
			read_file: read,
			rename_page: write(false, true),
		};
		const { tools } = await mcp("tools/list");
		expect(Object.fromEntries(tools.map((tool: { name: string; annotations: object }) => [tool.name, tool.annotations]))).toEqual(expected);
	});

	it("tells a model how the tools fit together", async () => {
		const result = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "1" } });
		expect(result.instructions).toMatch(/get_page/);
		expect(result.instructions).toMatch(/read_file/);
	});
});

describe("diff_versions", () => {
	it("lists the paths added, removed and changed between kept versions", async () => {
		const page = await publish({
			files: [
				{ path: "index.html", content: "<h1>v1</h1>" },
				{ path: "app.css", content: "a{}" },
				{ path: "old.js", content: "1" },
			],
		});
		await send(`/pages/${page.id}/files`, { files: [{ path: "app.css", content: "b{}" }, { path: "new.js", content: "2" }], remove: ["old.js"] });
		await send(`/pages/${page.id}/files`, { files: [{ path: "index.html", content: "<h1>v3</h1>" }] });

		const latest = await mcpTool("diff_versions", { id: page.id });
		expect(latest.data).toEqual({ id: page.id, from: 2, to: 3, added: [], removed: [], changed: ["index.html"], unchanged: 2 });
		const first = await mcpTool("diff_versions", { id: page.id, from: 1, to: 2 });
		expect(first.data).toEqual({ id: page.id, from: 1, to: 2, added: ["new.js"], removed: ["old.js"], changed: ["app.css"], unchanged: 1 });

		const http = await getJson(`/pages/${page.id}/diff?from=1&to=2`);
		expect(http.body).toEqual(first.data);
		// Same content written again counts as unchanged.
		await send(`/pages/${page.id}`, { files: [{ path: "index.html", content: "<h1>v3</h1>" }, { path: "app.css", content: "b{}" }, { path: "new.js", content: "2" }] }, "PUT");
		expect((await mcpTool("diff_versions", { id: page.id })).data).toMatchObject({ changed: [], unchanged: 3 });
	});

	it("explains when there's nothing to compare with", async () => {
		const page = await publish();
		const result = await mcpTool("diff_versions", { id: page.id });
		expect(result.isError).toBe(true);
		expect(result.data).toMatch(/no version older than 1/);
		expect((await api(`/pages/${page.id}/diff?from=9`)).status).toBe(404);
	});
});

describe("zip download", () => {
	it("returns a version's files as a zip, behind the token", async () => {
		const page = await publish({
			files: [
				{ path: "index.html", content: "<h1>v1</h1>" },
				{ path: "img/dot.png", content: PNG_BASE64, encoding: "base64" },
			],
		});
		await send(`/pages/${page.id}/files`, { files: [{ path: "index.html", content: "<h1>v2</h1>" }] });

		const response = await api(`/pages/${page.id}/zip`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/zip");
		expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${page.id}-v2.zip"`);
		const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
		expect(Object.keys(files).sort()).toEqual(["img/dot.png", "index.html"]);
		expect(strFromU8(files["index.html"]!)).toBe("<h1>v2</h1>");
		expect(files["img/dot.png"]).toEqual(PNG);

		const old = unzipSync(new Uint8Array(await (await api(`/pages/${page.id}/zip?version=1`)).arrayBuffer()));
		expect(strFromU8(old["index.html"]!)).toBe("<h1>v1</h1>");

		expect((await api(`/pages/${page.id}/zip?version=5`)).status).toBe(404);
		expect((await call(`${PAGES}/api/pages/${page.id}/zip`)).status).toBe(401);
	});
});

describe("slugs", () => {
	it("gives the page an id that says what it is, over MCP and HTTP", async () => {
		const published = await mcpTool("publish_page", { html: "<p>q3</p>", slug: "Q3 Report!" });
		expect(published.data.id).toMatch(/^q3-report-[a-z2-7]{6}$/);
		expect(await (await call(published.data.url)).text()).toBe("<p>q3</p>");

		const http = await publish({ slug: "launch plan" } as never);
		expect(http.id).toMatch(/^launch-plan-[a-z2-7]{6}$/);

		const zipped = await api("/pages?slug=from-zip", { method: "POST", headers: { "content-type": "application/zip" }, body: zip({ "index.html": "z" }) });
		expect(((await zipped.json()) as { id: string }).id).toMatch(/^from-zip-[a-z2-7]{6}$/);

		const bad = await mcpTool("publish_page", { html: "x", slug: "!!!" });
		expect(bad.isError).toBe(true);
		expect(bad.data).toMatch(/letters or digits/);
		expect((await send("/pages", { html: "x", slug: 5 })).status).toBe(400);
	});
});

describe("ergonomics", () => {
	it("suggests a trailing slash when remove names a folder", async () => {
		const page = await publish({ files: [{ path: "index.html", content: "x" }, { path: "b/index.html", content: "b" }] });
		const result = await mcpTool("patch_page", { id: page.id, remove: ["b"] });
		expect(result.isError).toBe(true);
		expect(result.data).toMatch(/give "b\/"/);
	});

	it("records the agent that published a mockup set, over MCP and HTTP", async () => {
		const viaMcp = await mcpTool("publish_mockup", { project: "p", name: "n", agent: "codex", files: [{ path: "a/index.html", content: "a" }] });
		expect(viaMcp.data.agent).toBe("codex");
		const viaHttp = await send("/mockups", { project: "p", name: "m", agent: "claude-code", files: [{ path: "a/index.html", content: "a" }] });
		expect(((await viaHttp.json()) as { agent: string }).agent).toBe("claude-code");
	});

	it("leaves dotfiles out of the upload command's zip, and gives ISO times for uploads, versions and share links", async () => {
		const upload = await mcpTool("upload_url", {});
		expect(upload.data.command).toContain("zip -qr - . -x '.*' '*/.*'");
		expect(upload.data.uploadExpiresAt).toMatch(ISO);
		expect((await mcpTool("list_versions", { id: upload.data.id })).data.versions[0].createdAt).toMatch(ISO);
		expect((await mcpTool("share_link", { id: upload.data.id })).data.expiresAt).toBeNull();
		const secret = await mcpTool("publish_page", { html: "s", visibility: "private" });
		expect((await mcpTool("share_link", { id: secret.data.id })).data.expiresAt).toMatch(ISO);
	});
});
