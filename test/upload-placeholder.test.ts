import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, call, publish, zip } from "./helpers.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	await reset();
});

interface Upload {
	id: string;
	url: string;
	uploadUrl: string;
	uploadExpiresAt: number;
	expiresAt: number | null;
	permanent: boolean;
}

const HOUR = 3_600_000;

async function startUpload(body: Record<string, unknown>): Promise<Upload> {
	const response = await api("/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	expect(response.status).toBe(201);
	return response.json();
}

function upload(url: string, files: Record<string, string>): Promise<Response> {
	return call(url, { method: "PUT", headers: { "content-type": "application/zip" }, body: zip(files) });
}

describe("upload_url's placeholder page", () => {
	it("expires with the upload URL if nothing is uploaded", async () => {
		const created = await startUpload({});
		expect(created).toMatchObject({ permanent: false, expiresAt: created.uploadExpiresAt });
		vi.spyOn(Date, "now").mockReturnValue(created.uploadExpiresAt + 1);
		expect((await call(created.url)).status).toBe(410);
	});

	it("becomes permanent when the first upload lands, if no ttl was asked for", async () => {
		const created = await startUpload({ ttl: "permanent" });
		const response = await upload(created.uploadUrl, { "index.html": "<h1>up</h1>" });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ permanent: true, expiresAt: null });
		vi.spyOn(Date, "now").mockReturnValue(created.uploadExpiresAt + 365 * 24 * HOUR);
		expect(await (await call(created.url)).text()).toBe("<h1>up</h1>");
	});

	it("gets the ttl asked for, counted from the first upload", async () => {
		const created = await startUpload({ ttl: "2d" });
		const start = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(start + 30 * 60_000);
		const first = (await (await upload(created.uploadUrl, { "index.html": "one" })).json()) as Upload;
		expect(first).toMatchObject({ permanent: false, expiresAt: start + 30 * 60_000 + 48 * HOUR });

		// Later uploads leave the expiry alone.
		vi.spyOn(Date, "now").mockReturnValue(start + 40 * 60_000);
		const second = (await (await upload(created.uploadUrl, { "index.html": "two" })).json()) as Upload;
		expect(second.expiresAt).toBe(first.expiresAt);
	});

	it("checks the ttl before publishing anything", async () => {
		const response = await api("/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ttl: "1y" }) });
		expect(response.status).toBe(400);
		expect(((await (await api("/pages")).json()) as { pages: unknown[] }).pages).toEqual([]);
	});

	it("leaves an existing page's expiry alone", async () => {
		const page = await publish({ ttl: "1h" });
		const created = await startUpload({ id: page.id, ttl: "permanent" });
		expect((await (await upload(created.uploadUrl, { "index.html": "new" })).json()) as Upload).toMatchObject({ expiresAt: page.expiresAt });
	});
});
