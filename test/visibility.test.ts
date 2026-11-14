import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { csrfToken } from "../src/auth.ts";
import { ADMIN, PAGES, TOKEN, api, call, publish } from "./helpers.ts";

afterEach(() => reset());

const PASSWORD = "correct horse";

function post(path: string, body: unknown): Promise<Response> {
	return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function setVisibility(id: string, body: Record<string, unknown>): Promise<{ visibility: string; hasPassword: boolean }> {
	const response = await post(`/pages/${id}/visibility`, body);
	expect(response.status, JSON.stringify(body)).toBe(200);
	return response.json();
}

async function shareUrl(id: string): Promise<string> {
	return ((await (await post(`/pages/${id}/share`, { ttl: "1h" })).json()) as { url: string }).url;
}

/** Whether the password still opens the page. */
async function unlocks(id: string): Promise<boolean> {
	const response = await call(`${PAGES}/${id}/_unlock`, { method: "POST", body: new URLSearchParams({ password: PASSWORD, next: "" }) });
	return response.status === 303;
}

describe("set_visibility", () => {
	it("keeps the password when none is given, so revoking links doesn't lose it", async () => {
		const page = await publish({ visibility: "private", password: PASSWORD });
		const link = await shareUrl(page.id);
		expect((await call(link)).status).toBe(200);

		expect(await setVisibility(page.id, { visibility: "private" })).toMatchObject({ visibility: "private", hasPassword: true });
		expect((await call(link)).status).toBe(401);
		expect(await unlocks(page.id)).toBe(true);
	});

	it('clears the password with null or ""', async () => {
		for (const password of [null, ""]) {
			const page = await publish({ visibility: "private", password: PASSWORD });
			expect(await setVisibility(page.id, { visibility: "private", password })).toMatchObject({ visibility: "private", hasPassword: false });
			expect(await unlocks(page.id)).toBe(false);
		}
	});

	it("replaces the password with a new one", async () => {
		const page = await publish({ visibility: "private", password: "an old password" });
		expect(await setVisibility(page.id, { visibility: "private", password: PASSWORD })).toMatchObject({ hasPassword: true });
		expect(await unlocks(page.id)).toBe(true);
	});

	it("drops the password when the page is made public, as before", async () => {
		const page = await publish({ visibility: "private", password: PASSWORD });
		expect(await setVisibility(page.id, { visibility: "public" })).toMatchObject({ visibility: "public", hasPassword: false });
		expect(await setVisibility(page.id, { visibility: "private" })).toMatchObject({ visibility: "private", hasPassword: false });
		expect((await post(`/pages/${page.id}/visibility`, { visibility: "public", password: PASSWORD })).status).toBe(400);
	});

	it("keeps the password over MCP when it's left out", async () => {
		const page = await publish({ visibility: "private", password: PASSWORD });
		const response = await call(`${PAGES}/mcp`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-protocol-version": "2025-06-18",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "set_visibility", arguments: { id: page.id, visibility: "private" } } }),
		});
		const { result } = mcpResult(await response.text()) as { result: { content: { text: string }[] } };
		expect(JSON.parse(result.content[0]!.text)).toMatchObject({ visibility: "private", hasPassword: true });
		expect(await unlocks(page.id)).toBe(true);
	});

	it("keeps it from the dashboard too, and its remove button still clears it", async () => {
		const page = await publish({ visibility: "private", password: PASSWORD });
		const csrf = await csrfToken(env.EPHEMERA_TOKEN, "owner@example.com");
		const action = (name: string) =>
			call(`${ADMIN}/pages/${page.id}/${name}`, { method: "POST", headers: { origin: ADMIN }, body: new URLSearchParams({ csrf }) }, { accessAud: "test-aud" });
		expect((await action("private")).status).toBe(303);
		expect(await unlocks(page.id)).toBe(true);
		expect((await action("password")).status).toBe(303);
		expect(await unlocks(page.id)).toBe(false);
	});
});

/** The JSON-RPC message in an MCP response, which may come as an event stream. */
function mcpResult(text: string): unknown {
	return JSON.parse(text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data:"))!.slice(5));
}
