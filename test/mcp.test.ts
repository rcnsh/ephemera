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

	it("lists the five tools", async () => {
		const response = await rpc("tools/list");
		const text = await response.text();
		for (const name of ["publish_page", "update_page", "extend_page", "delete_page", "list_pages"]) {
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

		const extended = await tool("extend_page", { id, ttl: "permanent" });
		expect(extended.data.permanent).toBe(true);

		const listed = await tool("list_pages", {});
		expect(listed.data.pages.map((p: { id: string }) => p.id)).toContain(id);

		const deleted = await tool("delete_page", { id });
		expect(deleted.isError).toBeFalsy();
		expect((await call(published.data.url)).status).toBe(410);
	});

	it("returns page errors as tool errors", async () => {
		const result = await tool("publish_page", { files: [{ path: "nope.html", content: "x" }] });
		expect(result.isError).toBe(true);
		expect(result.data).toMatch(/index\.html/);
	});
});
