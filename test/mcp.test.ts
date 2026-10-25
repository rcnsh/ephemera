import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { PAGES, TOKEN, call } from "./helpers.ts";

afterEach(() => reset());

let nextId = 1;

async function rpc(method: string, params: Record<string, unknown> = {}, token = TOKEN): Promise<Response> {
	return call(`${PAGES}/mcp`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
	});
}

/** Calls a tool and returns its parsed JSON text result (or the error text). */
async function tool(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; data: any }> {
	const response = await rpc("tools/call", { name, arguments: args });
	expect(response.status).toBe(200);
	const text = await response.text();
	const json = text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((line) => line.startsWith("data:"))!.slice(5));
	const result = json.result;
	const body = result.content[0].text as string;
	return { isError: result.isError, data: result.isError ? body : JSON.parse(body) };
}

describe("MCP endpoint", () => {
	it("rejects requests without the token", async () => {
		expect((await rpc("tools/list", {}, "wrong")).status).toBe(401);
	});

	it("lists the tools", async () => {
		const response = await rpc("tools/list");
		const text = await response.text();
		for (const name of ["publish_page", "update_page", "extend_page", "delete_page", "list_pages", "list_versions", "rollback_page", "patch_page", "upload_url", "set_visibility", "share_link", "publish_mockup", "set_verdict"]) {
			expect(text).toContain(name);
		}
	});

	it("publishes, updates, extends, lists and deletes a page", async () => {
		const published = await tool("publish_page", {
			files: [{ path: "index.html", content: "<p>from mcp</p>" }],
			ttl: "1h",
			label: "mcp test",
			agent: "vitest",
		});
		expect(published.isError).toBeFalsy();
		const id = published.data.id as string;
		expect(published.data.url).toBe(`${PAGES}/${id}/`);
		expect(await (await call(published.data.url)).text()).toBe("<p>from mcp</p>");

		const updated = await tool("update_page", { id, files: [{ path: "index.html", content: "PHA+djI8L3A+", encoding: "base64" }] });
		expect(updated.data.expiresAt).toBe(published.data.expiresAt);
		expect(await (await call(published.data.url)).text()).toBe("<p>v2</p>");

		const versions = await tool("list_versions", { id });
		expect(versions.data.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
		const rolledBack = await tool("rollback_page", { id, version: 1 });
		expect(rolledBack.data.version).toBe(1);
		expect(await (await call(published.data.url)).text()).toBe("<p>from mcp</p>");

		const extended = await tool("extend_page", { id, ttl: "permanent" });
		expect(extended.data.permanent).toBe(true);

		const listed = await tool("list_pages", {});
		expect(listed.data.pages.map((p: { id: string }) => p.id)).toContain(id);

		const deleted = await tool("delete_page", { id });
		expect(deleted.isError).toBeFalsy();
		expect((await call(published.data.url)).status).toBe(410);
	});

	it("publishes markdown, patches a file and hands out an upload URL", async () => {
		const published = await tool("publish_page", { markdown: "# Hello" });
		expect(await (await call(published.data.url)).text()).toContain("<h1>Hello</h1>");

		const patched = await tool("patch_page", { id: published.data.id, files: [{ path: "extra.txt", content: "more" }] });
		expect(patched.data.fileCount).toBe(2);
		expect(await (await call(`${published.data.url}extra.txt`)).text()).toBe("more");

		const upload = await tool("upload_url", { label: "big site" });
		expect(upload.data.uploadUrl).toContain(`/upload/${upload.data.id}.`);
		expect(upload.data.label).toBe("big site");
	});

	it("makes a page private and shares it", async () => {
		const published = await tool("publish_page", { html: "<p>secret</p>", visibility: "private" });
		expect((await call(published.data.url)).status).toBe(401);
		const link = await tool("share_link", { id: published.data.id, ttl: "1h" });
		expect(await (await call(link.data.url)).text()).toBe("<p>secret</p>");
		const made = await tool("set_visibility", { id: published.data.id, visibility: "public" });
		expect(made.data.visibility).toBe("public");
		expect((await call(published.data.url)).status).toBe(200);
	});

	it("returns page errors as tool errors", async () => {
		const result = await tool("publish_page", { files: [{ path: "nope.html", content: "x" }] });
		expect(result.isError).toBe(true);
		expect(result.data).toMatch(/index\.html/);
		const both = await tool("publish_page", { html: "x", markdown: "y" });
		expect(both.isError).toBe(true);
		expect(both.data).toMatch(/exactly one/);
	});
});

const TWO_OPTIONS = [
	{ path: "a/index.html", content: "<p>option a</p>" },
	{ path: "b/index.html", content: "<p>option b</p>" },
];

describe("mockup MCP tools", () => {
	it("publishes a set, records verdicts, and works with the page tools", async () => {
		const published = await tool("publish_mockup", { project: "cs-skins", name: "Inventory grid", files: TWO_OPTIONS });
		expect(published.isError).toBeFalsy();
		const id = published.data.id as string;
		expect(id).toMatch(/^cs-skins-inventory-grid-[a-z2-7]{6}$/);
		expect(published.data).toMatchObject({ url: `${PAGES}/${id}/`, kind: "mockup", project: "cs-skins", permanent: true, visibility: "public" });

		const picked = await tool("set_verdict", { id, option: "b", verdict: "picked", note: "cleaner" });
		expect(picked.data.options.find((o: { name: string }) => o.name === "b")).toMatchObject({ verdict: "picked", note: "cleaner" });
		expect((await tool("set_verdict", { id, option: "zz", verdict: "picked" })).isError).toBe(true);

		const patched = await tool("patch_page", { id, files: [{ path: "c/index.html", content: "c" }], remove: ["a/"] });
		expect(patched.data.options.map((o: { name: string }) => o.name)).toEqual(["b", "c"]);

		const listed = await tool("list_pages", {});
		expect(listed.data.pages.find((p: { id: string }) => p.id === id).options).toHaveLength(2);
		expect(listed.data.usage.mockups).toBe(1);

		expect((await tool("set_visibility", { id, visibility: "private" })).data.visibility).toBe("private");
		expect((await tool("list_versions", { id })).data.versions).toHaveLength(2);
		expect((await tool("delete_page", { id })).isError).toBeFalsy();
		expect((await call(`${PAGES}/${id}/`)).status).toBe(410);
	});

	it("returns errors for bad bundles", async () => {
		const result = await tool("publish_mockup", { project: "p", name: "n", files: [{ path: "deep/er/index.html", content: "x" }] });
		expect(result.isError).toBe(true);
		expect(result.data).toMatch(/top-level folder/);
	});
});
