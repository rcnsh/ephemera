import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { HELLO, PAGES, TOKEN, api, call, publish } from "./helpers.ts";

afterEach(() => reset());

function send(method: string, path: string, body: unknown): Promise<Response> {
	return api(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("fields of the wrong type", () => {
	// [method, path ("<id>" is a live page), body, a word the error must contain]
	const cases: [string, string, Record<string, unknown>, string][] = [
		["POST", "/pages", { files: HELLO, label: 123 }, "label"],
		["POST", "/pages", { files: HELLO, label: ["a"] }, "label"],
		["POST", "/pages", { files: HELLO, agent: {} }, "agent"],
		["POST", "/pages", { files: HELLO, agent: 7 }, "agent"],
		["POST", "/pages", { files: HELLO, ttl: {} }, "ttl"],
		["POST", "/pages", { files: HELLO, ttl: true }, "ttl"],
		["POST", "/pages", { files: HELLO, ttl: [1] }, "ttl"],
		["POST", "/pages", { files: HELLO, visibility: 5 }, "visibility"],
		["POST", "/pages", { files: HELLO, password: 5 }, "password"],
		["POST", "/uploads", { label: 5 }, "label"],
		["POST", "/uploads", { agent: [] }, "agent"],
		["POST", "/uploads", { ttl: true }, "ttl"],
		["POST", "/uploads", { id: 5 }, "id"],
		["PATCH", "/pages/<id>", { ttl: {} }, "ttl"],
		["PATCH", "/pages/<id>", { ttl: true, label: "x" }, "ttl"],
		["PATCH", "/pages/<id>", { label: 5 }, "label"],
		["POST", "/pages/<id>/share", { ttl: {} }, "ttl"],
	];

	it("answer 400 saying which field was wrong, not 500", async () => {
		const page = await publish({ visibility: "private" });
		for (const [method, path, body, field] of cases) {
			const response = await send(method, path.replace("<id>", page.id), body);
			const what = `${method} ${path} ${JSON.stringify(body)}`;
			expect(response.status, what).toBe(400);
			expect(((await response.json()) as { error: string }).error, what).toContain(field);
		}
		// Nothing was renamed or published along the way.
		const listed = (await (await api("/pages")).json()) as { pages: { id: string; label: string | null }[] };
		expect(listed.pages.map((p) => [p.id, p.label])).toEqual([[page.id, null]]);
	});
});

describe("file encodings", () => {
	it("refuse one that isn't utf8 or base64, naming the ones accepted", async () => {
		for (const encoding of ["b64", "hex", 5]) {
			const response = await send("POST", "/pages", { files: [...HELLO, { path: "a.png", content: "iVBORw0KGgo=", encoding }] });
			expect(response.status, String(encoding)).toBe(400);
			const { error } = (await response.json()) as { error: string };
			expect(error).toContain('"utf8"');
			expect(error).toContain('"base64"');
		}
	});

	it("take utf8, base64 or none at all", async () => {
		const page = await publish({
			files: [
				{ path: "index.html", content: "hi", encoding: "utf8" },
				{ path: "a.txt", content: "aGk=", encoding: "base64" },
				{ path: "b.txt", content: "plain" },
			],
		});
		expect(await (await call(`${page.url}a.txt`)).text()).toBe("hi");
		expect(await (await call(`${page.url}b.txt`)).text()).toBe("plain");
	});
});

async function versionCount(id: string): Promise<number> {
	return ((await (await api(`/pages/${id}/versions`)).json()) as { versions: unknown[] }).versions.length;
}

describe("patches", () => {
	it("refuse one with nothing to change, and add no version", async () => {
		const page = await publish();
		for (const body of [{}, { files: [] }, { remove: [] }, { files: null, remove: [] }]) {
			const response = await send("POST", `/pages/${page.id}/files`, body);
			expect(response.status, JSON.stringify(body)).toBe(400);
			expect(((await response.json()) as { error: string }).error).toMatch(/nothing to change/i);
		}
		expect(await versionCount(page.id)).toBe(1);
	});

	it("refuse it over MCP too", async () => {
		const page = await publish();
		const response = await call(`${PAGES}/mcp`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2025-06-18",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "patch_page", arguments: { id: page.id } } }),
		});
		const { result } = mcpResult(await response.text()) as { result: { isError?: boolean; content: { text: string }[] } };
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toMatch(/nothing to change/i);
		expect(await versionCount(page.id)).toBe(1);
	});
});

/** The JSON-RPC message in an MCP response, which may come as an event stream. */
function mcpResult(text: string): unknown {
	return JSON.parse(text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data:"))!.slice(5));
}
