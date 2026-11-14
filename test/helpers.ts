import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { zipSync, strToU8 } from "fflate";
import worker from "../src/index.ts";

export const PAGES = "https://pages.example.com";
export const ADMIN = "https://admin.example.com";
export const TOKEN = "test-token";

interface CallOptions {
	/** Simulate a request that Cloudflare Access let through, with this audience tag. */
	accessAud?: string;
	/** Bindings to use instead of the test ones. */
	env?: Partial<typeof env>;
}

/** Sends a request straight to the Worker and waits for its background work. */
export async function call(input: string | Request, init?: RequestInit, options: CallOptions = {}): Promise<Response> {
	const request = input instanceof Request ? input : new Request(input, { redirect: "manual", ...init });
	// Real requests always carry a Host header; constructed ones don't.
	if (!request.headers.has("host")) request.headers.set("host", new URL(request.url).host);
	const ctx = createExecutionContext();
	if (options.accessAud) {
		Object.defineProperty(ctx, "access", {
			value: { aud: options.accessAud, getIdentity: async () => ({ email: "owner@example.com" }) },
		});
	}
	const response = await worker.fetch(request as Parameters<typeof worker.fetch>[0], { ...env, ...options.env }, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

export function api(path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	if (!headers.has("authorization")) headers.set("authorization", `Bearer ${TOKEN}`);
	return call(`${PAGES}/api${path}`, { ...init, headers });
}

export interface PublishBody {
	files?: { path: string; content: string; encoding?: "utf8" | "base64" }[];
	ttl?: string | number;
	label?: string;
	agent?: string;
	visibility?: "public" | "private";
	password?: string;
}

export const HELLO = [{ path: "index.html", content: "<!doctype html><h1>hello</h1>" }];

export interface PublishedPage {
	id: string;
	url: string;
	/** ISO 8601. */
	expiresAt: string | null;
	permanent: boolean;
	warnings: string[];
	[key: string]: unknown;
}

export async function publish(body: PublishBody = {}): Promise<PublishedPage> {
	const response = await api("/pages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ files: HELLO, ...body }),
	});
	if (response.status !== 201) throw new Error(`publish failed: ${response.status} ${await response.text()}`);
	return response.json();
}

export function zip(files: Record<string, string>): Uint8Array {
	return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}

export async function objectCount(id: string): Promise<number> {
	return (await env.BUCKET.list({ prefix: `pages/${id}/` })).objects.length;
}

let nextRpcId = 1;

/** A JSON-RPC call to the MCP server; the result, or the error. */
export async function mcp(method: string, params: Record<string, unknown> = {}): Promise<any> {
	const response = await call(`${PAGES}/mcp`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${TOKEN}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
	});
	const text = await response.text();
	const json = text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((line) => line.startsWith("data:"))!.slice(5));
	return json.result ?? json.error;
}

/** Calls a tool: its JSON result, or its error text with `isError`. `raw` is the text as the agent sees it. */
export async function mcpTool(name: string, args: Record<string, unknown> = {}): Promise<{ isError?: boolean; data: any; raw: string }> {
	const result = await mcp("tools/call", { name, arguments: args });
	const raw = result.content[0].text as string;
	return { isError: result.isError, data: result.isError ? raw : JSON.parse(raw), raw };
}
